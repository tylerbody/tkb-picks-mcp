import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { BDLClient } from "../services/bdlClient.js";
import { getHomeRoadSplit, getOpponentSplit } from "../services/splitsAggregator.js";
import { currentSeason } from "../services/seasonBoundary.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * TEAM SPLITS - home record, road record, or head-to-head.
 *
 * TWO DATA PATHS, in order of preference:
 *
 *   1. BALLDONTLIE standings (home/road only). ONE request, returns home_record,
 *      road_record, point_differential, win_streak, division and conference record.
 *      Costs nothing against the SGO object quota.
 *
 *   2. SGO event tallying (fallback, and the only path for head-to-head). Pulls up
 *      to 100 finalized events and counts wins by hand. Correct but expensive:
 *      SGO bills per event object returned, so this path can burn 100 objects for
 *      a single answer that BDL gives for free.
 *
 * Head-to-head has no standings equivalent anywhere, so it always uses path 2.
 *
 * WHY POINT DIFFERENTIAL IS SURFACED PROMINENTLY: an analysis of 26 seasons of
 * play-by-play data found that after roughly six games, point differential alone
 * was as predictive of future performance as any advanced metric tested. For a
 * moneyline reasoning bullet it is stronger and more defensible than a raw
 * win-loss record, which hides margin entirely.
 */
const SplitsInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    teamID: z.string().describe("SGO teamID for the team being checked."),
    teamName: z
      .string()
      .describe(
        "Team's display name, for output labeling AND for matching against BALLDONTLIE standings (which key on team name, not SGO teamID)."
      ),
    splitType: z
      .enum(["home", "road", "opponent"])
      .describe(
        "Which split to compute: home record, road record, or record vs a specific opponent."
      ),
    opponentTeamID: z
      .string()
      .optional()
      .describe("Required when splitType='opponent': the opposing team's SGO teamID."),
    opponentName: z
      .string()
      .optional()
      .describe("Required when splitType='opponent': the opposing team's display name."),
    seasonStartsAfter: z
      .string()
      .optional()
      .describe(
        "ISO date to bound the lookback window, e.g. start of current season. Only used on the SGO fallback path."
      ),
    forceSGO: z
      .boolean()
      .optional()
      .describe(
        "Skip the BALLDONTLIE standings path and compute from SGO events instead. Only needed for cross-checking a suspicious standings result - costs significantly more API quota."
      ),
  })
  .strict();

type SplitsInput = z.infer<typeof SplitsInputSchema>;

/** Normalize a team name for fuzzy matching between SGO and BDL naming. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function registerSplitsTool(server: McpServer, sgo: SGOClient, bdl: BDLClient) {
  server.registerTool(
    "tkb_get_team_split",
    {
      title: "Get Team Split Record",
      description: `Get a team's home record, road record, or record against a specific opponent.

Home/road splits come from BALLDONTLIE standings in a single request, and also return
point differential, win streak, and division/conference record. Head-to-head splits are
computed from real finalized game results.

Args:
  - sport, teamID, teamName
  - splitType ('home'|'road'|'opponent')
  - opponentTeamID, opponentName (required if splitType='opponent')
  - seasonStartsAfter (optional): bounds the lookback on the fallback path
  - forceSGO (optional): bypass standings and tally events instead

Returns: wins, losses, the context label, and (on the standings path) point
differential, streak, and division/conference records.

Examples:
  - Use when: building an opener hook like "Rangers are 24-11 at home"
  - Use when: "How have they done against this team historically?" -> splitType="opponent"
  - Don't use when: you need the team's overall record - use tkb_get_team_record

Error Handling:
  - Returns an error if splitType='opponent' but opponentTeamID/opponentName are missing
  - Falls back to SGO event tallying automatically if standings are unavailable for
    this sport/season, and says which path produced the answer
  - Ties/unfinished games are excluded from the tally, not counted either way`,
      inputSchema: SplitsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: SplitsInput) => {
      try {
        // ---- Head-to-head: no standings equivalent exists, always tally events ----
        if (params.splitType === "opponent") {
          if (!params.opponentTeamID || !params.opponentName) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: opponentTeamID and opponentName are required when splitType='opponent'.",
                },
              ],
              isError: true,
            };
          }
          const result = await getOpponentSplit(sgo, {
            sport: params.sport,
            teamID: params.teamID,
            teamName: params.teamName,
            opponentTeamID: params.opponentTeamID,
            opponentName: params.opponentName,
            startsAfter: params.seasonStartsAfter,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: `${result.teamName} is ${result.wins}-${result.losses} ${result.context}.\n\n${JSON.stringify(result, null, 2)}`,
              },
            ],
            structuredContent: result,
          };
        }

        // ---- Home/road: try BDL standings first ----
        if (!params.forceSGO) {
          try {
            const season = currentSeason(params.sport).seasonYear;
            const standings = await bdl.getStandings(params.sport, season);
            const needle = normalize(params.teamName);

            const row = standings.data.find((s) => {
              const t = s.team;
              return [t?.full_name, t?.display_name, t?.name, t?.location]
                .filter(Boolean)
                .some((n) => {
                  const norm = normalize(String(n));
                  return norm === needle || norm.includes(needle) || needle.includes(norm);
                });
            });

            const recordString =
              params.splitType === "home" ? row?.home_record : row?.road_record;

            if (row && recordString) {
              // Records come as "3-0" or "5-2-1" strings
              const parts = recordString.split("-").map((n) => parseInt(n, 10));
              const wins = Number.isFinite(parts[0]) ? parts[0] : 0;
              const losses = Number.isFinite(parts[1]) ? parts[1] : 0;

              const output = {
                teamName: params.teamName,
                wins,
                losses,
                context: params.splitType,
                record: recordString,
                source: "balldontlie_standings",
                season,
                // Extras that the SGO tallying path cannot produce at all
                overallRecord: row.overall_record,
                pointDifferential: row.point_differential,
                pointsFor: row.points_for,
                pointsAgainst: row.points_against,
                winStreak: row.win_streak,
                divisionRecord: row.division_record,
                conferenceRecord: row.conference_record,
              };

              const diffNote =
                typeof row.point_differential === "number"
                  ? ` Point differential: ${row.point_differential > 0 ? "+" : ""}${row.point_differential}.`
                  : "";

              return {
                content: [
                  {
                    type: "text" as const,
                    text: `${params.teamName} is ${recordString} ${params.splitType} this season.${diffNote}\n\n${JSON.stringify(output, null, 2)}`,
                  },
                ],
                structuredContent: output,
              };
            }
          } catch {
            // Standings unavailable for this sport/season/tier - fall through to SGO.
            // Deliberately swallowed: the fallback below produces a correct answer,
            // so a standings outage should degrade cost and detail, not correctness.
          }
        }

        // ---- Fallback: tally finalized SGO events ----
        const result = await getHomeRoadSplit(sgo, {
          sport: params.sport,
          teamID: params.teamID,
          teamName: params.teamName,
          location: params.splitType,
          seasonStartsAfter: params.seasonStartsAfter,
        });

        const output = { ...result, source: "sgo_event_tally" };

        return {
          content: [
            {
              type: "text" as const,
              text: `${result.teamName} is ${result.wins}-${result.losses} ${result.context} this season. (Computed by tallying finalized games, since standings data was unavailable for this sport/season.)\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error computing team split: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
