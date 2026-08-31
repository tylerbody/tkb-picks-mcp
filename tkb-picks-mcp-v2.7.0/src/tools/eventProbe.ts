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

Args:
  - sport, eventID: use an UPCOMING game a few hours out, since that is when a
    lineup would be posted if it is posted at all
  - field (optional): inspect one top-level key more closely, e.g. 'lineups'

Returns: every top-level key with its shape, an explicit verdict on 'lineups',
market and roster COUNTS rather than contents, and a capped sample of the
requested field.

Cost: one event fetch, about 1 entity.

Examples:
  - Use when: settling whether a documented field is really present
  - Use when: a field you expected is missing and you need to know if it is the
    request shape or the data
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
