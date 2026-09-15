import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { BDLClient } from "../services/bdlClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { SUPPORTED_SPORTS, hasDrawOutcome, matchLinePeriodFor, type SportKey } from "../constants.js";
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
 * PICK GRADING - resolve a posted pick to WIN / LOSS / PUSH from real settled data.
 *
 * WHY THIS EXISTS: the CASHED reply, the miss reply, and the bet tracker are all
 * otherwise resolved by hand, game by game, after the fact.
 *
 * ALL COMPARISON MATH LIVES IN services/pickGrader.ts, exported and pure, shared
 * with tkb_grade_slate. It used to be inline here and inline again there, and both
 * copies carried the same spread bug for fifteen confirmed flipped results. Read
 * that file's header for the measurements.
 *
 * TWO RULES THIS TOOL NOW ENFORCES, both learned from live data:
 *
 * 1. A SPREAD IS GRADED FROM THE MARGIN, never from a team's own score. The margin
 *    comes from teams.home.score / teams.away.score, the same fields the moneyline
 *    branch has always used.
 *
 * 2. A LINE-BASED MARKET WITHOUT A postedLine IS REFUSED, never graded against the
 *    feed. On a finalized event SGO's line has converged onto the result - measured
 *    2026-09-07, a 62-13 final carried a feed total of 76.5 against 75 actual points
 *    and a feed spread of -48.5 against a final margin of 49.
 *
 * ONLY grades genuinely finalized events. An unfinished game returns "not final"
 * rather than a guess, for the same reason the pricing guardrail refuses to publish
 * modelled odds: a plausible-looking wrong answer is worse than no answer.
 */
const GradeInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventID: z.string().describe("SGO eventID for the finished game."),
    marketType: z
      .enum(["moneyline", "moneyline_3way", "spread", "total", "player_prop"])
      .describe(
        "Which kind of pick is being graded. moneyline_3way is the SOCCER 1X2 price, " +
          "where the draw is its own selectable outcome and a draw is a LOSS for a team " +
          "pick. Use plain moneyline for a two-way price."
      ),
    side: z
      .enum(["over", "under", "home", "away", "draw"])
      .describe(
        "The side that was picked. home/away for moneyline, moneyline_3way and spread; " +
          "over/under for total and player_prop; draw ONLY on moneyline_3way."
      ),
    marketLabel: z
      .string()
      .optional()
      .describe("Required for player_prop. Exact stat name, e.g. 'Passing Yards', 'Hits'."),
    playerID: z
      .string()
      .optional()
      .describe("Required for player_prop. SGO playerID."),
    playerName: z.string().optional().describe("Player display name, for output labeling."),
    postedLine: z
      .number()
      .optional()
      .describe(
        "The line exactly as YOU posted it. REQUIRED for spread, total and player_prop - " +
          "those markets are refused without it, because on a finalized event the feed's own " +
          "line has converged onto the final result and grading against it compares the result " +
          "to itself. Not used for moneyline. FOR SPREADS THE SIGN MATTERS AND IS NOT " +
          "AUTO-DETECTED: " +
          SPREAD_SIGN_CONVENTION
      ),
  })
  .strict();

type GradeInput = z.infer<typeof GradeInputSchema>;

const MARKET_TYPE_CODE: Record<string, "ml" | "sp" | "ou" | "ml3way"> = {
  moneyline: "ml",
  moneyline_3way: "ml3way",
  spread: "sp",
  total: "ou",
  player_prop: "ou",
};

export function registerGradePicksTool(server: McpServer, sgo: SGOClient, bdl?: BDLClient) {
  server.registerTool(
    "tkb_grade_pick",
    {
      title: "Grade a Posted Pick",
      description: `Resolve a posted pick to WIN / LOSS / PUSH using real settled result data.

Args:
  - sport, eventID, marketType, side
  - marketLabel + playerID: required for player_prop
  - postedLine: REQUIRED for spread, total and player_prop. Ignored for moneyline.

PASS postedLine. Spreads, totals and props are REFUSED without it. On a finalized
event SGO's own line has converged onto the result (a 62-13 game carried a feed total
of 76.5 against 75 points, and a feed spread of -48.5 against a margin of 49), so
grading against it compares the result to itself.

SPREAD SIGN: ${SPREAD_SIGN_CONVENTION} A dropped minus sign cannot be detected, so
every spread grade returns the final score, the margin, what the pick needed and the
arithmetic. Read that line before logging the result.

FINALITY: an unfinished game returns NOT_FINAL rather than a guess. When SGO has no
readable status at all - its ingest lagging the final whistle, not a game in progress -
BALLDONTLIE is checked once, and the pick grades only if BDL calls it final AND both
feeds report the same score. A live or cancelled status is never overridden.

Returns: result (win/loss/push), the value compared against the line - for a spread
that is the MARGIN, not a team's score - the line graded against, and for spreads a
full plain-English explanation of the arithmetic.

Examples:
  - Use when: writing the CASHED or miss reply for yesterday's threads
  - Use when: filling in the Result column of the bet tracker
  - Don't use when: the game isn't final - this returns "not final", never a guess

Error Handling:
  - Returns "not final" for any event SGO has not finalized
  - Returns "no settlement data" rather than guessing if the result field is absent
  - REFUSES a spread/total/prop with no postedLine rather than using the feed's line
  - RESOLVES a player prop that settled at 0 by checking the box score: a genuine DNP
    returns VOID (no action), and only a game with no box score at all is flagged`,
      inputSchema: GradeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: GradeInput) => {
      try {
        if (params.marketType === "player_prop" && (!params.marketLabel || !params.playerID)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: marketType='player_prop' requires both marketLabel and playerID.",
              },
            ],
            isError: true,
          };
        }

        // A THREE-WAY MONEYLINE HAS NO LINE, which this check did not know in
        // v2.9.0 and v2.9.1. Measured live 2026-09-14 on Leeds 4-1 Newcastle: a
        // moneyline_3way pick was refused for "no postedLine", which is not a thing
        // a 1X2 price has. The refusal was correct machinery pointed at the wrong
        // market type, and it made the whole soccer grading path unusable through
        // this tool.
        //
        // Listed explicitly rather than as "not a moneyline variant" so that adding
        // a market type later cannot silently inherit the wrong side of it.
        const marketHasNoLine =
          params.marketType === "moneyline" || params.marketType === "moneyline_3way";

        // A three-way price on a sport that cannot draw is a mis-logged pick, and
        // saying so beats grading it as though the market existed.
        if (params.marketType === "moneyline_3way" && !hasDrawOutcome(params.sport)) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Error: marketType='moneyline_3way' on ${params.sport.toUpperCase()}, which has ` +
                  `no draw outcome. A 1X2 price only exists where a match can end level. Use ` +
                  `marketType='moneyline'.`,
              },
            ],
            isError: true,
          };
        }

        if (!marketHasNoLine && params.postedLine === undefined) {
          return {
            content: [
              { type: "text" as const, text: missingPostedLineRefusal(params.marketType) },
            ],
          };
        }

        // A draw is only selectable on a three-way price. Checked before anything is
        // fetched, because "draw" on a two-way market means the pick was logged wrong
        // and no amount of event data settles it.
        if (params.side === "draw" && params.marketType !== "moneyline_3way") {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Error: side='draw' is only valid with marketType='moneyline_3way'. ` +
                  `The draw is a selectable outcome only on a three-way (1X2) price. ` +
                  `${DRAW_CONVENTION}`,
              },
            ],
            isError: true,
          };
        }

        if (
          (params.marketType === "moneyline" ||
            params.marketType === "moneyline_3way" ||
            params.marketType === "spread") &&
          params.side !== "home" &&
          params.side !== "away" &&
          params.side !== "draw"
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: marketType='${params.marketType}' requires side='home' or side='away', not '${params.side}'.`,
              },
            ],
            isError: true,
          };
        }

        if (
          (params.marketType === "total" || params.marketType === "player_prop") &&
          params.side !== "over" &&
          params.side !== "under"
        ) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: marketType='${params.marketType}' requires side='over' or side='under', not '${params.side}'.`,
              },
            ],
            isError: true,
          };
        }

        let statID = "points";
        if (params.marketType === "player_prop") {
          const catalog = OU_PROP_MARKETS[params.sport];
          const market = catalog.find(
            (m) => m.label.toLowerCase() === params.marketLabel!.toLowerCase()
          );
          if (!market) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `"${params.marketLabel}" is not a recognized prop market for ${params.sport.toUpperCase()}. Valid options: ${catalog.map((m) => m.label).join(", ")}`,
                },
              ],
              isError: true,
            };
          }
          statID = market.statID;
        }

        // ENTITY FOR A THREE-WAY DRAW IS `all`, NOT A TEAM. SGO's own market rows
        // read points-away-1ix5-ml3way-away / points-all-1ix5-ml3way-draw /
        // points-home-1ix5-ml3way-home: the two team sides carry their own slot and
        // the draw carries the game-wide slot, because a draw belongs to neither team.
        const entity =
          params.marketType === "player_prop"
            ? params.playerID!
            : params.marketType === "total"
              ? "all"
              : params.side === "draw"
                ? "all"
                : params.side;

        const oddID = buildOddID({
          statID,
          entity,
          // Soccer match lines settle on `reg`; player props stay on `game`.
          period:
            params.marketType === "player_prop"
              ? "full_game"
              : matchLinePeriodFor(params.sport),
          betType: MARKET_TYPE_CODE[params.marketType],
          side: params.side,
        });

        const leagueID = sgo.leagueIDFor(params.sport);
        const events = await sgo.getAllEvents({
          leagueID,
          eventIDs: params.eventID,
          finalized: true,
          oddIDs: oddID,
        });

        if (!events.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No FINALIZED event found for eventID "${params.eventID}". The game may not be over, or results may not be settled yet. Do not grade this pick until it is final.`,
              },
            ],
          };
        }

        const event = events[0];

        // ---- IS IT ACTUALLY OVER? `finalized: true` is a request, not a promise ----
        //
        // Measured 2026-09-12: Pittsburgh @ UCF came back from this finalized-only
        // fetch while the game was in the 4th quarter, and was graded a confident
        // WIN off the current score. See services/eventStatus.ts for the full case.
        const finality = assessFinality(event);

        // ---- ADDED v2.8.12: ASK A SECOND FEED BEFORE REFUSING ON "UNKNOWN" ----
        //
        // The refusal above is correct and stays correct. What it was not is
        // FINISHED: SGO's status ingest lags the final whistle, so a game that
        // plainly ended sits in an unknown status for minutes while the grader
        // tells the user to come back later, over and over.
        //
        // BALLDONTLIE has the same game on a key with no monthly object cap. One
        // request per stuck event. It can only ever move unknown -> final, never
        // overturn CANCELLED or a live status, and it never supplies a score.
        // See services/eventStatus.ts for the three conditions it enforces.
        let crossCheckNote = "";
        let finalityResolved = finality.final;
        if (!finality.final && finality.label === "unknown") {
          const cross = await crossCheckFinality(bdl, params.sport, event);
          crossCheckNote = cross.note;
          finalityResolved = cross.resolved;
        }

        if (!finalityResolved) {
          const reason = crossCheckNote
            ? `${finality.reason}\n\n${crossCheckNote}`
            : finality.reason;
          return {
            content: [
              {
                type: "text" as const,
                text: `NOT GRADED - ${reason}`,
              },
            ],
            structuredContent: {
              result: "NOT_FINAL",
              eventID: event.eventID,
              statusLabel: finality.label,
              reason,
              secondSourceChecked: crossCheckNote.length > 0,
            },
          };
        }

        // When the second source is what made this gradeable, SAY SO on the result.
        // A grade that contradicts SGO's own status field must never look like an
        // ordinary one; the reader has to be able to see where the finality came from.
        const finalitySource = !finality.final && crossCheckNote ? `\n\n${crossCheckNote}` : "";

        const homeScore = event.teams.home.score;
        const awayScore = event.teams.away.score;
        const homeName = event.teams.home.names?.long ?? "home";
        const awayName = event.teams.away.names?.long ?? "away";

        // ---- SOCCER MONEYLINE: a level score is a RESULT, not a push ----
        //
        // Routed before the generic moneyline branch on purpose. gradeMoneyline
        // returns PUSH on equal scores, which is right everywhere else in this
        // connector and wrong in the sport where a draw is the most common single
        // scoreline. See services/pickGrader.ts for the two-way refusal.
        if (
          (params.marketType === "moneyline" || params.marketType === "moneyline_3way") &&
          hasDrawOutcome(params.sport)
        ) {
          if (homeScore === undefined || awayScore === undefined) {
            return {
              content: [
                { type: "text" as const, text: "Final scores unavailable - grade manually." },
              ],
            };
          }
          const graded = gradeSoccerMoneyline({
            side: params.side as "home" | "away" | "draw",
            homeScore,
            awayScore,
            threeWay: params.marketType === "moneyline_3way",
            pickedName: params.side === "home" ? homeName : awayName,
            opponentName: params.side === "home" ? awayName : homeName,
          });

          if (graded.kind === "refused") {
            return {
              content: [{ type: "text" as const, text: `NOT GRADED - ${graded.reason}` }],
              structuredContent: {
                result: "NEEDS_MANUAL_REVIEW",
                marketType: params.marketType,
                side: params.side,
                finalScore: `${awayScore} - ${homeScore} (away - home)`,
                reason: graded.reason,
                eventID: event.eventID,
              },
            };
          }

          const soccerOutput = {
            result: graded.result,
            marketType: params.marketType,
            side: params.side,
            finalScore: `${awayScore} - ${homeScore} (away - home)`,
            explanation: graded.explanation,
            drawConvention: DRAW_CONVENTION,
            eventID: event.eventID,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `${graded.result}: ${graded.explanation}${finalitySource}\n\n${JSON.stringify(soccerOutput, null, 2)}`,
              },
            ],
            structuredContent: soccerOutput,
          };
        }

        // ---- Moneyline: compare final scores directly, no line involved ----
        if (params.marketType === "moneyline") {
          if (homeScore === undefined || awayScore === undefined) {
            return {
              content: [
                { type: "text" as const, text: "Final scores unavailable - grade manually." },
              ],
            };
          }
          const result = gradeMoneyline({
            side: params.side as "home" | "away",
            homeScore,
            awayScore,
          });
          const output = {
            result,
            marketType: params.marketType,
            side: params.side,
            finalScore: `${awayScore} - ${homeScore} (away - home)`,
            eventID: event.eventID,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `${result}: ${params.side} moneyline, final ${awayName} ${awayScore} - ${homeName} ${homeScore}.${finalitySource}\n\n${JSON.stringify(output, null, 2)}`,
              },
            ],
            structuredContent: output,
          };
        }

        // ---- Spread: graded from the MARGIN, never from a team's own score ----
        //
        // This branch deliberately does not read odd.score. For a spread the oddID
        // is points-<side>-game-sp-<side>, so score is that team's own points - 62
        // for the home side of a 62-13 game. Comparing it to the spread number is
        // what produced fifteen flipped results. The two team scores are the honest
        // source and they are already right here.
        if (params.marketType === "spread") {
          if (homeScore === undefined || awayScore === undefined) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Final scores unavailable, so no margin can be computed. A spread cannot be graded without both scores - grade manually.",
                },
              ],
            };
          }

          const side = params.side as "home" | "away";
          const graded = gradeSpread({
            side,
            homeScore,
            awayScore,
            line: params.postedLine!,
            pickedName: side === "home" ? homeName : awayName,
            opponentName: side === "home" ? awayName : homeName,
          });

          const output = {
            result: graded.result,
            marketType: params.marketType,
            side: params.side,
            team: side === "home" ? homeName : awayName,
            actualValue: graded.margin,
            actualValueMeaning: "margin of victory for the picked team, negative if it lost",
            margin: graded.margin,
            adjustedMargin: graded.adjustedMargin,
            finalScore: `${awayName} ${awayScore} - ${homeName} ${homeScore}`,
            lineGradedAgainst: params.postedLine,
            signConvention: SPREAD_SIGN_CONVENTION,
            explanation: graded.explanation,
            eventID: event.eventID,
          };

          return {
            content: [
              {
                type: "text" as const,
                text: `${graded.result}: ${graded.explanation}${finalitySource}\n\n${JSON.stringify(output, null, 2)}`,
              },
            ],
            structuredContent: output,
          };
        }

        // ---- Total and player prop: settled value against the posted line ----
        const odd = event.odds?.[oddID] as Record<string, unknown> | undefined;

        if (!odd) {
          // Distinguish a wrong playerID from a genuinely unsettled market before
          // telling the reader to go grade it by hand. The roster is right here.
          const idDiagnosis =
            params.marketType === "player_prop" && params.playerID
              ? diagnosePlayerIdMiss(event, params.playerID, params.marketLabel).message
              : null;
          return {
            content: [
              {
                type: "text" as const,
                text:
                  idDiagnosis ??
                  `Event is final but no settlement data was returned for this market (${oddID}). Grade this one manually rather than guessing.`,
              },
            ],
          };
        }

        const scoreRaw = odd.score;
        const actual = typeof scoreRaw === "string" ? parseFloat(scoreRaw) : (scoreRaw as number);

        if (actual === undefined || actual === null || Number.isNaN(actual)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Event is final but SGO returned no result value for this market. Grade manually.`,
              },
            ],
          };
        }

        const side = params.side as "over" | "under";
        const lineUsed = params.postedLine!;
        const label = params.playerName
          ? `${params.playerName} ${side.toUpperCase()} ${lineUsed} ${params.marketLabel ?? ""}`.trim()
          : `${params.marketType} ${side} ${lineUsed}`;

        // ---- Player prop: participation is RESOLVED, not flagged ----
        //
        // A zero in odd.score is a DNP and a real zero at the same time. Rather
        // than warn on every one of them, ask the box score, using the same
        // three-way discriminator the hit-rate path already relies on.
        if (params.marketType === "player_prop") {
          const outcome = gradePlayerProp({
            lookup: lookupPlayerStat(event, params.playerID!, statID),
            fallbackScore: actual,
            side,
            line: lineUsed,
            playerLabel: params.playerName ?? params.playerID ?? "this player",
            sport: params.sport,
          });

          const propOutput = {
            result: outcome.result ?? (outcome.kind === "void" ? "VOID" : "NO_DATA"),
            marketType: params.marketType,
            side: params.side,
            player: params.playerName ?? params.playerID,
            market: params.marketLabel,
            actualValue: outcome.value,
            lineGradedAgainst: lineUsed,
            gradedAgainstPostedLine: true,
            participationResolved: outcome.kind !== "unresolved",
            note: outcome.note,
            eventID: event.eventID,
          };

          const headline =
            outcome.kind === "void"
              ? `VOID: ${label}`
              : outcome.kind === "unsettled"
                ? `NOT GRADED: ${label}`
                : `${outcome.result}: ${label} - actual result ${outcome.value}.`;

          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${headline}` +
                  (outcome.note ? `\n\n${outcome.note}` : "") +
                  finalitySource +
                  `\n\n${JSON.stringify(propOutput, null, 2)}`,
              },
            ],
            structuredContent: propOutput,
          };
        }

        const result = gradeOverUnder({ side, actual, line: lineUsed });

        const output = {
          result,
          marketType: params.marketType,
          side: params.side,
          market: params.marketLabel,
          actualValue: actual,
          lineGradedAgainst: lineUsed,
          gradedAgainstPostedLine: true,
          eventID: event.eventID,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${result}: ${label} - actual result ${actual}.${finalitySource}\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error grading pick: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
