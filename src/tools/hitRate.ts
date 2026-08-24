import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { BDLClient } from "../services/bdlClient.js";
import { getPlayerHitRate } from "../services/hitRateAggregator.js";
import { getBdlPlayerHitRate } from "../services/bdlHitRateAggregator.js";
import { isStatSupported } from "../services/bdlStatMap.js";
import { SUPPORTED_SPORTS, supportsCapability, unsupportedMessage, type SportKey } from "../constants.js";

const HitRateInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    teamID: z
      .string()
      .describe(
        "The player's current team ID (SGO teamID). Get this from tkb_get_odds or tkb_get_schedule output."
      ),
    playerID: z.string().describe("SGO playerID for the player being checked."),
    playerName: z.string().describe("Player's display name, for output labeling."),
    statID: z
      .string()
      .describe("The statID to check (e.g. 'batting_hits', 'points', 'passing_yards')."),
    line: z.number().describe("The prop line to check against, e.g. 0.5, 7.5, 24.5."),
    direction: z
      .enum(["over", "under"])
      .describe("Whether checking how often the player went OVER or UNDER the line."),
    lookbackGames: z
      .number()
      .int()
      .min(1)
      .max(40)
      .optional()
      .describe(
        "How many games the PLAYER ACTUALLY APPEARED IN to collect (not team games). The server scans backward through team games until it has this many real appearances. Defaults by role: 10 for starting pitchers, 15 for batters, 12 for skaters. For a starting pitcher this may scan ~5x this many team games."
      ),
    dataSource: z
      .enum(["auto", "bdl", "sgo"])
      .default("auto")
      .describe(
        "Which provider computes the rate. 'auto' (default) tries BALLDONTLIE first and falls back to SportsGameOdds - BDL has no monthly object cap, so it is roughly 20x cheaper. 'sgo' forces the original path. Results are equivalent; only cost and DNP visibility differ."
      ),
    maxTeamGamesScanned: z
      .number()
      .int()
      .min(10)
      .max(200)
      .optional()
      .describe(
        "Safety ceiling on how many team games to scan before giving up. Prevents a season-ending injury from triggering a full-history crawl. Defaults by role: 140 for starting pitchers, 30 for batters."
      ),
  })
  .strict();

type HitRateInput = z.infer<typeof HitRateInputSchema>;

export function registerHitRateTool(server: McpServer, sgo: SGOClient, bdl: BDLClient) {
  server.registerTool(
    "tkb_get_player_hit_rate",
    {
      title: "Get Player Hit Rate",
      description: `Check how often a player has cleared a specific stat line across their recent games.

This pulls the player's team's recent finalized games and reads the player's actual
stat value from each one, so the result is a REAL counted sample - never a fixed
window and never padded/estimated. Games where the player didn't play (DNP/inactive)
are excluded from the count, not treated as a miss.

Args:
  - sport, teamID, playerID, playerName, statID, line, direction
  - lookbackGames (default 10): how many recent games to pull before DNP filtering

Returns: gamesConsidered (true sample size), gamesHit, gamesExcludedDNP, the full
game-by-game log, and SEASON PROVENANCE - how many counted games came from the
current season vs a prior one, plus a warning when the sample crosses that boundary.

LOG ORDERING - READ THIS BEFORE DESCRIBING ANY STREAK: the log is NEWEST FIRST.
log[0] is the most recent appearance. Reading it backwards has already produced a
published error, turning a 7-total-base game from last night into "held to zero in
five consecutive starts". Every number was right; only the direction was assumed.
Each entry carries its own date - cite the date, never the position.

WHY SEASON PROVENANCE MATTERS: the lookback window is a rolling date range, so early
in a season it reaches back into the previous one. A hit rate built entirely on last
season's games is NOT current form, and writing it up as though it were is misleading.
When the warning fires, either report only current-season games or say "last season"
explicitly in the reasoning bullet. This matters most in NFL Weeks 1-3 and for any
player who changed teams, role, or scheme in the offseason.

Examples:
  - Use when: "How often has Semien gone over 0.5 hits lately?" -> statID="batting_hits", line=0.5, direction="over"
  - Don't use when: you need the CURRENT odds for this prop - use tkb_get_odds instead
  - Don't use when: you don't have the player's SGO teamID/playerID yet - get those from tkb_get_odds first

Error Handling:
  - If gamesConsidered is 0, all recent games were DNP - flag this rather than reporting a hit rate
  - Report gamesExcludedDNP explicitly so it's clear the sample size reflects only games actually played
  - If seasonWarning is non-null, do NOT present the number as current-season form`,
      inputSchema: HitRateInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: HitRateInput) => {
      try {
        // Guard BEFORE routing. isStatSupported is already false for tennis, so
        // without this the call would fall straight through to the SGO path,
        // which needs a teamID and playerID that tennis events do not carry.
        if (!supportsCapability(params.sport, "hitRates")) {
          return {
            content: [
              { type: "text" as const, text: unsupportedMessage(params.sport, "hitRates") },
            ],
          };
        }

        // ---- BDL-FIRST ROUTING ----
        // SGO bills per event object and a hit rate needs a whole team history,
        // so one thread measured at 211 entities and daily builds projected over
        // the 100,000 monthly cap. BDL has no object cap and returns per-player
        // rows directly. Try it first, fall back silently on any failure so a BDL
        // outage degrades cost rather than correctness.
        const canUseBdl =
          params.dataSource !== "sgo" && isStatSupported(params.sport, params.statID);

        if (canUseBdl) {
          try {
            const bdlResult = await getBdlPlayerHitRate(bdl, {
              sport: params.sport,
              playerName: params.playerName,
              statID: params.statID,
              line: params.line,
              direction: params.direction,
              lookbackGames: params.lookbackGames,
            });

            const chosen = bdlResult.gamesHit;
            const other =
              params.direction === "over" ? bdlResult.underHits : bdlResult.overHits;
            const otherLabel = params.direction === "over" ? "under" : "over";

            const provenance =
              `\n\nSource: BALLDONTLIE (no object quota consumed).` +
              (bdlResult.statSource
                ? ` Stat read from field "${bdlResult.statSource}".`
                : "") +
              (bdlResult.resolutionNote ? ` ${bdlResult.resolutionNote}` : "") +
              (bdlResult.recentAvailability.note
                ? `\n\nNOTE: ${bdlResult.recentAvailability.note}`
                : "");

            if (!bdlResult.sampleSufficient) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `${bdlResult.sampleWarning}\n\n` +
                      `${params.playerName} | ${params.statID} ${params.direction} ${params.line}\n` +
                      `Appearances found: ${bdlResult.gamesConsidered}${provenance}\n\n` +
                      JSON.stringify(bdlResult, null, 2),
                  },
                ],
                structuredContent: bdlResult,
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `${bdlResult.playerName}: ${chosen} of ${bdlResult.gamesConsidered} ` +
                    `(real counted sample)\n` +
                    `Other side for reference: ${otherLabel} hit ${other} of ${bdlResult.gamesConsidered}` +
                    (bdlResult.pushCount > 0
                      ? ` | ${bdlResult.pushCount} push(es) on this whole-number line`
                      : "") +
                    (bdlResult.seasonWarning ? `\n\nSEASON WARNING: ${bdlResult.seasonWarning}` : "") +
                    `${provenance}\n\n${JSON.stringify(bdlResult, null, 2)}`,
                },
              ],
              structuredContent: bdlResult,
            };
          } catch (bdlErr) {
            // Fall through to SGO. The reason is surfaced so a persistent BDL
            // problem (tier gate, bad field mapping, ambiguous name) is visible
            // rather than quietly costing quota on every call.
            const reason = bdlErr instanceof Error ? bdlErr.message : String(bdlErr);
            const sgoFallback = await getPlayerHitRate(sgo, params);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `FELL BACK TO SPORTSGAMEODDS. BALLDONTLIE could not serve this: ${reason}\n\n` +
                    `${sgoFallback.playerName}: ${sgoFallback.gamesHit} of ${sgoFallback.gamesConsidered} ` +
                    `(${sgoFallback.gamesExcludedDNP} DNP excluded, ${sgoFallback.teamGamesScanned} team games scanned)\n\n` +
                    `This path consumes SGO object quota. If it keeps happening, run ` +
                    `tkb_debug_bdl_stats to check tier access and field names.\n\n` +
                    JSON.stringify(sgoFallback, null, 2),
                },
              ],
              structuredContent: sgoFallback,
            };
          }
        }

        const result = await getPlayerHitRate(sgo, params);

        if (!result.sampleSufficient) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${result.sampleWarning}\n\n` +
                  `${params.playerName} | ${params.statID} ${params.direction} ${params.line}\n` +
                  `Appearances found: ${result.gamesConsidered} across ${result.teamGamesScanned} team games scanned.\n\n` +
                  JSON.stringify(result, null, 2),
              },
            ],
            structuredContent: result,
          };
        }

        const chosenHits = result.gamesHit;
        const otherHits =
          params.direction === "over" ? result.underHits : result.overHits;
        const otherLabel = params.direction === "over" ? "under" : "over";

        const summary =
          `${result.playerName}: ${chosenHits} of ${result.gamesConsidered} ` +
          `(real sample, ${result.gamesExcludedDNP} game(s) excluded as DNP, ` +
          `${result.teamGamesScanned} team games scanned)\n` +
          `Other side for reference: ${otherLabel} hit ${otherHits} of ${result.gamesConsidered}` +
          (result.pushCount > 0 ? ` | ${result.pushCount} push(es) on this whole-number line` : "");

        const seasonLine = result.seasonWarning
          ? `\n\nSEASON WARNING: ${result.seasonWarning}`
          : result.seasonsRepresented.length
            ? `\n\nAll ${result.gamesConsidered} counted game(s) are from the ${result.seasonsRepresented[0]} season.`
            : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `${summary}${seasonLine}\n\n${JSON.stringify(result, null, 2)}`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error computing hit rate: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
