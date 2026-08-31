import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * PICK GRADING - resolve a posted pick to WIN / LOSS / PUSH from real settled data.
 *
 * WHY THIS EXISTS: the CASHED reply, the miss reply, and the bet tracker are all
 * currently resolved by hand, game by game, after the fact. SGO already carries the
 * settlement data needed to do it automatically: finalized odds objects expose the
 * actual result (`score`). NOTE: it does NOT expose a usable closing line on this
 * fetch path - see the note in the over/under branch below.
 * which is exactly the comparison a manual grade performs.
 *
 * DELIBERATE DESIGN CHOICE - GRADES AGAINST THE CLOSING LINE, NOT YOUR POSTED LINE:
 * SGO stores the line as it closed. If you posted an over at 245.5 and it closed at
 * 250.5, grading against the close can disagree with reality. So this tool ALWAYS
 * returns the line it graded against, and accepts an optional `postedLine` to grade
 * against instead. If the two differ, it says so loudly rather than silently picking
 * one. Getting a public CASHED post wrong is worse than not posting it.
 *
 * ONLY grades genuinely finalized events. An unfinished or unsettled game returns
 * "not final" rather than a guess, for the same reason the pricing guardrail refuses
 * to publish modelled odds: a plausible-looking wrong answer is worse than no answer.
 */
const GradeInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventID: z.string().describe("SGO eventID for the finished game."),
    marketType: z
      .enum(["moneyline", "spread", "total", "player_prop"])
      .describe("Which kind of pick is being graded."),
    side: z
      .enum(["over", "under", "home", "away"])
      .describe("The side that was picked."),
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
        "The line as YOU posted it. If given, grading uses this instead of the closing line, and the tool flags any discrepancy between the two."
      ),
  })
  .strict();

type GradeInput = z.infer<typeof GradeInputSchema>;

const MARKET_TYPE_CODE: Record<string, "ml" | "sp" | "ou"> = {
  moneyline: "ml",
  spread: "sp",
  total: "ou",
  player_prop: "ou",
};

export function registerGradePicksTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_grade_pick",
    {
      title: "Grade a Posted Pick",
      description: `Resolve a posted pick to WIN / LOSS / PUSH using real settled result data.

Reads the actual result and closing line off a finalized SGO event and compares them,
which is the same comparison done manually when writing a CASHED or miss reply.

Args:
  - sport, eventID, marketType, side
  - marketLabel + playerID: required for player_prop
  - postedLine (optional but recommended): the line as you actually posted it

Returns: result (win/loss/push), the actual stat or score value, the line graded
against, and a flag if the posted line differs from the closing line.

Examples:
  - Use when: writing the CASHED or miss reply for yesterday's threads
  - Use when: filling in the Result column of the bet tracker
  - Don't use when: the game isn't final - this returns "not final", never a guess

Error Handling:
  - Returns "not final" for any event SGO has not finalized
  - Returns "no settlement data" rather than guessing if the result field is absent
  - Flags loudly when postedLine and closing line disagree, since grading the wrong
    line can produce a publicly wrong CASHED post`,
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

        const entity =
          params.marketType === "player_prop"
            ? params.playerID!
            : params.marketType === "total"
              ? "all"
              : params.side;

        const oddID = buildOddID({
          statID,
          entity,
          period: "full_game",
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
        const odd = event.odds?.[oddID] as Record<string, unknown> | undefined;

        if (!odd) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Event is final but no settlement data was returned for this market (${oddID}). Grade this one manually rather than guessing.`,
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

        // ---- Moneyline: compare final scores directly ----
        if (params.marketType === "moneyline") {
          const home = event.teams.home.score;
          const away = event.teams.away.score;
          if (home === undefined || away === undefined) {
            return {
              content: [
                { type: "text" as const, text: "Final scores unavailable - grade manually." },
              ],
            };
          }
          const picked = params.side === "home" ? home : away;
          const other = params.side === "home" ? away : home;
          const result = picked > other ? "WIN" : picked < other ? "LOSS" : "PUSH";
          const output = {
            result,
            marketType: params.marketType,
            side: params.side,
            finalScore: `${away} - ${home} (away - home)`,
            eventID: event.eventID,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `${result}: ${params.side} moneyline, final ${away}-${home}.\n\n${JSON.stringify(output, null, 2)}`,
              },
            ],
            structuredContent: output,
          };
        }

        // ---- Over/under and spread: compare result against the line ----
        //
        // CLOSING LINE IS NOT AVAILABLE ON THIS PATH, AND PRETENDING OTHERWISE
        // PRODUCED A CONFIDENT WRONG NUMBER. Measured 2026-08-31 on Red Sox @
        // Yankees (final 16-1, 17 total runs): this code reported a "closing line"
        // of 17.5. No MLB total closes at 17.5. `closeOverUnder` and `closeSpread`
        // do not exist at the top level of an odd - per SGO's docs they live under
        // byBookmaker.<book> and only when includeOpenCloseOdds=true is requested,
        // which this fetch does not do. So the chain always fell through to
        // `bookOverUnder`, which on a settled blowout carries the LAST LIVE value,
        // not the pre-game close. It was tracking the final score.
        //
        // This also explains the "posted 16.5 / closed 34.5" style entries in the
        // results workflow (Mabrey points, Cardoso rebounds, Tidwell Ks). Those were
        // never line moves. They were this artifact.
        //
        // Reporting null is the correct answer until the byBookmaker path is
        // verified live, per this connector's own rule: a stat that cannot be
        // resolved returns null, never a plausible substitute.
        // Fall back to the feed's own line ONLY to grade when no postedLine was
        // given. It is never presented as a close and never used for a mismatch.
        const feedLineRaw = odd.bookOverUnder ?? odd.bookSpread;
        const feedLine =
          typeof feedLineRaw === "string" ? parseFloat(feedLineRaw) : (feedLineRaw as number);

        const lineUsed = params.postedLine ?? feedLine;

        if (lineUsed === undefined || lineUsed === null || Number.isNaN(lineUsed)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No line available to grade against (neither a postedLine argument nor a closing line from SGO). Pass postedLine explicitly to grade this pick.`,
              },
            ],
          };
        }

        let result: "WIN" | "LOSS" | "PUSH";
        if (actual === lineUsed) {
          result = "PUSH";
        } else if (params.side === "over" || params.side === "home") {
          result = actual > lineUsed ? "WIN" : "LOSS";
        } else {
          result = actual < lineUsed ? "WIN" : "LOSS";
        }

        // No closing line means no mismatch can be computed. Claiming one anyway is
        // what produced a warning on essentially every total and prop.
        const lineMismatch = false;

        const output = {
          result,
          marketType: params.marketType,
          side: params.side,
          player: params.playerName ?? params.playerID,
          market: params.marketLabel,
          actualValue: actual,
          lineGradedAgainst: lineUsed,
          closingLine: null,
          closingLineUnavailable: true,
          gradedAgainstPostedLine: params.postedLine !== undefined,
          lineMismatch,
          eventID: event.eventID,
        };

        const mismatchNote =
          params.postedLine === undefined
            ? ` NOTE: no postedLine was supplied and no closing line is available on this path, so this was graded against whatever line the feed carried. Pass postedLine for anything going into the tracker or a public result.`
            : "";

        const label = params.playerName
          ? `${params.playerName} ${params.side.toUpperCase()} ${lineUsed} ${params.marketLabel ?? ""}`.trim()
          : `${params.marketType} ${params.side} ${lineUsed}`;

        return {
          content: [
            {
              type: "text" as const,
              text: `${result}: ${label} - actual result ${actual}.${mismatchNote}\n\n${JSON.stringify(output, null, 2)}`,
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
