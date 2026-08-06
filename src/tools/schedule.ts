import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";
import type { NormalizedGame } from "../types.js";

const ScheduleInputSchema = z
  .object({
    sport: z
      .enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]])
      .describe("Which sport's schedule to fetch (mlb, wnba, nfl, cfb)"),
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
        "CFB/NCAAF only: filter to a specific conference (e.g. 'Big Ten', 'SEC'). Matches against team metadata if available from SGO; falls back to no filtering with a note if conference data isn't present on the team object."
      ),
    top25Only: z
      .boolean()
      .optional()
      .describe(
        "CFB/NCAAF only: filter to games involving at least one ranked (Top 25) team, if ranking data is available from SGO."
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
  - sport ('mlb'|'wnba'|'nfl'|'cfb'): which sport
  - date (string, optional): single date YYYY-MM-DD
  - startsAfter / startsBefore (ISO datetime, optional): date range instead of single date
  - teamName (string, optional): filter to one team's games
  - conference (string, optional, CFB only): filter to a conference e.g. "Big Ten"
  - top25Only (boolean, optional, CFB only): filter to games with a ranked team

Returns: list of games with eventID, start time, status, teams, and scores if final.

Examples:
  - Use when: "What MLB games are on today?" -> sport="mlb", date=today's date
  - Use when: "Give me this week's Big Ten games" -> sport="cfb", startsAfter/startsBefore for the week, conference="Big Ten"
  - Use when: "Top 25 matchups this week" -> sport="cfb", startsAfter/startsBefore, top25Only=true
  - Don't use when: you need odds/lines for these games - use tkb_get_odds instead

Error Handling:
  - Returns a clear message if the sport has no games in the requested window
  - Note: conference/top25 filtering depends on SGO exposing that metadata on team objects;
    if unavailable, the tool returns the unfiltered schedule with a note explaining why.`,
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

        if (params.sport === "cfb" && (params.conference || params.top25Only)) {
          // Conference/ranking data availability from SGO is unverified as of this
          // build - this is a known gap to confirm on first live test.
          filterNote =
            " Note: conference/Top-25 filtering requested but this data's availability from SportsGameOdds has not yet been verified against a live response - showing unfiltered results for now. Flag this to the developer to confirm the correct field once tested.";
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

        const games: NormalizedGame[] = filtered.map((e) => ({
          eventID: e.eventID,
          sport: params.sport,
          startTimeISO: e.info?.date ?? "unknown",
          status: e.status?.displayShort ?? (e.status?.completed ? "Final" : "Scheduled"),
          homeTeam: e.teams.home.names?.long ?? e.teams.home.teamID,
          awayTeam: e.teams.away.names?.long ?? e.teams.away.teamID,
          homeScore: e.teams.home.score,
          awayScore: e.teams.away.score,
        }));

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
