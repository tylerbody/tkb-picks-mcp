import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { BDLClient } from "../services/bdlClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { gameTotalStatFor, SUPPORTED_SPORTS, hasDrawOutcome, matchLinePeriodFor, type SportKey } from "../constants.js";
import type { SGOEvent } from "../types.js";
import {
  gradeSpread,
  gradeOverUnder,
  gradeMoneyline,
  gradeSoccerMoneyline,
  DRAW_CONVENTION,
  gradePlayerProp,
  missingPostedLineRefusal,
  SPREAD_SIGN_CONVENTION,
} from "../services/pickGrader.js";
import { lookupPlayerStat } from "../services/hitRateAggregator.js";
import { assessFinality, crossCheckFinality } from "../services/eventStatus.js";
import { diagnosePlayerIdMiss } from "../services/playerResolution.js";

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
  marketType: z
    .enum(["moneyline", "moneyline_3way", "spread", "total", "player_prop"])
    .describe(
      "moneyline_3way is the SOCCER 1X2 price, where the draw is its own outcome and a " +
        "draw is a LOSS for a team pick. Use plain moneyline for a two-way price."
    ),
  side: z
    .enum(["over", "under", "home", "away", "draw"])
    .describe(
      "home/away for moneyline, moneyline_3way and spread; over/under for total and " +
        "player_prop; draw ONLY on moneyline_3way."
    ),
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

const MARKET_TYPE_CODE: Record<string, "ml" | "sp" | "ou" | "ml3way"> = {
  moneyline: "ml",
  moneyline_3way: "ml3way",
  spread: "sp",
  total: "ou",
  player_prop: "ou",
};

interface GradedPick {
  ref: string;
  result:
    | "WIN"
    | "LOSS"
    | "PUSH"
    | "VOID"
    | "NOT_FINAL"
    | "NO_DATA"
    | "NEEDS_POSTED_LINE"
    // SOCCER ONLY. A drawn match on a two-way price: Draw No Bet pushes and a
    // draw-excluded moneyline loses, SGO does not say which it sold, and the
    // difference is the whole stake. See services/pickGrader.ts.
    | "NEEDS_MANUAL_REVIEW";
  detail: string;
  actualValue?: number | null;
  lineGradedAgainst?: number | null;
  /** Spreads only: picked team's margin, and the arithmetic behind the verdict. */
  margin?: number;
  finalScore?: string;
  explanation?: string;
  /** Set when the pick was refused because the game is not over. */
  statusLabel?: string;
  /** Player props only: false only when the game carries no box score to check against. */
  participationResolved?: boolean;
  note?: string | null;
}

export function registerBatchGradeTool(server: McpServer, sgo: SGOClient, bdl?: BDLClient) {
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
  - NOT_FINAL for any event SGO has not finalized. If SGO merely has NO status on it
    (an ingest lag rather than a live game), BALLDONTLIE is asked once as a second
    source and the pick grades only if BDL calls it final AND the two scores match
    exactly. A live or cancelled status is never overridden, and the scores graded
    against are always SGO's.
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
            // The three-way DRAW side is priced on the game-wide `all` entity, not on
            // a team, per SGO's own rows: points-all-<period>-ml3way-draw.
            const entity =
              p.marketType === "player_prop"
                ? p.playerID!
                : p.marketType === "total" || p.side === "draw"
                  ? "all"
                  : p.side;
            oddIDs.push(
              buildOddID({
                statID,
                entity,
                period:
                  p.marketType === "player_prop"
                    ? "full_game"
                    : matchLinePeriodFor(params.sport),
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

          // ---- IS IT ACTUALLY OVER? ----
          // `finalized: true` returned an in-progress CFB game on 2026-09-12 and
          // every pick on it was graded off the live score. Checked once per event
          // rather than once per pick, since the answer is a property of the game.
          const finality = assessFinality(event);

          // ADDED v2.8.12. Unknown status is not the same as unfinished. One BDL
          // request per STUCK event only - a slate of gradeable games costs zero
          // extra calls, and a slate SGO has not caught up with costs one each.
          // See services/eventStatus.ts for why it can only ever move unknown to
          // final, and why it never supplies a score.
          let crossCheckNote = "";
          let finalityResolved = finality.final;
          if (finality.crossCheckable) {
            const cross = await crossCheckFinality(bdl, params.sport, event);
            crossCheckNote = cross.note;
            finalityResolved = cross.resolved;
          }

          if (!finalityResolved) {
            const detail = crossCheckNote
              ? `${finality.reason}\n\n${crossCheckNote}`
              : finality.reason;
            for (const p of picks) {
              graded.push({
                ref: p.ref,
                // A CANCELLED EVENT IS VOID, NOT "NOT FINAL YET". The prose already
                // said so; the result field used to disagree with it, so a tracker
                // filed the pick as ungraded and waited for a game that is never
                // coming. See services/eventStatus.ts.
                result: finality.cancelled ? "VOID" : "NOT_FINAL",
                detail,
                statusLabel: finality.label,
              });
            }
            continue;
          }

          for (const p of picks) {
            const row = gradeOne(params.sport, event, p);
            // A grade that SGO's own status field does not support must not read
            // like an ordinary one. Carry the provenance onto every row it covers.
            if (!finality.final && crossCheckNote) {
              row.detail = row.detail ? `${row.detail}\n\n${crossCheckNote}` : crossCheckNote;
            }
            graded.push(row);
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
        const notFinal = graded.filter((g) => g.result === "NOT_FINAL").length;
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
          (notFinal
            ? `\n\n${notFinal} pick(s) returned NOT_FINAL because their game is not over. SGO's finalized-only filter does return in-progress games, so this tool checks the event status itself rather than trusting it. Do NOT log these; use tkb_monitor_live_picks while a game is running.`
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
  // A TOTAL counts rounds in MMA and games in tennis, not points. See
  // GAME_TOTAL_STAT in constants.ts.
  if (p.marketType === "total") return gameTotalStatFor(sport);
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

  // ---- SOCCER: a level score is a RESULT, not a push ----
  if ((p.marketType === "moneyline" || p.marketType === "moneyline_3way") && hasDrawOutcome(sport)) {
    if (homeScore === undefined || awayScore === undefined) {
      return { ref: p.ref, result: "NO_DATA", detail: "Final scores unavailable." };
    }
    const graded = gradeSoccerMoneyline({
      side: p.side as "home" | "away" | "draw",
      homeScore,
      awayScore,
      threeWay: p.marketType === "moneyline_3way",
      pickedName: p.side === "home" ? homeName : awayName,
      opponentName: p.side === "home" ? awayName : homeName,
    });
    if (graded.kind === "refused") {
      return { ref: p.ref, result: "NEEDS_MANUAL_REVIEW", detail: graded.reason };
    }
    return {
      ref: p.ref,
      result: graded.result,
      detail: graded.explanation,
      explanation: graded.explanation,
      finalScore: `${awayName} ${awayScore} - ${homeName} ${homeScore}`,
    };
  }

  // A three-way price on a sport that cannot draw is a mis-logged pick. Without
  // this it would fall through to the postedLine check and be refused for the wrong
  // reason, which sends the reader looking for a line that does not exist.
  if (p.marketType === "moneyline_3way") {
    return {
      ref: p.ref,
      result: "NO_DATA",
      detail:
        `marketType='moneyline_3way' on ${sport.toUpperCase()}, which has no draw outcome. ` +
        `A 1X2 price only exists where a match can end level. Use marketType='moneyline'.`,
    };
  }

  // A draw on any other market type is a mis-logged pick, not a gradeable one.
  if (p.side === "draw") {
    return {
      ref: p.ref,
      result: "NO_DATA",
      detail:
        `side='draw' is only valid with marketType='moneyline_3way' on a soccer event. ` +
        `${DRAW_CONVENTION}`,
    };
  }

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
    period: p.marketType === "player_prop" ? "full_game" : matchLinePeriodFor(sport),
    betType: MARKET_TYPE_CODE[p.marketType]!,
    side: p.side,
  });

  const odd = event.odds?.[oddID] as Record<string, unknown> | undefined;
  if (!odd) {
    const idDiagnosis =
      p.marketType === "player_prop" && p.playerID
        ? diagnosePlayerIdMiss(event, p.playerID, p.marketLabel).message
        : null;
    return {
      ref: p.ref,
      result: "NO_DATA",
      detail:
        idDiagnosis ??
        `Event is final but no settlement data returned for ${oddID}. Grade manually.`,
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
