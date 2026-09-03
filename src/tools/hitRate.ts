import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { BDLClient } from "../services/bdlClient.js";
import {
  getPlayerHitRate,
  PRIOR_SEASON_LOOKBACK,
} from "../services/hitRateAggregator.js";
import {
  getCfbdPlayerHitRate,
  deriveCfbdTeamName,
} from "../services/cfbdHitRateAggregator.js";
import { isCfbdStatSupported } from "../services/cfbdStatMap.js";
import type { CFBDClient } from "../services/cfbdClient.js";
import { currentSeason } from "../services/seasonBoundary.js";
import {
  getBdlPlayerHitRate,
  priorSeasonBdlLookback,
} from "../services/bdlHitRateAggregator.js";
import { isStatSupported } from "../services/bdlStatMap.js";
import { SUPPORTED_SPORTS, supportsCapability, unsupportedMessage, type SportKey } from "../constants.js";

const HitRateInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    teamID: z
      .string()
      .describe(
        "The player's current team ID (SGO teamID), e.g. 'COLORADO_NCAAF'. Get this from tkb_get_odds or tkb_get_schedule output. FOR CFB, ALSO PASS teamName - CollegeFootballData keys its box scores by team NAME, not by SGO teamID, and a teamID alone has to be converted by a best-effort derivation that cannot cover every program."
      ),
    playerID: z.string().describe("SGO playerID for the player being checked."),
    playerName: z.string().describe("Player's display name, for output labeling."),
    teamName: z
      .string()
      .optional()
      .describe(
        "CFB ONLY, and STRONGLY RECOMMENDED there. The team's display name exactly as CollegeFootballData writes it, e.g. 'Colorado', 'Ole Miss', 'Miami (OH)', 'Texas A&M'. Use the homeTeam/awayTeam string from tkb_get_schedule. CFBD matches box scores on team NAME; passing only an SGO teamID like 'COLORADO_NCAAF' makes the server derive a name, which works for most programs and silently misses on the awkward ones. Ignored for every other sport, which key on teamID."
      ),
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
      .enum(["auto", "bdl", "sgo", "cfbd"])
      .default("auto")
      .describe(
        "Which provider computes the rate. 'auto' (default) tries BALLDONTLIE first and falls back to SportsGameOdds - BDL has no monthly object cap, so it is roughly 20x cheaper. For CFB, 'auto' uses CollegeFootballData, because SGO carries CFB games but NOT CFB player box scores outside the playoff (measured 2026-08-31: Dante Moore had 3 box scores across 15 started games) and BDL gates NCAAF stats behind GOAT. 'sgo' forces the original path. 'cfbd' forces CollegeFootballData."
      ),
    includePriorSeason: z
      .boolean()
      .default(false)
      .describe(
        "Widen the lookback to its 400-day ceiling so the PREVIOUS season is in range. Use in the OPENING WEEKS of a season, when the default window sits in empty offseason and returns nothing. ONE FLAG RATHER THAN RAW NUMBERS on purpose: raising lookbackGames alone is clamped to a 225-day window that reaches the playoffs and misses the regular season, which looks like it worked. Every rate returned will carry the prior-season warning, and that language is mandatory in the thread. Turn it off once the current season is 4 to 6 games old."
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

export function registerHitRateTool(
  server: McpServer,
  sgo: SGOClient,
  bdl: BDLClient,
  cfbd: CFBDClient | null
) {
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

        // ---- CFB ROUTES TO CollegeFootballData, AND HAS TO ----
        //
        // This is not a preference. Measured 2026-08-31 across two teams: SGO
        // returned every 2025 team game but a box score for almost none of them.
        // Dante Moore, who started all 15 games for Oregon, had a settled passing
        // line in 3 - the three playoff games. Maddux Madsen: 1 of 14, also a
        // playoff game. SGO carries CFB GAMES but not CFB PLAYER BOX SCORES outside
        // the postseason, and BALLDONTLIE gates NCAAF player stats behind GOAT.
        //
        // Falling back to SGO here would not degrade cost, it would manufacture a
        // wrong answer: those empty games read as DNPs and produced a 0.2 play rate
        // for a returning starter. So a missing CFBD key REFUSES rather than falls
        // back, per the rule this connector is built on - an unanswerable question
        // gets a refusal, not a plausible answer.
        const wantsCfbd =
          params.sport === "cfb" && params.dataSource !== "sgo" && params.dataSource !== "bdl";

        if (wantsCfbd) {
          if (!cfbd) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `CFB HIT RATES ARE UNAVAILABLE: CFBD_API_KEY is not set on this ` +
                    `server, so CollegeFootballData cannot be reached.\n\n` +
                    `This does NOT fall back to SportsGameOdds, deliberately. SGO carries ` +
                    `CFB games but not CFB player box scores outside the playoff, so the ` +
                    `fallback would report started games as DNPs and return a confident ` +
                    `wrong number rather than no number.\n\n` +
                    `Set CFBD_API_KEY in the environment (free tier at ` +
                    `collegefootballdata.com/key), or build this thread from ` +
                    `tkb_get_prop_board and tkb_get_game_lines, which need no rate source.`,
                },
              ],
            };
          }
          if (!isCfbdStatSupported(params.statID)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `"${params.statID}" has no CollegeFootballData mapping, so no CFB hit ` +
                    `rate can be counted for it. Do NOT substitute a value or fall back ` +
                    `to SGO, which has no CFB box scores outside the playoff.`,
                },
              ],
            };
          }

          // ---- CFBD KEYS BOX SCORES BY TEAM NAME, NOT BY SGO teamID ----
          //
          // This line used to read `teamName: params.teamID`, which handed
          // "COLORADO_NCAAF" to a matcher comparing it against CFBD's "Colorado".
          // Exact normalised compare, never equal, player never resolved, and the
          // tool returned NO SAMPLE for every CFB player ever asked for. See the
          // long note above deriveCfbdTeamName for the measured case.
          //
          // An explicit teamName wins. The derivation is a fallback, and whichever
          // name was used is REPORTED below whenever the lookup comes back empty,
          // so a name mismatch can never again masquerade as an absent player.
          const explicitTeamName = params.teamName?.trim();
          const cfbdTeamName = explicitTeamName || deriveCfbdTeamName(params.teamID);
          const teamNameWasDerived = !explicitTeamName;

          const thisSeason = currentSeason("cfb").seasonYear;
          const cfbdResult = await getCfbdPlayerHitRate(cfbd, {
            teamName: cfbdTeamName,
            playerName: params.playerName,
            statID: params.statID,
            line: params.line,
            direction: params.direction,
            // In the opening weeks the current season has nothing to count, so the
            // prior season is the only sample that exists. Labelled, never hidden.
            seasons: params.includePriorSeason
              ? [thisSeason, thisSeason - 1]
              : [thisSeason],
            targetAppearances: params.lookbackGames,
          });

          return {
            content: [
              {
                type: "text" as const,
                text:
                  (cfbdResult.sampleWarning ? `${cfbdResult.sampleWarning}\n\n` : "") +
                  `${cfbdResult.playerName}: ${cfbdResult.gamesHit} of ` +
                  `${cfbdResult.gamesConsidered} ${params.direction} ${params.line} ` +
                  `${params.statID}\n\n` +
                  `Source: CollegeFootballData` +
                  (cfbdResult.matchedFields.length
                    ? ` (read from ${cfbdResult.matchedFields.join(", ")})`
                    : "") +
                  `.\n\nNOTE: ${cfbdResult.recentAvailability.note}` +
                  // NAME THE TEAM ACTUALLY SEARCHED WHEN NOTHING RESOLVED. An empty
                  // CFB sample has two very different causes - the player really
                  // recorded nothing, or the team string never matched - and only
                  // one of them is about the player. Stating it turns a silent miss
                  // into a one-line fix.
                  (cfbdResult.cfbdPlayerID === null
                    ? `\n\nTEAM SEARCHED: "${cfbdTeamName}"` +
                      (teamNameWasDerived
                        ? ` - DERIVED from teamID "${params.teamID}" because no teamName ` +
                          `was passed. CollegeFootballData keys box scores by team NAME. ` +
                          `If that derived name is wrong for this program, pass teamName ` +
                          `explicitly (CFBD writes "Ole Miss", "Miami (OH)", "Texas A&M", ` +
                          `"Hawai'i") and retry BEFORE concluding this player has no history.`
                        : ` - passed explicitly, so the name is not the problem. This ` +
                          `player recorded no ${params.statID} in any scanned week.`)
                    : "") +
                  `\n\n` +
                  JSON.stringify(cfbdResult, null, 2),
              },
            ],
            structuredContent: {
              ...cfbdResult,
              cfbdTeamNameSearched: cfbdTeamName,
              cfbdTeamNameWasDerived: teamNameWasDerived,
            },
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
              // BDL bounds its window BOTH by days and by season. Widening only the
              // days would still ask the current season for games it has not played.
              ...(params.includePriorSeason ? priorSeasonBdlLookback(params.sport) : {}),
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
            const sgoFallback = await getPlayerHitRate(sgo, {
              ...params,
              // Both numbers or neither - a half-applied widening lands on a
              // 225-day window that reaches the playoffs and misses the season.
              ...(params.includePriorSeason ? PRIOR_SEASON_LOOKBACK : {}),
            });
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

        const result = await getPlayerHitRate(sgo, {
          ...params,
          ...(params.includePriorSeason ? PRIOR_SEASON_LOOKBACK : {}),
        });

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
