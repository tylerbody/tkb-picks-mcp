import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";
import type { NormalizedGame } from "../types.js";
import {
  normalizeTeamKey,
  POWER_4,
  CONFERENCE_MAP,
  conferenceOf,
  findRivalry,
  isFBS,
} from "../data/cfbTiers.js";

const ScheduleInputSchema = z
  .object({
    sport: z
      .enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]])
      .describe(
        "Which sport's schedule to fetch. Team sports: mlb, wnba, nfl, cfb. Tennis: atp, wta - these return MATCHES, with each player in the home/away slot, and the account posts moneyline only for them."
      ),
    date: z
      .string()
      .optional()
      .describe(
        "Single date in YYYY-MM-DD format. Omit to use startsAfter/startsBefore instead for a range."
      ),
    startsAfter: z
      .string()
      .optional()
      .describe("ISO 8601 datetime - only games starting after this. Use for date ranges."),
    startsBefore: z
      .string()
      .optional()
      .describe("ISO 8601 datetime - only games starting before this."),
    teamName: z
      .string()
      .optional()
      .describe("Filter to games involving a specific team name (partial match, case-insensitive)."),
    conference: z
      .string()
      .optional()
      .describe(
        "CFB only: filter to one conference - 'SEC', 'Big Ten', 'Big 12', or 'ACC'. Matched against a maintained conference roster in src/data/cfbTiers.ts, not SGO metadata (which does not reliably expose conference)."
      ),
    tier: z
      .enum(["all", "fbs", "power4", "top25", "rivalry", "postable"])
      .optional()
      .describe(
        "CFB only. 'all' = no filter (includes Division II noise). 'fbs' = real FBS programs only. 'power4' = SEC/Big Ten/Big 12/ACC + Notre Dame. 'top25' = games involving a ranked team (REQUIRES rankedTeams). 'rivalry' = named rivalry games. 'postable' (recommended) = Power 4 OR ranked OR rivalry."
      ),
    rankedTeams: z
      .string()
      .optional()
      .describe(
        "CFB only: comma-separated list of currently ranked team names, e.g. 'Ohio State,Texas,Georgia'. SGO does NOT reliably expose rankings, so supply them from a live web search of the current AP/Coaches Top 25. Required for tier='top25' and used to enrich tier='postable'."
      ),
    top25Only: z
      .boolean()
      .optional()
      .describe(
        "DEPRECATED - use tier='top25' with rankedTeams instead. Kept for backwards compatibility; maps to tier='postable' when no rankedTeams are supplied."
      ),
  })
  .strict();

type ScheduleInput = z.infer<typeof ScheduleInputSchema>;

export function registerScheduleTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_schedule",
    {
      title: "Get Game Schedule",
      description: `Get the game schedule for a sport, with flexible date and filtering options.

Args:
  - sport ('mlb'|'wnba'|'nfl'|'cfb'|'atp'|'wta'): which sport
  - date (string, optional): single date YYYY-MM-DD
  - startsAfter / startsBefore (ISO datetime, optional): date range instead of single date
  - teamName (string, optional): filter to one team's games
  - conference (string, optional, CFB only): 'SEC' | 'Big Ten' | 'Big 12' | 'ACC'
  - tier (CFB only): 'all' | 'fbs' | 'power4' | 'top25' | 'rivalry' | 'postable'
  - rankedTeams (CFB only): comma-separated current Top 25 names, from a live search

Returns: list of games with eventID, start time, status, teams, and scores if final.

Examples:
  - Use when: "What MLB games are on today?" -> sport="mlb", date=today's date
  - Use when: "Give me this week's Big Ten games" -> sport="cfb", startsAfter/startsBefore for the week, conference="Big Ten"
  - Use when: "Top 25 matchups this week" -> sport="cfb", tier="top25", rankedTeams="..." from a live Top 25 search
  - Use when: "what CFB should we post Saturday" -> sport="cfb", tier="postable" (Power 4 + rivalries)
  - Use when: "rivalry games this week" -> sport="cfb", tier="rivalry"
  - Use when: "what US Open matches are on today?" -> sport="atp" or "wta" with a date
  - Don't use when: you need odds/lines for these games - use tkb_get_odds instead

TENNIS NOTE: atp/wta events put each PLAYER in the home/away team slot, so homeTeam
and awayTeam in the output are player names and teamName filters on a player name.
There is no roster, no player props and no hit rates for tennis - moneyline only.
The CFB tier/conference/rankedTeams arguments are ignored for every other sport.

Error Handling:
  - Returns a clear message if the sport has no games in the requested window
  - CFB: SGO's NCAAF feed includes Division II and below. Without a tier filter you
    WILL get games not worth posting. tier='postable' is the sane default.
  - CFB: tier='top25' errors clearly if rankedTeams is not supplied, rather than
    silently returning unfiltered results as this tool previously did.`,
      inputSchema: ScheduleInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ScheduleInput) => {
      try {
        const leagueID = sgo.leagueIDFor(params.sport);

        let startsAfter = params.startsAfter;
        let startsBefore = params.startsBefore;
        if (params.date) {
          startsAfter = `${params.date}T00:00:00Z`;
          startsBefore = `${params.date}T23:59:59Z`;
        } else if (!startsAfter && !startsBefore && !params.teamName) {
          // No date given and no team filter either - default to "today onward"
          // rather than pulling the entire multi-season history unbounded.
          startsAfter = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
        }
        // NOTE: when teamName is given with no date, we intentionally do NOT
        // default-bound the date here, since "when does this team play next"
        // is a valid use case that needs to search forward past just today.
        // Instead, default to a reasonable forward window below.
        if (params.teamName && !params.date && !startsAfter && !startsBefore) {
          startsAfter = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
          // 45 days forward covers a full team schedule window without pulling
          // multiple seasons of history (which was the actual bug - no upper
          // or lower bound at all resulted in games from Feb 2024 being returned).
          const bound = new Date();
          bound.setDate(bound.getDate() + 45);
          startsBefore = bound.toISOString();
        }

        const events = await sgo.getAllEvents({
          leagueID,
          startsAfter,
          startsBefore,
          limit: 100,
        });

        let filtered = events;
        let filterNote = "";

        if (params.teamName) {
          const needle = params.teamName.toLowerCase();
          filtered = filtered.filter(
            (e) =>
              e.teams.home.names?.long?.toLowerCase().includes(needle) ||
              e.teams.away.names?.long?.toLowerCase().includes(needle)
          );
        }

        // ---- CFB tiering ----
        // SGO's NCAAF feed returns EVERY level of college football. A live test on
        // 29 Aug 2026 returned Division II games (Lenoir Rhyne vs Virginia Union)
        // alongside USC and Florida State. Previously this tool acknowledged the
        // gap in a note and returned everything unfiltered; it now actually filters.
        //
        // Rankings are supplied by the caller rather than looked up, because SGO was
        // confirmed NOT to expose a reliable ranking field and a hardcoded Top 25
        // would silently go stale within a week.
        const rankedKeys = new Set(
          (params.rankedTeams ?? "")
            .split(",")
            .map((t) => normalizeTeamKey(t))
            .filter(Boolean)
        );

        if (params.sport === "cfb") {
          const requestedTier =
            params.tier ?? (params.top25Only ? (rankedKeys.size ? "top25" : "postable") : undefined);

          if (params.conference) {
            const confKey = params.conference.toLowerCase().trim();
            const roster = CONFERENCE_MAP[confKey];
            if (!roster) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `"${params.conference}" is not a recognized conference filter. Valid options: ${Object.keys(CONFERENCE_MAP).join(", ")}.`,
                  },
                ],
                isError: true,
              };
            }
            const set = new Set(roster);
            filtered = filtered.filter((e) => {
              const h = normalizeTeamKey(e.teams.home.names?.long ?? "");
              const a = normalizeTeamKey(e.teams.away.names?.long ?? "");
              return set.has(h) || set.has(a);
            });
          }

          if (requestedTier && requestedTier !== "all") {
            if (requestedTier === "top25" && !rankedKeys.size) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `tier='top25' requires the rankedTeams parameter.\n\n` +
                      `SportsGameOdds does not reliably expose team rankings, and hardcoding a Top 25 into this server would go stale within a week ` +
                      `and then silently return wrong results all season. Instead: run a live web search for the current AP or Coaches Top 25, ` +
                      `then pass the team names in as rankedTeams='Ohio State,Texas,Georgia,...'.\n\n` +
                      `If you just want the games worth posting without pulling rankings first, use tier='postable' - that returns Power 4 plus named rivalry games.`,
                  },
                ],
                isError: true,
              };
            }

            const before = filtered.length;
            filtered = filtered.filter((e) => {
              const h = normalizeTeamKey(e.teams.home.names?.long ?? "");
              const a = normalizeTeamKey(e.teams.away.names?.long ?? "");
              const ranked = rankedKeys.has(h) || rankedKeys.has(a);
              const power = POWER_4.has(h) || POWER_4.has(a);
              const rivalry = findRivalry(h, a) !== null;
              const fbs = isFBS(h) && isFBS(a);

              switch (requestedTier) {
                case "fbs":
                  return fbs;
                case "power4":
                  return power;
                case "top25":
                  return ranked;
                case "rivalry":
                  return rivalry;
                case "postable":
                  return power || ranked || rivalry;
                default:
                  return true;
              }
            });

            const dropped = before - filtered.length;
            filterNote =
              ` Tier '${requestedTier}' applied: ${dropped} game(s) filtered out of ${before}` +
              (rankedKeys.size ? ` using ${rankedKeys.size} supplied ranked team(s).` : `.`) +
              (requestedTier === "postable" && !rankedKeys.size
                ? ` No rankedTeams supplied, so ranked-team matching was skipped - pass rankedTeams from a live Top 25 search to also catch ranked Group of 5 teams.`
                : "");
          } else if (!params.conference) {
            filterNote =
              " No tier filter applied, so this includes non-FBS games (SGO's NCAAF feed carries Division II and below). Use tier='postable' to narrow to games worth building a thread for.";
          }
        }

        if (!filtered.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No ${params.sport.toUpperCase()} games found for the requested window/filters.`,
              },
            ],
          };
        }

        const games: NormalizedGame[] = filtered.map((e) => {
          const homeName = e.teams.home.names?.long ?? e.teams.home.teamID;
          const awayName = e.teams.away.names?.long ?? e.teams.away.teamID;
          const base: NormalizedGame = {
            eventID: e.eventID,
            sport: params.sport,
            startTimeISO: e.status?.startsAt ?? "unknown",
            status: e.status?.displayShort ?? (e.status?.completed ? "Final" : "Scheduled"),
            homeTeam: homeName,
            awayTeam: awayName,
            homeScore: e.teams.home.score,
            awayScore: e.teams.away.score,
          };

          if (e.info?.seasonWeek) base.seasonWeek = e.info.seasonWeek;
          if (e.info?.venue?.name) base.venue = e.info.venue.name;

          if (params.sport === "cfb") {
            const h = normalizeTeamKey(homeName);
            const a = normalizeTeamKey(awayName);
            const rivalry = findRivalry(h, a);
            if (rivalry) base.rivalry = rivalry;
            const conf = conferenceOf(h) ?? conferenceOf(a);
            if (conf) base.conference = conf;
            const ranks: string[] = [];
            if (rankedKeys.has(a)) ranks.push(awayName);
            if (rankedKeys.has(h)) ranks.push(homeName);
            if (ranks.length) base.rankedTeams = ranks;
          }

          return base;
        });

        const output = { count: games.length, games };

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${games.length} ${params.sport.toUpperCase()} game(s).${filterNote}\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching schedule: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
