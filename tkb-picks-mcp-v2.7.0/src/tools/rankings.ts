import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BDLClient } from "../services/bdlClient.js";
import { currentSeason } from "../services/seasonBoundary.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * AP POLL RANKINGS.
 *
 * WHAT THIS REPLACES. tkb_get_schedule's CFB tiering has always required the
 * caller to pass `rankedTeams` from a live web search, on every single call. Its
 * own error message explains why:
 *
 *   "SportsGameOdds does not reliably expose team rankings, and hardcoding a Top
 *    25 into this server would go stale within a week and then silently return
 *    wrong results all season."
 *
 * Both halves of that were correct. The conclusion was not, because it assumed
 * SGO was the only source. BALLDONTLIE publishes the AP poll on the ALL-STAR
 * tier this account ALREADY PAYS FOR on NCAAF. The manual step was never
 * necessary - it was a gap in what the connector knew about its own
 * subscriptions.
 *
 * AND IT DOES NOT GO STALE, which is the whole point. A hardcoded list rots; a
 * live endpoint returns the current week's poll every time it is called. This is
 * exactly the DECAYING-FACT bucket from the standing research rule: rankings are
 * a rolling counter, they change weekly, and they must come from a source that
 * updates rather than from an article or a constant.
 *
 * COSTS ZERO SGO ENTITIES. Different provider, no object cap.
 *
 * NCAA ONLY, DELIBERATELY GATED. MLB, WNBA and NFL have no poll. Accepting the
 * call and returning nothing would be a plausible-looking wrong answer; this
 * refuses with the reason instead.
 */

const RankingsInputSchema = z
  .object({
    sport: z
      .enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]])
      .describe("Which sport. Only cfb has a poll; every other sport is refused with a reason."),
    season: z
      .number()
      .int()
      .optional()
      .describe("Season year. Defaults to the current season for this sport."),
    week: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("Poll week. Defaults to the CURRENT week when omitted, which is what you almost always want."),
    top: z
      .number()
      .int()
      .min(1)
      .max(25)
      .default(25)
      .describe("How many ranked teams to return. 25 is the full poll."),
    namesOnly: z
      .boolean()
      .default(false)
      .describe(
        "Return just a comma-separated team-name string, formatted to paste straight into tkb_get_schedule's rankedTeams parameter."
      ),
  })
  .strict();

type RankingsInput = z.infer<typeof RankingsInputSchema>;

/** Sports that actually have a poll. */
const POLL_SPORTS: SportKey[] = ["cfb"];

export function registerRankingsTool(server: McpServer, bdl: BDLClient) {
  server.registerTool(
    "tkb_get_rankings",
    {
      title: "Get the current AP Top 25",
      description: `Live AP poll rankings, so rankedTeams never has to be typed by hand again.

WHY THIS EXISTS: tkb_get_schedule's CFB tiering requires a rankedTeams list, and
until now that meant running a web search and pasting names on every call. That was
necessary because SportsGameOdds does not expose rankings - but BALLDONTLIE does,
on the NCAAF ALL-STAR tier this account already holds.

Costs ZERO SportsGameOdds entities.

Args:
  - sport: only 'cfb' has a poll. Others are refused with an explanation.
  - season (optional): defaults to the current season
  - week (optional): defaults to the CURRENT week, which is usually what you want
  - top (default 25): how many ranked teams
  - namesOnly (default false): return a bare comma-separated string ready to paste
    into tkb_get_schedule's rankedTeams

Returns: rank, team, record, first-place votes, points, and the week-over-week
trend. Note that trend is TEXT ("-", "+1", "-3"), not a number.

Examples:
  - Use when: building any CFB slate - run this first, feed the output into
    tkb_get_schedule with tier='top25' or 'postable'
  - Use when: "who's ranked this week?"
  - Use when: namesOnly=true to get a paste-ready rankedTeams string
  - Don't use when: you need standings or records - use tkb_get_standings

Error Handling:
  - Refuses non-NCAA sports by name rather than returning an empty poll
  - A 401 means the NCAAF BDL subscription lapsed, and says so`,
      inputSchema: RankingsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: RankingsInput) => {
      try {
        const sport = input.sport as SportKey;

        if (!POLL_SPORTS.includes(sport)) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `${sport.toUpperCase()} has no poll. Rankings are an NCAA concept - there is ` +
                  `no AP Top 25 for professional leagues.\n\n` +
                  `For team strength in ${sport.toUpperCase()}, use tkb_get_standings (records, ` +
                  `streak, point differential) or tkb_get_team_split (home/road/head-to-head).`,
              },
            ],
          };
        }

        const season = input.season ?? currentSeason(sport).seasonYear;
        const result = await bdl.getRankings(sport, {
          season,
          ...(input.week ? { week: input.week } : {}),
        });

        const rows = (result.data ?? [])
          .slice()
          .sort((a, b) => a.rank - b.rank)
          .slice(0, input.top);

        if (!rows.length) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No ${sport.toUpperCase()} poll returned for season ${season}` +
                  (input.week ? ` week ${input.week}` : ` (current week)`) +
                  `.\n\nEarly in a season the preseason poll may not have been published yet. ` +
                  `That is a real answer, not an error - fall back to a live search for this week only.`,
              },
            ],
          };
        }

        // CANDIDATE ORDER, not one assumed field. BDL's team shape differs by
        // sport - NCAAF returns city + name + full_name, MLB/WNBA return
        // display_name, NFL returns full_name. Reading one field is the exact
        // mistake that made every NFL injury render as "unknown" team.
        const teamName = (r: (typeof rows)[number]): string => {
          const t = (r.team ?? {}) as unknown as Record<string, unknown>;
          const pick = (k: string): string | null =>
            typeof t[k] === "string" && t[k] ? (t[k] as string) : null;
          const composed =
            pick("city") && pick("name") ? `${pick("city")} ${pick("name")}` : null;
          return (
            pick("full_name") ??
            pick("display_name") ??
            composed ??
            pick("name") ??
            pick("abbreviation") ??
            "unknown"
          );
        };

        const names = rows.map(teamName);

        // PASTE-READY. tkb_get_schedule takes rankedTeams as a comma-separated
        // string, and its CFB matcher normalises names itself (diacritics
        // stripped, punctuation removed), so full names are safe to hand over
        // without further munging.
        const rankedTeamsParam = names.join(",");

        if (input.namesOnly) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Top ${rows.length}, season ${season}${rows[0]?.week ? ` week ${rows[0].week}` : ""}. ` +
                  `Paste this into tkb_get_schedule as rankedTeams:\n\n${rankedTeamsParam}`,
              },
            ],
            structuredContent: { season, rankedTeams: rankedTeamsParam, teams: names },
          };
        }

        const table = rows.map((r) => ({
          rank: r.rank,
          team: teamName(r),
          record: r.record ?? null,
          firstPlaceVotes: r.first_place_votes ?? null,
          points: r.points ?? null,
          trend: r.trend ?? null,
        }));

        // "NR" MEANS NOT PREVIOUSLY RANKED, NOT "MOVED". A preseason poll returns
        // NR for all 25 teams because there is no previous week, so counting it as
        // movement reported "25 team(s) moved from last week" on a poll where
        // nothing had moved because nothing had happened yet. Caught live on the
        // first run, 2026-08-27.
        const NON_MOVES = new Set(["-", "NR", ""]);
        const movers = table.filter((t) => t.trend && !NON_MOVES.has(t.trend)).length;
        const newEntries = table.filter((t) => t.trend === "NR").length;
        const preseason = newEntries === table.length;

        const movementLine = preseason
          ? `Every team is marked NR (no previous poll), so this is the PRESEASON poll - ` +
            `these are expectations, not results. Every record is 0-0.`
          : `${movers} team(s) moved from last week` +
            (newEntries ? `, ${newEntries} newly ranked` : "") +
            `.`;

        const summary =
          `AP Top ${rows.length}, season ${season}` +
          (rows[0]?.week ? `, week ${rows[0].week}` : ", current week") +
          `. ${movementLine}\n\n` +
          `rankedTeams (paste into tkb_get_schedule):\n${rankedTeamsParam}\n\n` +
          `NOTE: this is a DECAYING fact. It is correct as of right now and wrong ` +
          `next Sunday. Re-pull rather than reusing it across weeks.`;

        return {
          content: [
            { type: "text" as const, text: `${summary}\n\n${JSON.stringify(table, null, 2)}` },
          ],
          structuredContent: {
            sport,
            season,
            week: rows[0]?.week ?? null,
            count: table.length,
            rankedTeams: rankedTeamsParam,
            rankings: table,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching rankings: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
