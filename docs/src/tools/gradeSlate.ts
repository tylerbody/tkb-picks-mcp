import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";
import type { SGOEvent } from "../types.js";
import {
  gradeSpread,
  gradeOverUnder,
  gradeMoneyline,
  gradePlayerProp,
  missingPostedLineRefusal,
  SPREAD_SIGN_CONVENTION,
} from "../services/pickGrader.js";
import { lookupPlayerStat } from "../services/hitRateAggregator.js";

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
 * ALL COMPARISON MATH LIVES IN services/pickGrader.ts, shared with tkb_grade_pick.
 * It used to be duplicated between the two files, and both copies carried the same
 * spread bug: a spread was compared against a team's own score rather than the
 * margin, so every home favourite graded WIN automatically. Fifteen confirmed
 * flipped results, listed in claude/grading-accuracy-guardrails.md. One
 * implementation now, with tests behind it. See that file's header for the
 * measurements.
 */

const PickSchema = z.object({
  ref: z
    .string()
    .describe("Your own label for this pick, echoed back so results can be matched up."),
  eventID: z.string().describe("SGO eventID for the game this pick belongs to."),
  marketType: z.enum(["moneyline", "spread", "total", "player_prop"]),
  side: z
    .enum(["over", "under", "home", "away"])
    .describe("home/away for moneyline and spread, over/under for total and player_prop."),
  marketLabel: z.string().optional().describe("Required for player_prop, e.g. 'Hits'."),
  playerID: z.string().optional().describe("Required for player_prop."),
  playerName: z.string().optional(),
  postedLine: z
    .number()
    .optional()
    .describe(
      "The line exactly as YOU posted it. REQUIRED for spread, total and player_prop - " +
        "those are refused without it rather than graded against the feed. Not used for " +
        "moneyline. FOR SPREADS THE SIGN MATTERS AND IS NOT AUTO-DETECTED: " +
        SPREAD_SIGN_CONVENTION
    ),
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
  result: "WIN" | "LOSS" | "PUSH" | "VOID" | "NOT_FINAL" | "NO_DATA" | "NEEDS_POSTED_LINE";
  detail: string;
  actualValue?: number | null;
  lineGradedAgainst?: number | null;
  /** Spreads only: picked team's margin, and the arithmetic behind the verdict. */
  margin?: number;
  finalScore?: string;
  explanation?: string;
  /** Player props only: false only when the game carries no box score to check against. */
  participationResolved?: boolean;
  note?: string | null;
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

CRITICAL - PASS postedLine ON EVERY SPREAD, TOTAL AND PROP. They are REFUSED without
it and come back NEEDS_POSTED_LINE. On a finalized event SGO's own line has converged
onto the result: a game that finished 62-13 carried a feed total of 76.5 against 75
actual points, and a feed spread of -48.5 against a final margin of 49. Grading
against that number compares the result to itself.

SPREAD SIGN: ${SPREAD_SIGN_CONVENTION} A dropped minus sign is not detectable, so
every spread result carries the final score, the margin and the arithmetic. Read the
explanation before logging.

Returns: every pick graded, plus a slate summary (record, pushes, ungraded) ready to
drop into the tracker. For spreads, actualValue is the MARGIN, not a team's score.

Examples:
  - Use when: writing CASHED/miss replies for yesterday's threads
  - Use when: filling in the Result column of the bet tracker for a full day
  - Don't use when: games are still live - unfinished events return NOT_FINAL, never a guess

Error Handling:
  - NOT_FINAL for any event SGO has not finalized
  - NEEDS_POSTED_LINE for a line market with no postedLine - a refusal, not a failure
  - NO_DATA when the event is final but the market has no settlement value - never guesses
  - VOID when a player does not appear in the box score at all: the pick had no action.
    A zero is resolved against the box score rather than flagged for a human
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
        const needsLine = graded.filter((g) => g.result === "NEEDS_POSTED_LINE").length;
        const ungraded = graded.filter(
          (g) =>
            g.result === "NOT_FINAL" ||
            g.result === "NO_DATA" ||
            g.result === "NEEDS_POSTED_LINE"
        ).length;
        const settled = wins + losses;
        const pct = settled > 0 ? ((wins / settled) * 100).toFixed(1) : "n/a";
        const voids = graded.filter((g) => g.result === "VOID").length;
        const flaggedZero = graded.filter(
          (g) => g.participationResolved === false
        ).length;

        const header =
          `${graded.length} pick(s) processed across ${byEvent.size} event(s).\n` +
          `Record: ${wins}-${losses}${pushes ? `-${pushes}` : ""} (${pct}% on settled picks)` +
          (ungraded ? ` | ${ungraded} not gradeable` : "") +
          (needsLine
            ? `\n\n${needsLine} pick(s) REFUSED for having no postedLine. That is a refusal, not a failure: on a finalized event the feed's line has converged onto the result, so grading against it compares the result to itself. Re-run those with the line as published.`
            : "") +
          (voids
            ? `\n\n${voids} pick(s) returned VOID: the player does not appear in that game's box score while his teammates do, so the pick never had action. Log those as Void, not as a Hit or a Miss.`
            : "") +
          (flaggedZero
            ? `\n\n${flaggedZero} player prop(s) could NOT have participation resolved, because the game carries no player box score at all. Those are the only ones needing a manual check.`
            : "");

        return {
          content: [
            { type: "text" as const, text: `${header}\n\n${JSON.stringify(graded, null, 2)}` },
          ],
          structuredContent: {
            totals: { wins, losses, pushes, voids, ungraded, needsPostedLine: needsLine, settled, winPct: pct },
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
  const homeScore = event.teams.home.score;
  const awayScore = event.teams.away.score;
  const homeName = event.teams.home.names?.long ?? "home";
  const awayName = event.teams.away.names?.long ?? "away";

  // ---- Moneyline: compare final scores, no line involved ----
  if (p.marketType === "moneyline") {
    if (homeScore === undefined || awayScore === undefined) {
      return { ref: p.ref, result: "NO_DATA", detail: "Final scores unavailable." };
    }
    if (p.side !== "home" && p.side !== "away") {
      return {
        ref: p.ref,
        result: "NO_DATA",
        detail: `Moneyline needs side='home' or 'away', got '${p.side}'.`,
      };
    }
    const result = gradeMoneyline({ side: p.side, homeScore, awayScore });
    return {
      ref: p.ref,
      result,
      detail: `${p.side} ML, final ${awayName} ${awayScore} - ${homeName} ${homeScore}.`,
      finalScore: `${awayName} ${awayScore} - ${homeName} ${homeScore}`,
    };
  }

  // Every remaining market compares against a line, and the feed's line on a
  // finalized event is the result. Refuse rather than substitute.
  if (p.postedLine === undefined) {
    return {
      ref: p.ref,
      result: "NEEDS_POSTED_LINE",
      detail: missingPostedLineRefusal(p.marketType),
    };
  }

  // ---- Spread: from the MARGIN, never from a team's own score ----
  //
  // odd.score for points-<side>-game-sp-<side> is that team's own points, so the
  // old comparison asked whether 62 was greater than -35.5. It always was. The two
  // team scores are the honest source and they are already here.
  if (p.marketType === "spread") {
    if (p.side !== "home" && p.side !== "away") {
      return {
        ref: p.ref,
        result: "NO_DATA",
        detail: `Spread needs side='home' or 'away', got '${p.side}'.`,
      };
    }
    if (homeScore === undefined || awayScore === undefined) {
      return {
        ref: p.ref,
        result: "NO_DATA",
        detail: "Final scores unavailable, so no margin can be computed for this spread.",
      };
    }
    const graded = gradeSpread({
      side: p.side,
      homeScore,
      awayScore,
      line: p.postedLine,
      pickedName: p.side === "home" ? homeName : awayName,
      opponentName: p.side === "home" ? awayName : homeName,
    });
    return {
      ref: p.ref,
      result: graded.result,
      detail: graded.explanation,
      actualValue: graded.margin,
      margin: graded.margin,
      lineGradedAgainst: p.postedLine,
      finalScore: `${awayName} ${awayScore} - ${homeName} ${homeScore}`,
      explanation: graded.explanation,
    };
  }

  // ---- Total and player prop: settled value against the posted line ----
  if (p.side !== "over" && p.side !== "under") {
    return {
      ref: p.ref,
      result: "NO_DATA",
      detail: `${p.marketType} needs side='over' or 'under', got '${p.side}'.`,
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

  const entity = p.marketType === "player_prop" ? p.playerID! : "all";
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

  const label = p.playerName
    ? `${p.playerName} ${p.side.toUpperCase()} ${p.postedLine} ${p.marketLabel ?? ""}`.trim()
    : `${p.marketType} ${p.side} ${p.postedLine}`;

  // ---- Player prop: participation is RESOLVED from the box score, not flagged ----
  if (p.marketType === "player_prop") {
    const outcome = gradePlayerProp({
      lookup: lookupPlayerStat(event, p.playerID!, statID),
      fallbackScore: actual,
      side: p.side,
      line: p.postedLine,
      playerLabel: p.playerName ?? p.playerID ?? "this player",
      sport,
    });

    const resolvedResult =
      outcome.result ?? (outcome.kind === "void" ? "VOID" : "NO_DATA");

    return {
      ref: p.ref,
      result: resolvedResult as GradedPick["result"],
      detail:
        outcome.kind === "graded"
          ? `${label} - actual ${outcome.value}.`
          : `${label} - ${outcome.note}`,
      actualValue: outcome.value,
      lineGradedAgainst: p.postedLine,
      participationResolved: outcome.kind !== "unresolved",
      note: outcome.note,
    };
  }

  const result = gradeOverUnder({ side: p.side, actual, line: p.postedLine });

  return {
    ref: p.ref,
    result,
    detail: `${label} - actual ${actual}.`,
    actualValue: actual,
    lineGradedAgainst: p.postedLine,
  };
}
