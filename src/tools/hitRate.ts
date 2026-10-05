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
import { CBBDClient } from "../services/cbbdClient.js";
import { getCbbdPlayerHitRate, deriveCbbdTeamName } from "../services/cbbdHitRateAggregator.js";
import { isCbbdStatSupported } from "../services/cbbdStatMap.js";
import { isCfbdStatSupported } from "../services/cfbdStatMap.js";
import type { CFBDClient } from "../services/cfbdClient.js";
import { currentSeason } from "../services/seasonBoundary.js";
import {
  getBdlPlayerHitRate,
  priorSeasonBdlLookback,
} from "../services/bdlHitRateAggregator.js";
import { isStatSupported } from "../services/bdlStatMap.js";
import { isBdlConfigured, BDL_UNAVAILABLE_MESSAGE } from "../services/bdlUnavailable.js";
import { EspnClient, ESPN_LEAGUE_PATHS } from "../services/espnClient.js";
import {
  getEspnPlayerHitRate,
  EspnRefusal,
} from "../services/espnHitRateAggregator.js";
import { isEspnStatSupported, espnStatUnavailableReason } from "../services/espnStatMap.js";
import { NHLStatsClient } from "../services/nhlStatsClient.js";
import { getNhlPlayerHitRate } from "../services/nhlHitRateAggregator.js";
import { allNhlClubCodes, nhlClubCode } from "../services/nhlTeams.js";
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
      .enum(["auto", "bdl", "sgo", "cfbd", "espn"])
      .default("auto")
      .describe(
        "Which provider computes the rate. CHANGED IN v2.17.0: 'auto' now uses ESPN's free public game log for NBA, NFL, WNBA, EPL and UCL. Measured 2026-10-05: ESPN is keyless, costs ZERO SportsGameOdds entities, carries multiple prior seasons (two complete NBA seasons confirmed), and labels preseason natively so a preseason game cannot contaminate a sample. Adopted because BALLDONTLIE prices PER SPORT, so every league added cost another subscription, and because the SGO key is a Rookie key whose MONTHLY entity cap makes hit rates, the heaviest consumer in this connector, the binding constraint. The v2.14.0 note that cost 'no longer applies' was written against a Pro key and is NO LONGER TRUE; do not treat SGO entities as free. Per-sport routing in 'auto', all measurements: NBA/NFL/WNBA/EPL/UCL use ESPN; CFB uses CollegeFootballData because SGO carries CFB games but NOT CFB player box scores outside the playoff; CBB uses CollegeBasketballData; NHL uses the free NHL API; MLB still uses SGO. 'espn' forces ESPN and is REFUSED BY NAME where it has no mapping. 'bdl' forces BALLDONTLIE, which has resolvers for MLB and WNBA ONLY and is refused by name elsewhere; BDL is preserved in full for a swap back. 'sgo' forces SportsGameOdds and SPENDS ENTITIES. Every answer reports statSourceUsed. WHAT ESPN CANNOT SERVE, each a named refusal rather than an empty rate: NFL kicking and punting (ESPN returns HTTP 200 with ZERO rows for kickers, measured on Tyler Bass), NFL bare 'touchdowns' and 'turnovers' (ambiguous definition, ask for rushing_touchdowns or receiving_touchdowns), basketball 'offensiveRebounds' (ESPN carries only totalRebounds), soccer 'minutesPlayed' (NO minutes column exists on either soccer shape, which also means a soccer rate cannot tell you whether a 20-minute substitute appearance and a 90-minute start are in the same sample, so read the team news), and soccer 'points' (unverified crossover against goals; ask for goals+assists)."
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
  cfbd: CFBDClient | null,
  cbbd: CBBDClient | null = null,
  // NOT optional in practice: the NHL feed needs no key, so there is no configuration
  // under which it is absent. Defaulted rather than required so the existing call
  // sites and tests keep compiling.
  nhl: NHLStatsClient = new NHLStatsClient(),
  // Needs no key, same as NHLStatsClient. Defaulted so existing call sites compile.
  espn: EspnClient = new EspnClient()
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
        // ---- HOCKEY GOES TO THE NHL'S OWN FEED, AND ONLY THERE ----
        //
        // NO KEY, NO QUOTA, TWO REQUESTS. Unlike CFB and CBB, this branch cannot fail
        // on a missing key, because there is no key: api-web.nhle.com is open. What it
        // CAN fail on is a name or a club code, and both are reported by name.
        //
        // WHY NOT BDL, WHICH EVERY OTHER PRO SPORT USES HERE: its tiers are per sport
        // and hockey player stats sit behind GOAT ($39.99/mo) with games behind
        // ALL-STAR. Routing hockey there would have shipped a feature that 401s.
        //
        // WHY NOT THE SGO FALLBACK: the same reason CFB and CBB refuse it. An SGO
        // event carries a hockey box score inconsistently, and an empty one reads as
        // a DNP - the exact mechanism that produced a returning starter at a 0.2 play
        // rate in v2.7.0.
        if (params.sport === "nhl" && params.dataSource !== "sgo" && params.dataSource !== "bdl") {
          const club = nhlClubCode(params.teamID);
          if (!club) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Could not resolve "${params.teamID}" to an NHL club.\n\n` +
                    `The NHL feed keys rosters and schedules on a THREE-LETTER CLUB CODE, and ` +
                    `this resolver accepts an SGO teamID, a full club name, or the code itself. ` +
                    `None matched.\n\n` +
                    `Valid codes: ${allNhlClubCodes().join(", ")}.\n\n` +
                    `This is a refusal rather than a best guess on purpose: a wrong club returns ` +
                    `a roster that does not contain the player, which reads as "he is not on this ` +
                    `team" and sends you looking in the wrong place.`,
                },
              ],
            };
          }

          try {
            const result = await getNhlPlayerHitRate(nhl, {
              playerName: params.playerName,
              teamAbbrev: club,
              statID: params.statID,
              line: params.line,
              direction: params.direction,
              targetAppearances: params.lookbackGames,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    (result.sampleWarning ? `${result.sampleWarning}\n\n` : "") +
                    `${result.playerName}: ${result.gamesHit} of ${result.gamesConsidered} ` +
                    `${params.direction} ${params.line} ${params.statID}` +
                    (result.matchedFields.length ? ` (read from ${result.matchedFields.join(", ")})` : "") +
                    `.\n\n` +
                    `Source: the NHL's own game log, season ${result.seasonId}. ` +
                    `${result.teamGamesPlayed} completed ${club} regular-season games in the denominator.` +
                    (result.recentAvailability.note ? `\n\nAVAILABILITY: ${result.recentAvailability.note}` : "") +
                    (result.seasonWarning ? `\n\n${result.seasonWarning}` : "") +
                    `\n\n` +
                    JSON.stringify(result, null, 2),
                },
              ],
              structuredContent: { ...result, nhlClubResolved: club },
            };
          } catch (err) {
            // A REFUSAL, NOT AN ERROR CARD. Every throw out of that aggregator is a
            // message written to be read: an unmapped stat names the mapped ones and
            // says whether the box score could serve it, and a name miss reports the
            // roster it searched and how many names were in it.
            return {
              content: [
                {
                  type: "text" as const,
                  text: err instanceof Error ? err.message : String(err),
                },
              ],
            };
          }
        }

        // ---- COLLEGE BASKETBALL GOES TO CollegeBasketballData, AND ONLY THERE ----
        //
        // Same rule as CFB, same reason, decided in advance rather than after an
        // outage. BALLDONTLIE gates NCAAB /player_stats behind GOAT for that sport,
        // and SGO carries college GAMES rather than college player box scores. A
        // fallback to SGO would not degrade the answer, it would manufacture one:
        // empty games read as DNPs, which is exactly what produced a returning
        // starter at a 0.2 play rate on the football side in v2.7.0.
        //
        // So a missing CBBD key REFUSES.
        const wantsCbbd =
          params.sport === "cbb" && params.dataSource !== "sgo" && params.dataSource !== "bdl";

        if (wantsCbbd) {
          if (!cbbd) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `COLLEGE BASKETBALL HIT RATES ARE UNAVAILABLE: CBBD_API_KEY is not set ` +
                    `on this server, so CollegeBasketballData cannot be reached.\n\n` +
                    `This does NOT fall back to SportsGameOdds or BALLDONTLIE, ` +
                    `deliberately. SGO carries college games but not college player box ` +
                    `scores, and BDL gates NCAAB player stats behind GOAT for that sport. ` +
                    `Either fallback would report played games as DNPs and return a ` +
                    `confident wrong number rather than no number.\n\n` +
                    `Set CBBD_API_KEY in the environment - a free key is issued at ` +
                    `collegebasketballdata.com/key, and note it is a SEPARATE key from ` +
                    `CFBD_API_KEY sharing the same monthly quota. Until then build CBB ` +
                    `threads from tkb_get_prop_board and tkb_get_game_lines, which need no ` +
                    `rate source.`,
                },
              ],
            };
          }
          if (!isCbbdStatSupported(params.statID)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `"${params.statID}" has no CollegeBasketballData mapping, so no CBB hit ` +
                    `rate can be counted for it. Do NOT substitute a value or fall back to ` +
                    `another source.`,
                },
              ],
            };
          }

          // CBBD KEYS BOX SCORES BY TEAM NAME, NOT BY SGO teamID. SGO writes
          // PURDUE_NCAAB; CBBD writes "Purdue". This is the v2.8.6 CFB bug waiting to
          // happen again, so the derivation and the report-what-was-searched behaviour
          // both ship from day one.
          const explicitCbbTeam = params.teamName?.trim();
          const cbbdTeamName = explicitCbbTeam || deriveCbbdTeamName(params.teamID);
          const cbbTeamWasDerived = !explicitCbbTeam;

          const cbbdResult = await getCbbdPlayerHitRate(cbbd, {
            teamName: cbbdTeamName,
            playerName: params.playerName,
            statID: params.statID,
            line: params.line,
            direction: params.direction,
            targetAppearances: params.lookbackGames,
          });

          return {
            content: [
              {
                type: "text" as const,
                text:
                  (cbbdResult.sampleWarning ? `${cbbdResult.sampleWarning}\n\n` : "") +
                  `${cbbdResult.playerName}: ${cbbdResult.gamesHit} of ` +
                  `${cbbdResult.gamesConsidered} ${params.direction} ${params.line} ` +
                  `${params.statID}\n\n` +
                  `Source: CollegeBasketballData` +
                  (cbbdResult.matchedFields.length
                    ? ` (read from ${cbbdResult.matchedFields.join(", ")})`
                    : "") +
                  `.\n\nNOTE: ${cbbdResult.recentAvailability.note}` +
                  (cbbdResult.cbbdAthleteID === null
                    ? `\n\nTEAM SEARCHED: "${cbbdTeamName}"` +
                      (cbbTeamWasDerived
                        ? ` - DERIVED from teamID "${params.teamID}" because no teamName was ` +
                          `passed. CollegeBasketballData keys box scores by team NAME, and a ` +
                          `name mismatch looks exactly like an absent player. If that derived ` +
                          `name is wrong for this program, pass teamName explicitly and retry ` +
                          `BEFORE concluding this player has no history.`
                        : ` - passed explicitly, so the name is not the problem. This player ` +
                          `logged no minutes in any scanned window.`)
                    : "") +
                  `\n\n` +
                  JSON.stringify(cbbdResult, null, 2),
              },
            ],
            structuredContent: {
              ...cbbdResult,
              cbbdTeamNameSearched: cbbdTeamName,
              cbbdTeamNameWasDerived: cbbTeamWasDerived,
            },
          };
        }

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

        /* ================= SGO-FIRST ROUTING, v2.14.0 =================
         *
         * THIS USED TO BE BDL-FIRST, for a reason that has stopped applying. The old
         * note read: SGO bills per event object, a hit rate needs a whole team history,
         * one thread measured at 211 entities, and daily builds projected over the
         * 100,000 monthly cap. Every word of that was true on the ROOKIE key.
         *
         * On the Pro key the cap is 3,000,000 entities a day and unlimited monthly.
         * Measured 2026-10-01: 1,552 of 3,000,000 used on the day, 186 of 250,000 on
         * the hour. The cost argument that made BDL the default is now two orders of
         * magnitude away from mattering.
         *
         * AND SGO'S BOX SCORES WERE VERIFIED, not assumed. On 2026-10-01 SGO's NFL
         * passing yards matched ESPN's independent game log exactly on three games
         * (153 / 264 / 203). That check is the whole basis for this inversion.
         *
         * WHAT BDL ACTUALLY COVERS, measured the same day: stat resolvers exist for
         * MLB (18) and WNBA (15) and NOTHING ELSE. Nine sports have zero. WNBA's are
         * 401-gated behind GOAT on this account. So BDL-first was, in practice, MLB
         * first and a silent no-op everywhere else.
         *
         * ---- THE SILENT NO-OP, WHICH IS THE REAL BUG FIXED HERE ----
         *
         * `canUseBdl` was `dataSource !== "sgo" && isStatSupported(...)`. Pass
         * `dataSource: "bdl"` on NFL and isStatSupported is false, so it fell straight
         * through to SGO and returned SGO data with no provenance and no warning.
         * Measured: two calls, one with dataSource "sgo" and one with "bdl", came back
         * BYTE-IDENTICAL including SGO event IDs inside the supposed BDL log. A
         * parameter that silently does nothing is worse than one that errors.
         *
         * So now: an EXPLICIT provider that cannot serve is REFUSED BY NAME, and every
         * answer says which provider produced it.
         *
         * BDL IS PRESERVED IN FULL, deliberately. Nothing below is deleted, the client
         * still ships, and `dataSource: "bdl"` still routes to it wherever resolvers
         * exist. If this account swaps back to a Rookie key the entity cap returns and
         * BDL-first becomes correct again; flipping SGO_FIRST_SPORTS back is then a
         * one-line change rather than a rebuild. */
        /* ======================================================================
         * ESPN, THE DEFAULT FOR NBA, NFL, WNBA, EPL AND UCL. ADDED v2.17.0.
         * ======================================================================
         *
         * Placed AFTER the NHL, CBB and CFB branches because each of those has its own
         * better free source, and BEFORE the BDL and SGO paths because on a Rookie key
         * SGO entities are the binding constraint and ESPN costs none.
         *
         * `dataSource: "sgo"` and `"bdl"` still skip this, so the old paths stay
         * reachable for a cross-check. That matters: a second independent source is how
         * the SGO box scores were verified in the first place.
         */
        const ESPN_AUTO_SPORTS: SportKey[] = ["nba", "nfl", "wnba", "epl", "ucl"];
        const espnWanted =
          params.dataSource === "espn" ||
          (params.dataSource === "auto" && ESPN_AUTO_SPORTS.includes(params.sport));

        if (espnWanted) {
          if (!ESPN_LEAGUE_PATHS[params.sport]) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `ESPN has no configured game-log path for ` +
                    `${params.sport.toUpperCase()}. Configured: ` +
                    `${Object.keys(ESPN_LEAGUE_PATHS).join(", ")}.`,
                },
              ],
              isError: true,
            };
          }

          /* REFUSE BEFORE ANY HTTP. An unmapped stat is a code-level fact, and the
           * aggregator would spend three requests to reach the same conclusion. */
          const espnReason = espnStatUnavailableReason(params.sport, params.statID);
          if (espnReason || !isEspnStatSupported(params.sport, params.statID)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `ESPN cannot serve a rate for ${params.sport.toUpperCase()} ` +
                    `"${params.statID}".\n\n` +
                    (espnReason ??
                      `That statID has no ESPN game-log mapping.`) +
                    `\n\nThis is a REFUSAL, not an empty result: an empty rate would ` +
                    `read as "he has not done it". Pass dataSource="sgo" to spend SGO ` +
                    `entities on it instead, if the market is worth the quota.`,
                },
              ],
              structuredContent: {
                ok: false,
                reason: "espn_cannot_serve",
                sport: params.sport,
                statID: params.statID,
              },
              isError: true,
            };
          }

          /* THE TEAM NAME, AND WHY teamName IS WORTH PASSING FOR SOCCER.
           * ESPN is resolved by team DISPLAY NAME, not by SGO teamID. Deriving
           * "buffalo bills" from BUFFALO_BILLS_NFL works; deriving "liverpool fc"
           * from LIVERPOOL_FC_EPL needs the club-form strip in
           * normaliseEspnTeamName to reach ESPN's "Liverpool". Passing teamName
           * explicitly skips the derivation entirely. */
          const espnTeamName =
            params.teamName ??
            params.teamID.replace(/_[A-Z]+$/, "").replace(/_/g, " ");

          try {
            const r = await getEspnPlayerHitRate(espn, {
              sport: params.sport,
              playerName: params.playerName,
              teamName: espnTeamName,
              statID: params.statID,
              line: params.line,
              direction: params.direction,
              targetAppearances: params.lookbackGames,
              /* Reaching back a season is ONE MORE FREE REQUEST here, versus a cost
               * multiplier on SGO. So it is on by default, and still labelled by
               * summarizeSeasons running on real dates. */
              allowPriorSeasons: true,
              maxSeasons: params.includePriorSeason ? 3 : 2,
            });

            const summary =
              `${params.playerName} | ${params.statID} ${params.direction} ${params.line}\n` +
              `${r.gamesHit} of ${r.gamesConsidered} appearance(s).` +
              (r.sampleWarning ? `\n\n${r.sampleWarning}` : "");

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `${summary}\n\nSource: ESPN public game log (${r.espnTeamName}, ` +
                    `athlete ${r.espnAthleteId}). FREE and keyless: this consumes ZERO ` +
                    `SportsGameOdds entities and zero BALLDONTLIE calls. Preseason is ` +
                    `excluded by ESPN's own season labelling, not by a maintained date ` +
                    `table.\n\n${JSON.stringify(r, null, 2)}`,
                },
              ],
              structuredContent: { ...r, statSourceUsed: "espn" },
            };
          } catch (err) {
            /* An EspnRefusal is a considered refusal, not a crash, and it carries the
             * reason. Surfaced as-is rather than reworded into something vaguer. */
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `ESPN could not produce a rate for ${params.playerName}.\n\n${msg}` +
                    (err instanceof EspnRefusal
                      ? `\n\nThis is a refusal by design. Pass dataSource="sgo" to use ` +
                        `SportsGameOdds instead, which spends entities but uses SGO's own ` +
                        `player IDs and so does not depend on a name match.`
                      : ""),
                },
              ],
              structuredContent: {
                ok: false,
                reason: "espn_refused",
                sport: params.sport,
                statID: params.statID,
              },
              isError: true,
            };
          }
        }

        /* ---- BDL MAY NOT BE CONFIGURED AT ALL, ADDED v2.16.0 ----
         *
         * This check comes BEFORE bdlCanServe on purpose. The resolver question ("does
         * BDL have a resolver for this sport and stat") is the wrong thing to answer
         * first when there is no BDL account behind it: the caller would be told their
         * STAT is unsupported, go pick a different stat, and be refused again. Checking
         * configuration first names the real cause once.
         *
         * `auto` is untouched by this. Since v2.14.0 it routes to SGO for every sport
         * except CFB, CBB and NHL, which use their own non-BDL sources, so a default
         * hit rate does not depend on a BDL key at all. Only an EXPLICIT
         * dataSource="bdl" reaches here. */
        if (params.dataSource === "bdl" && !isBdlConfigured(bdl)) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `dataSource="bdl" was requested, but ${BDL_UNAVAILABLE_MESSAGE}\n\n` +
                  `FOR THIS CALL: drop dataSource to use the default source for ` +
                  `${params.sport.toUpperCase()}, or pass dataSource="sgo" explicitly. ` +
                  `SGO's box scores were verified against ESPN on 2026-10-01.`,
              },
            ],
            structuredContent: {
              ok: false,
              reason: "bdl_not_configured",
              sport: params.sport,
              statID: params.statID,
              suggestedDataSource: "sgo",
            },
            isError: true,
          };
        }

        const bdlCanServe = isStatSupported(params.sport, params.statID);

        /* REFUSE AN IMPOSSIBLE EXPLICIT CHOICE rather than quietly substituting. */
        if (params.dataSource === "bdl" && !bdlCanServe) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `dataSource="bdl" CANNOT SERVE ${params.sport.toUpperCase()} ` +
                  `"${params.statID}".\n\n` +
                  `This connector has BALLDONTLIE stat resolvers for MLB and WNBA only; ` +
                  `nine sports have none, and WNBA's are gated behind GOAT on this ` +
                  `account (a live 401, confirmed 2026-10-01).\n\n` +
                  `Until v2.14.0 this request silently returned SportsGameOdds data ` +
                  `labelled as nothing in particular. It now refuses instead. Drop ` +
                  `dataSource to use the default source for this sport, or pass ` +
                  `dataSource="sgo" explicitly.`,
              },
            ],
            structuredContent: {
              ok: false,
              reason: "bdl_cannot_serve",
              sport: params.sport,
              statID: params.statID,
              bdlSupportedSports: ["mlb", "wnba"],
            },
            isError: true,
          };
        }

        /* Only an EXPLICIT bdl request reaches BDL now. `auto` prefers SGO, whose box
         * scores are verified and whose quota is no longer a constraint. */
        const canUseBdl = params.dataSource === "bdl" && bdlCanServe;

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
                structuredContent: { ...bdlResult, statSourceUsed: "bdl" },
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
              structuredContent: { ...bdlResult, statSourceUsed: "bdl" },
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
              structuredContent: { ...sgoFallback, statSourceUsed: "sgo", statSourceRequested: "bdl" },
            };
          }
        }

        /* PROVENANCE ON EVERY ANSWER, v2.14.0. Until now the BDL path announced itself
         * and the SGO path said nothing, so a caller could not tell which provider
         * produced a number - and when dataSource was silently ignored, could not tell
         * that it had been ignored. Every return below carries this. */
        const SGO_PROVENANCE =
          `\n\nSource: SPORTSGAMEODDS player box scores (consumes object quota). ` +
          `SGO-first is the default as of v2.14.0: the Pro key's entity cap is ` +
          `3,000,000/day rather than the Rookie 100,000/month that made BDL the ` +
          `default, and SGO's box scores were verified against ESPN on 2026-10-01. ` +
          `Pass dataSource="bdl" to force BALLDONTLIE where it has resolvers (MLB, WNBA).`;

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
                  `Appearances found: ${result.gamesConsidered} across ${result.teamGamesScanned} team games scanned.` +
                  `${SGO_PROVENANCE}\n\n` +
                  JSON.stringify(result, null, 2),
              },
            ],
            structuredContent: { ...result, statSourceUsed: "sgo" },
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
              text: `${summary}${seasonLine}${SGO_PROVENANCE}\n\n${JSON.stringify(result, null, 2)}`,
            },
          ],
          structuredContent: { ...result, statSourceUsed: "sgo" },
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
