import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * EVENT FIELD PROBE - what does SGO actually put on an event object?
 *
 * WHY THIS EXISTS AND WHY IT IS NOT tkb_debug_raw_event REBORN.
 *
 * v2.0.0 deleted tkb_debug_raw_event and called it a quota footgun, correctly.
 * That tool dumped the event including its odds map, which on a game near first
 * pitch runs past 1,000 markets, and it had to cap the dump at five entries to
 * avoid blowing response limits. It answered "show me everything" and everything
 * was too much.
 *
 * This answers a NARROWER question: WHICH KEYS EXIST, and what shape are they.
 * It never returns the odds map contents, only its size. It never returns a
 * player list, only a count. The response is bounded by construction rather than
 * by a truncation guess.
 *
 * ---- THE SPECIFIC QUESTION IT WAS BUILT TO SETTLE ----
 *
 * src/types.ts carries this comment on SGOEvent:
 *
 *   "NOTE: no `lineups` field exists on the event object - confirmed via live test
 *    against an upcoming game. SGO does not expose probable/confirmed starting
 *    pitchers or lineups pre-game. Starting pitcher info must come from web search."
 *
 * But SGO's own schema browser lists an Event as carrying "basic information,
 * odds, results, team info, and LINEUPS".
 *
 * One of those is out of date and it matters enormously. The confirmed starting
 * pitcher check is currently a MANDATORY live web search per game per date, and
 * it exists because a thread once shipped built around Chris Sale on a night he
 * had been pushed back a day. If `lineups` is real and populated pre-game, that
 * entire manual step collapses into a connector call. If it is absent or empty,
 * the note in types.ts is confirmed and the rule stands as written.
 *
 * EITHER ANSWER IS A RESULT. That is the point of probing rather than assuming.
 *
 * COST: one event fetch, roughly 1 entity, with a trivial oddID filter so the
 * odds map is never serialised. Per SGO's docs the oddID filter shapes only
 * odds, bookmakers and players, so it cannot suppress a lineups field.
 *
 * ---- THE SECOND QUESTION: IS THERE A REAL CLOSING LINE? ----
 *
 * Pass an `oddID` and this switches into closing-line probe mode.
 *
 * v2.8.3 measured a grader reporting a "closing line" of 17.5 on a 16-1 final,
 * because `closeOverUnder` and `closeSpread` are NOT top-level fields on an odd
 * and the chain fell through to `bookOverUnder` - which on a settled event has
 * converged onto the result. v2.8.7 re-measured it on a 62-13 CFB game: a feed
 * total of 76.5 against 75 actual points, and a feed spread of -48.5 against a
 * final margin of 49. Half a point off the result, from the other direction.
 *
 * Both releases refused rather than guessed, and both left the same item open:
 * SGO's docs say the real open/close values live at
 * `odds.<oddID>.byBookmaker.<bookmakerID>.closeOverUnder` and appear only when
 * `includeOpenCloseOdds=true` is requested. v2.8.4 and v2.8.5 each carried that
 * forward untested, because - per v2.8.1's lesson - a fix written from
 * documentation alone is a guess wearing a citation.
 *
 * This mode is the call that settles it, and it settles two things at once:
 *
 *   1. Whether the graders can stop refusing a missing postedLine and start
 *      grading posted-against-closed, as their descriptions have always claimed.
 *   2. Whether `tkb_get_line_movement` can be repaired. It currently resolves
 *      `openOdds` but not `openOverUnder`/`openSpread`, so it reports an opening
 *      PRICE with no opening NUMBER - useless for the totals and spreads it
 *      exists to describe.
 *
 * It reports the real field names rather than testing for the ones the docs
 * predict, so an unexpected name is a finding instead of a silent absence.
 */

const ProbeInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventID: z
      .string()
      .describe(
        "SGO eventID to inspect. For the lineups question, use an UPCOMING game a few hours out - that is when a lineup would be posted if it is posted at all."
      ),
    field: z
      .string()
      .optional()
      .describe(
        "Optional: inspect one top-level field in more detail, e.g. 'lineups'. Output stays capped regardless."
      ),
    oddID: z
      .string()
      .optional()
      .describe(
        "Optional, and switches this tool into CLOSING-LINE PROBE mode. Give one full oddID " +
          "(e.g. 'points-all-game-ou-over') on a FINALIZED event and the fetch adds " +
          "includeOpenCloseOdds=true, then reports the odd's real field names and the field names " +
          "inside every byBookmaker entry. This is the one call that settles whether a genuine " +
          "closing line is reachable - see the CLOSING LINE section in this file's header."
      ),
  })
  .strict();

type ProbeInput = z.infer<typeof ProbeInputSchema>;

/** Describe a value's shape without returning the value itself when it is large. */
function describeShape(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "absent";
  if (Array.isArray(value)) return `array(${value.length})`;
  const t = typeof value;
  if (t === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `object(${keys.length} keys: ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", ..." : ""})`;
  }
  return `${t}`;
}

/** A small, safe sample of a value. Never more than a couple of KB. */
function cappedSample(value: unknown, maxChars = 2000): string {
  // ABSENT AND UNSERIALISABLE ARE DIFFERENT ANSWERS. JSON.stringify(undefined)
  // returns undefined, so the first live run reported the missing lineups field
  // as "not serialisable" - which reads like the probe failed rather than like
  // the field is not there. On a tool whose entire job is distinguishing "absent"
  // from "present but empty", that wording was actively misleading.
  if (value === undefined) return "absent - this key is not present on the event";
  if (value === null) return "null - the key exists and its value is null";
  try {
    const json = JSON.stringify(value, null, 2);
    if (json === undefined) return "not serialisable";
    return json.length > maxChars ? json.slice(0, maxChars) + "\n...[capped]" : json;
  } catch {
    return "not serialisable (circular or exotic value)";
  }
}

/**
 * CLOSING-LINE PROBE. Reports the odd's REAL field names, top level and inside
 * byBookmaker, with includeOpenCloseOdds=true.
 *
 * Deliberately reports what is there rather than testing for what the docs
 * predict. Checking `"closeOverUnder" in book` and reporting a boolean would turn
 * "SGO calls it something else" into "the field is absent", which is the same
 * class of mistake as v2.8.3's warning firing on every prop: a confident answer
 * to a question that was never actually asked.
 */
async function probeClosingLine(
  sgo: SGOClient,
  leagueID: string,
  eventID: string,
  oddID: string
) {
  const events = await sgo.getAllEvents({
    leagueID,
    eventIDs: eventID,
    oddIDs: oddID,
    includeOpenCloseOdds: true,
  });

  if (!events.length) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No event found for eventID "${eventID}". For this probe use a FINALIZED game - the whole question is what a settled odd carries.`,
        },
      ],
    };
  }

  const event = events[0];
  const odd = event.odds?.[oddID] as Record<string, unknown> | undefined;

  if (!odd) {
    const available = Object.keys(event.odds ?? {}).slice(0, 15);
    return {
      content: [
        {
          type: "text" as const,
          text:
            `The event was found but carries no odd at "${oddID}".\n\n` +
            `That is a request-shape answer, not a data answer - check the oddID spelling before ` +
            `concluding anything about closing lines. Format is ` +
            `{statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}, e.g. points-all-game-ou-over ` +
            `for a game total or points-home-game-sp-home for the home spread.` +
            (available.length ? `\n\nOdds present on this event: ${available.join(", ")}` : ""),
        },
      ],
    };
  }

  const topLevelKeys = Object.keys(odd).sort();

  const byBookmakerRaw = odd.byBookmaker;
  const byBookmaker =
    byBookmakerRaw && typeof byBookmakerRaw === "object"
      ? (byBookmakerRaw as Record<string, unknown>)
      : undefined;
  const bookNames = byBookmaker ? Object.keys(byBookmaker) : [];

  // Capped at four books. Entries are a handful of short strings each, so the
  // values are worth returning - but this tool's standing rule is that output is
  // bounded by construction, not by a truncation guess.
  const sampledBooks: Record<string, unknown> = {};
  for (const name of bookNames.slice(0, 4)) {
    sampledBooks[name] = byBookmaker![name];
  }

  const bookKeyUnion = new Set<string>();
  for (const name of bookNames) {
    const entry = byBookmaker![name];
    if (entry && typeof entry === "object") {
      for (const k of Object.keys(entry as Record<string, unknown>)) bookKeyUnion.add(k);
    }
  }
  const bookKeys = [...bookKeyUnion].sort();

  // A key anywhere in the union that mentions open or close, whatever it is
  // actually named. Substring matching is right HERE, where a miss only weakens a
  // diagnostic - unlike tkb_verify_roster, where containment would hide a
  // wrong-team pick.
  const lineLike = (keys: string[]) =>
    keys.filter((k) => /open|close/i.test(k));

  const topLineLike = lineLike(topLevelKeys);
  const bookLineLike = lineLike(bookKeys);

  const carriesNumber = (keys: string[]) =>
    keys.filter((k) => /open|close/i.test(k) && /(spread|overunder|total|line|handicap)/i.test(k));

  const bookNumberFields = carriesNumber(bookKeys);
  const topNumberFields = carriesNumber(topLevelKeys);

  const verdict = bookNumberFields.length
    ? `RESOLVED. byBookmaker entries carry open/close LINE field(s): ${bookNumberFields.join(", ")}. ` +
      `This is the answer both v2.8.3 and v2.8.7 refused to guess at. Two fixes are now buildable: ` +
      `the graders can compare a postedLine against a real close instead of refusing, and ` +
      `tkb_get_line_movement can report an opening NUMBER rather than only an opening price. ` +
      `Confirm on a second event before building - one event is an observation, two is a shape.`
    : topNumberFields.length
      ? `RESOLVED, BUT NOT WHERE THE DOCS SAY. The open/close LINE field(s) ${topNumberFields.join(", ")} ` +
        `are TOP-LEVEL on the odd, not under byBookmaker. Build against these names, and note that a ` +
        `top-level value is a consensus rather than one book's close - which matters, because this ` +
        `account prices against a specific set of books.`
      : bookLineLike.length || topLineLike.length
        ? `PARTIAL. Open/close key(s) exist but none of them carry a LINE. Found top-level: ` +
          `[${topLineLike.join(", ") || "none"}]; inside byBookmaker: [${bookLineLike.join(", ") || "none"}]. ` +
          `That matches v2.8.3's finding that openOdds resolves while openOverUnder does not, and it means ` +
          `the closing line is genuinely unavailable on this plan or this path. If so, BOTH the grader ` +
          `refusal and tkb_get_line_movement's coverage note are correct as written and should be ` +
          `documented as permanent rather than left open for a tenth release.`
        : `NOT AVAILABLE. No key mentioning open or close appears anywhere on this odd, top level or ` +
          `inside byBookmaker, even with includeOpenCloseOdds=true. Before concluding, re-run on an ` +
          `event whose market a real book actually priced - an odd with an empty byBookmaker proves ` +
          `nothing either way, which is the v2.8.5 truncation lesson in a different costume.`;

  const summary =
    `CLOSING-LINE PROBE - event ${eventID}, oddID ${oddID}, includeOpenCloseOdds=true.\n\n` +
    `VERDICT: ${verdict}\n\n` +
    `Bookmakers on this odd: ${bookNames.length ? bookNames.join(", ") : "NONE - byBookmaker is absent or empty"}`;

  return {
    content: [
      {
        type: "text" as const,
        text:
          `${summary}\n\nODD TOP-LEVEL KEYS:\n${JSON.stringify(topLevelKeys, null, 2)}` +
          `\n\nUNION OF byBookmaker ENTRY KEYS:\n${JSON.stringify(bookKeys, null, 2)}` +
          `\n\nSAMPLE (up to 4 books):\n${cappedSample(sampledBooks, 2500)}`,
      },
    ],
    structuredContent: {
      eventID,
      oddID,
      includeOpenCloseOdds: true,
      oddTopLevelKeys: topLevelKeys,
      bookmakers: bookNames,
      byBookmakerKeyUnion: bookKeys,
      openCloseKeysTopLevel: topLineLike,
      openCloseKeysInByBookmaker: bookLineLike,
      lineCarryingFieldsTopLevel: topNumberFields,
      lineCarryingFieldsInByBookmaker: bookNumberFields,
      verdict,
    },
  };
}

export function registerEventProbeTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_probe_event_fields",
    {
      title: "[DIAGNOSTIC] Inspect which fields an SGO event actually carries",
      description: `Reports WHICH top-level keys exist on an SGO event and what shape they are.
Never dumps the odds map - only its size.

THE QUESTION THIS WAS BUILT FOR: src/types.ts states that no 'lineups' field
exists on an event and that starting pitchers must come from web search. SGO's own
schema browser says an Event carries lineups. One of those is stale, and the answer
decides whether the mandatory per-game starting-pitcher search can be automated.

This is deliberately NOT the old tkb_debug_raw_event, which was deleted in v2.0.0
as a quota footgun for dumping everything. This returns key names and shapes, with
capped samples, and refuses to serialise large collections.

SECOND MODE - CLOSING LINE. Pass an oddID and this instead fetches that one odd with
includeOpenCloseOdds=true and reports its REAL field names, top level and inside every
byBookmaker entry. That single call settles a question open since v2.8.3: whether a
genuine closing line exists anywhere, or whether the graders are right to refuse a
missing postedLine. It also decides whether tkb_get_line_movement can be repaired - it
currently resolves an opening PRICE but no opening NUMBER.

Args:
  - sport, eventID: for the lineups question use an UPCOMING game a few hours out,
    since that is when a lineup would be posted if it is posted at all. For the
    closing-line question use a FINALIZED game.
  - field (optional): inspect one top-level key more closely, e.g. 'lineups'
  - oddID (optional): switches to closing-line mode, e.g. 'points-all-game-ou-over'

Returns: in default mode, every top-level key with its shape, an explicit verdict on
'lineups', and market/roster COUNTS rather than contents. In closing-line mode, the
odd's field names, the union of byBookmaker entry keys, a capped sample of up to four
books, and a verdict that distinguishes "resolved", "resolved somewhere else",
"partial" and "not available" rather than collapsing them.

Cost: one event fetch, about 1 entity, in either mode.

Examples:
  - Use when: settling whether a documented field is really present
  - Use when: a field you expected is missing and you need to know if it is the
    request shape or the data
  - Use when: deciding whether a real closing line is reachable -> pass oddID on a
    finalized event
  - Don't use when: you want odds - use tkb_get_odds or tkb_get_prop_board
  - Don't use when: you want the roster - use tkb_get_players`,
      inputSchema: ProbeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: ProbeInput) => {
      try {
        const leagueID = sgo.leagueIDFor(input.sport as SportKey);

        // ---- CLOSING-LINE PROBE MODE ----
        if (input.oddID) {
          return await probeClosingLine(sgo, leagueID, input.eventID, input.oddID);
        }

        // Trivial oddID so the odds map is not serialised into the response. Per
        // SGO's docs this shapes odds/bookmakers/players only, so it cannot hide
        // a lineups field.
        const events = await sgo.getAllEvents({
          leagueID,
          eventIDs: input.eventID,
          oddIDs: "points-home-game-ml-home",
        });

        if (!events.length) {
          return {
            content: [
              { type: "text" as const, text: `No event found for eventID "${input.eventID}".` },
            ],
          };
        }

        const event = events[0] as unknown as Record<string, unknown>;
        const keys = Object.keys(event).sort();

        const shapes: Record<string, string> = {};
        for (const k of keys) {
          shapes[k] = describeShape(event[k]);
        }

        const oddsCount = event.odds && typeof event.odds === "object"
          ? Object.keys(event.odds as Record<string, unknown>).length
          : 0;
        const playerCount = event.players && typeof event.players === "object"
          ? Object.keys(event.players as Record<string, unknown>).length
          : 0;

        // ---- The lineups verdict, stated plainly either way ----
        const hasLineups = Object.prototype.hasOwnProperty.call(event, "lineups");
        const lineupsValue = event.lineups;
        const lineupsPopulated =
          hasLineups &&
          lineupsValue !== null &&
          lineupsValue !== undefined &&
          !(Array.isArray(lineupsValue) && lineupsValue.length === 0) &&
          !(
            typeof lineupsValue === "object" &&
            !Array.isArray(lineupsValue) &&
            Object.keys(lineupsValue as Record<string, unknown>).length === 0
          );

        const lineupsVerdict = !hasLineups
          ? `ABSENT. The event object has no 'lineups' key at all. The note in src/types.ts is ` +
            `CONFIRMED and the mandatory per-game starting-pitcher web search stands as written.`
          : lineupsPopulated
            ? `PRESENT AND POPULATED (${describeShape(lineupsValue)}). This CONTRADICTS the note in ` +
              `src/types.ts. If it carries a probable or confirmed starter, the per-game web search ` +
              `rule can be replaced by a connector call. Check the sample below before trusting it, ` +
              `and confirm against a second game before changing any standing rule.`
            : `PRESENT BUT EMPTY (${describeShape(lineupsValue)}). The key exists in the schema and ` +
              `carries no data for this event. That is NOT the same as absent - it may populate ` +
              `closer to first pitch. Re-probe an hour before a game before concluding.`;

        const sampleField = input.field ?? (hasLineups ? "lineups" : undefined);
        const sampleBlock = sampleField
          ? `\n\nSAMPLE of "${sampleField}":\n${cappedSample(event[sampleField])}`
          : "";

        const summary =
          `Event ${input.eventID} carries ${keys.length} top-level key(s).\n\n` +
          `LINEUPS VERDICT: ${lineupsVerdict}\n\n` +
          `Counts (contents deliberately not returned): ${oddsCount} odds market(s), ` +
          `${playerCount} player(s).`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${summary}\n\nKEY SHAPES:\n${JSON.stringify(shapes, null, 2)}${sampleBlock}`,
            },
          ],
          structuredContent: {
            eventID: input.eventID,
            topLevelKeys: keys,
            keyShapes: shapes,
            oddsMarketCount: oddsCount,
            playerCount,
            lineups: {
              keyPresent: hasLineups,
              populated: lineupsPopulated,
              shape: describeShape(lineupsValue),
            },
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error probing event: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
