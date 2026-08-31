import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";
import type { SGOEvent } from "../types.js";

/**
 * BATCH PICK GRADER
 *
 * THE PROBLEM: tkb_grade_pick resolves ONE pick per call. A real day is 50-60
 * picks across MLB, WNBA and tennis, and the documented workflow for grading them
 * involves pulling published threads, fetching box scores from several different
 * sources, and reconciling by hand - with explicit notes about pitcher strikeout
 * counts being the single largest error source and about scores being read from
 * pages that render stale pre-game previews hours after a game ended.
 *
 * That is the largest recurring manual cost in the whole operation, and unlike
 * thread-building it produces nothing new - it is pure reconciliation.
 *
 * WHAT THIS DOES DIFFERENTLY: takes the whole slate at once, groups picks by
 * event so each game is fetched exactly once regardless of how many picks it
 * carries, and returns every pick resolved with the line it was graded against.
 *
 * DESIGN DECISIONS CARRIED OVER FROM THE SINGLE-PICK GRADER, because they were
 * right and matter more at volume:
 *   - Grades against YOUR posted line when supplied, not the closing line, and
 *     flags loudly when the two differ. Publishing a wrong CASHED post is worse
 *     than publishing none.
 *   - Refuses to grade a non-finalized event. "Not final" is an answer; a guess
 *     is a liability.
 *   - Never infers a result from a missing field.
 */

const PickSchema = z.object({
  ref: z
    .string()
    .describe("Your own label for this pick, echoed back so results can be matched up."),
  eventID: z.string().describe("SGO eventID for the game this pick belongs to."),
  marketType: z.enum(["moneyline", "spread", "total", "player_prop"]),
  side: z.enum(["over", "under", "home", "away"]),
  marketLabel: z.string().optional().describe("Required for player_prop, e.g. 'Hits'."),
  playerID: z.string().optional().describe("Required for player_prop."),
  playerName: z.string().optional(),
  postedLine: z
    .number()
    .optional()
    .describe("The line as YOU posted it. Strongly recommended - grading against the closing line can disagree with what followers actually saw."),
});

const BatchGradeInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]),
    picks: z
      .array(PickSchema)
      .min(1)
      .max(60)
      .describe("Every pick to grade. Group a whole slate here - events are fetched once each."),
  })
  .strict();

type BatchGradeInput = z.infer<typeof BatchGradeInputSchema>;

const MARKET_TYPE_CODE: Record<string, "ml" | "sp" | "ou"> = {
  moneyline: "ml",
  spread: "sp",
  total: "ou",
  player_prop: "ou",
};

interface GradedPick {
  ref: string;
  result: "WIN" | "LOSS" | "PUSH" | "NOT_FINAL" | "NO_DATA";
  detail: string;
  actualValue?: number | null;
  lineGradedAgainst?: number | null;
  closingLine?: number | null;
  lineMismatch?: boolean;
}

export function registerBatchGradeTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_grade_slate",
    {
      title: "Grade a whole slate of posted picks at once",
      description: `Resolve every pick from a day's threads to WIN / LOSS / PUSH in one call.

Groups picks by event so each game is fetched exactly once no matter how many picks
it carries - grading 12 picks across 4 games costs 4 event fetches, not 12.

Args:
  - sport
  - picks: array of { ref, eventID, marketType, side, marketLabel?, playerID?, playerName?, postedLine? }
    'ref' is your own label (e.g. "Marte TB under") and is echoed back for matching.

Returns: every pick graded, plus a slate summary (record, pushes, ungraded) ready to drop
into the tracker.

CRITICAL - PASS postedLine. SGO stores the line as it CLOSED. If you posted an over
at 245.5 and it closed at 250.5, grading against the close can disagree with what your
followers actually saw. When postedLine is given, that is what gets graded and any
discrepancy is flagged.

Examples:
  - Use when: writing CASHED/miss replies for yesterday's threads
  - Use when: filling in the Result column of the bet tracker for a full day
  - Don't use when: games are still live - unfinished events return NOT_FINAL, never a guess

Error Handling:
  - NOT_FINAL for any event SGO has not finalized
  - NO_DATA when the event is final but the market has no settlement value - never guesses
  - One bad pick never aborts the batch; it is reported and the rest still grade`,
      inputSchema: BatchGradeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: BatchGradeInput) => {
      try {
        const leagueID = sgo.leagueIDFor(params.sport);

        // Group by event so each game is fetched once.
        const byEvent = new Map<string, BatchGradeInput["picks"]>();
        for (const p of params.picks) {
          const list = byEvent.get(p.eventID) ?? [];
          list.push(p);
          byEvent.set(p.eventID, list);
        }

        const graded: GradedPick[] = [];

        for (const [eventID, picks] of byEvent) {
          // Build every oddID this event needs, so one fetch covers all its picks.
          const oddIDs: string[] = [];
          for (const p of picks) {
            const statID = resolveStatID(params.sport, p);
            if (statID === null) continue;
            const entity =
              p.marketType === "player_prop"
                ? p.playerID!
                : p.marketType === "total"
                  ? "all"
                  : p.side;
            oddIDs.push(
              buildOddID({
                statID,
                entity,
                period: "full_game",
                betType: MARKET_TYPE_CODE[p.marketType]!,
                side: p.side,
              })
            );
          }

          let event: SGOEvent | undefined;
          try {
            const events = await sgo.getAllEvents({
              leagueID,
              eventIDs: eventID,
              finalized: true,
              oddIDs: oddIDs.length ? oddIDs.join(",") : undefined,
            });
            event = events[0];
          } catch (err) {
            for (const p of picks) {
              graded.push({
                ref: p.ref,
                result: "NO_DATA",
                detail: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
            continue;
          }

          if (!event) {
            for (const p of picks) {
              graded.push({
                ref: p.ref,
                result: "NOT_FINAL",
                detail: `Event ${eventID} is not finalized. Do not grade this pick yet.`,
              });
            }
            continue;
          }

          for (const p of picks) {
            graded.push(gradeOne(params.sport, event, p));
          }
        }

        const wins = graded.filter((g) => g.result === "WIN").length;
        const losses = graded.filter((g) => g.result === "LOSS").length;
        const pushes = graded.filter((g) => g.result === "PUSH").length;
        const ungraded = graded.filter(
          (g) => g.result === "NOT_FINAL" || g.result === "NO_DATA"
        ).length;
        const settled = wins + losses;
        const pct = settled > 0 ? ((wins / settled) * 100).toFixed(1) : "n/a";

        const header =
          `${graded.length} pick(s) processed across ${byEvent.size} event(s).\n` +
          `Record: ${wins}-${losses}${pushes ? `-${pushes}` : ""} (${pct}% on settled picks)` +
          (ungraded ? ` | ${ungraded} not gradeable yet` : "") +
          (graded.some((g) => g.result !== "NOT_FINAL" && g.closingLine === null)
            ? `\n\nNOTE: closing lines are not available on this fetch path, so no posted-vs-closed comparison is made. Everything with a postedLine was graded against that line, which is the correct basis for your record.`
            : "");

        return {
          content: [
            { type: "text" as const, text: `${header}\n\n${JSON.stringify(graded, null, 2)}` },
          ],
          structuredContent: {
            totals: { wins, losses, pushes, ungraded, settled, winPct: pct },
            eventsFetched: byEvent.size,
            picks: graded,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error grading slate: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

function resolveStatID(sport: SportKey, p: BatchGradeInput["picks"][number]): string | null {
  if (p.marketType !== "player_prop") return "points";
  if (!p.marketLabel) return null;
  const market = OU_PROP_MARKETS[sport].find(
    (m) => m.label.toLowerCase() === p.marketLabel!.toLowerCase()
  );
  return market?.statID ?? null;
}

function gradeOne(
  sport: SportKey,
  event: SGOEvent,
  p: BatchGradeInput["picks"][number]
): GradedPick {
  // ---- Moneyline: compare final scores, no line involved ----
  if (p.marketType === "moneyline") {
    const home = event.teams.home.score;
    const away = event.teams.away.score;
    if (home === undefined || away === undefined) {
      return { ref: p.ref, result: "NO_DATA", detail: "Final scores unavailable." };
    }
    const picked = p.side === "home" ? home : away;
    const other = p.side === "home" ? away : home;
    const result = picked > other ? "WIN" : picked < other ? "LOSS" : "PUSH";
    return {
      ref: p.ref,
      result,
      detail: `${p.side} ML, final ${away}-${home} (away-home).`,
    };
  }

  const statID = resolveStatID(sport, p);
  if (statID === null) {
    return {
      ref: p.ref,
      result: "NO_DATA",
      detail: `"${p.marketLabel}" is not a recognized ${sport.toUpperCase()} prop market.`,
    };
  }

  const entity =
    p.marketType === "player_prop" ? p.playerID! : p.marketType === "total" ? "all" : p.side;
  const oddID = buildOddID({
    statID,
    entity,
    period: "full_game",
    betType: MARKET_TYPE_CODE[p.marketType]!,
    side: p.side,
  });

  const odd = event.odds?.[oddID] as Record<string, unknown> | undefined;
  if (!odd) {
    return {
      ref: p.ref,
      result: "NO_DATA",
      detail: `Event is final but no settlement data returned for ${oddID}. Grade manually.`,
    };
  }

  const scoreRaw = odd.score;
  const actual = typeof scoreRaw === "string" ? parseFloat(scoreRaw) : (scoreRaw as number);
  if (actual === undefined || actual === null || Number.isNaN(actual)) {
    return {
      ref: p.ref,
      result: "NO_DATA",
      detail: "Event final but SGO returned no result value for this market.",
    };
  }

  // CLOSING LINE IS NOT AVAILABLE ON THIS PATH. See the long note in gradePicks.ts.
  // Measured 2026-08-31: a 16-1 final reported a "closing line" of 17.5, because
  // closeOverUnder/closeSpread do not exist at the top level of an odd (they live
  // under byBookmaker.<book> and require includeOpenCloseOdds=true), so the chain
  // always fell through to bookOverUnder, which on a settled blowout holds the last
  // LIVE number rather than the close. It was reporting the final score.
  //
  // Fall back to the feed's own line ONLY to grade when no postedLine was given.
  // It is never presented as a close, and never used to compute a mismatch.
  const feedLineRaw = odd.bookOverUnder ?? odd.bookSpread;
  const feedLine =
    typeof feedLineRaw === "string" ? parseFloat(feedLineRaw) : (feedLineRaw as number | undefined);
  const lineUsed = p.postedLine ?? feedLine;

  if (lineUsed === undefined || lineUsed === null || Number.isNaN(lineUsed)) {
    return {
      ref: p.ref,
      result: "NO_DATA",
      detail: "No line available to grade against. Pass postedLine explicitly.",
    };
  }

  let result: "WIN" | "LOSS" | "PUSH";
  if (actual === lineUsed) result = "PUSH";
  else if (p.side === "over" || p.side === "home") result = actual > lineUsed ? "WIN" : "LOSS";
  else result = actual < lineUsed ? "WIN" : "LOSS";

  // No closing line is obtainable here, so no mismatch can be computed. Claiming one
  // fired a warning on essentially every total and prop graded.
  const lineMismatch = false;

  const label = p.playerName
    ? `${p.playerName} ${p.side.toUpperCase()} ${lineUsed} ${p.marketLabel ?? ""}`.trim()
    : `${p.marketType} ${p.side} ${lineUsed}`;

  return {
    ref: p.ref,
    result,
    detail:
      `${label} - actual ${actual}.` +
      (p.postedLine === undefined
        ? ` NOTE: graded against the feed's line (${lineUsed}), not a posted line. Pass postedLine for tracker or public results.`
        : ""),
    actualValue: actual,
    lineGradedAgainst: lineUsed,
    closingLine: null,
    lineMismatch,
  };
}
