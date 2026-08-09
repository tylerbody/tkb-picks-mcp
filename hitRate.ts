import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { getPlayerHitRate } from "../services/hitRateAggregator.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

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

export function registerHitRateTool(server: McpServer, sgo: SGOClient) {
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
