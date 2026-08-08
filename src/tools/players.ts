import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

const PlayersInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventID: z.string().describe("SGO eventID for the game, from tkb_get_schedule."),
    teamSide: z
      .enum(["home", "away", "both"])
      .default("both")
      .describe("Limit results to one side of the matchup. Defaults to both."),
    nameContains: z
      .string()
      .optional()
      .describe("Optional partial name filter, case-insensitive (e.g. 'maye')."),
  })
  .strict();

type PlayersInput = z.infer<typeof PlayersInputSchema>;

export function registerPlayersTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_players",
    {
      title: "Get Players for an Event",
      description: `List the players attached to a specific game, with their SGO playerID and teamID.

WHY THIS EXISTS: playerID is required by tkb_get_odds (player props), tkb_get_yes_no_prop,
and tkb_get_player_hit_rate, but there was previously no way to get one except
tkb_debug_raw_event, which dumps the ENTIRE event payload including up to 1000+ odds
markets. That is the exact pattern that caused out-of-memory crashes on this server
before request-level filtering was introduced. This tool returns only the roster -
typically a few hundred bytes instead of megabytes.

IMPORTANT - COVERAGE IS TIED TO MARKET AVAILABILITY: SGO populates the players object
from the markets posted for that game, so the roster fills in as books post props.
Confirmed via live test on 8 Aug 2026:
  - NFL preseason game: 0 players, 6 markets
  - NFL regular-season Week 1 (5 weeks out): 22 players, 266 markets
  - MLB game the following day: 0 players, 38 markets
  - MLB game starting within the hour: 19 players, 1,180 markets
An empty roster therefore usually means "props are not posted yet", not "no players".
Retry closer to game time. This is also why threads get built a few hours out rather
than the night before.

Args:
  - sport, eventID
  - teamSide ('home'|'away'|'both', default 'both')
  - nameContains (optional): partial name filter

Returns: playerID, name, teamID, and team name for each player, plus a count.

Examples:
  - Use when: you need a playerID before calling tkb_get_odds for a prop
  - Use when: "who's available to prop in this game?"
  - Don't use when: you need injury status - use tkb_get_injuries
  - Don't use when: you need the full raw event shape for debugging - use tkb_debug_raw_event

Error Handling:
  - Returns a clear explanation (not an error) when the roster is empty, including the
    likely cause that props are not yet posted for this game`,
      inputSchema: PlayersInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: PlayersInput) => {
      try {
        const leagueID = sgo.leagueIDFor(params.sport);

        // Request a single trivial oddID so SGO does not attach the full market
        // set to this response. We only want the players object.
        const events = await sgo.getAllEvents({
          leagueID,
          eventIDs: params.eventID,
          oddIDs: "points-home-game-ml-home",
        });

        if (!events.length) {
          return {
            content: [
              { type: "text" as const, text: `No event found for eventID "${params.eventID}".` },
            ],
          };
        }

        const event = events[0];
        const homeID = event.teams.home.teamID;
        const awayID = event.teams.away.teamID;
        const teamNames: Record<string, string> = {
          [homeID]: event.teams.home.names?.long ?? homeID,
          [awayID]: event.teams.away.names?.long ?? awayID,
        };

        const raw = Object.values(event.players ?? {});

        if (!raw.length) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No players are attached to this event yet (${teamNames[awayID]} @ ${teamNames[homeID]}).\n\n` +
                  `This almost always means sportsbooks have not posted player props for this game yet, rather than a data error - ` +
                  `SGO builds the player list from posted markets. Player props typically appear within a few days of game time ` +
                  `(and for MLB, often only on the morning of). Retry closer to first pitch/kickoff.\n\n` +
                  `Team-level markets (moneyline, spread, total) are usually available much earlier and can be pulled now via tkb_get_odds.`,
              },
            ],
          };
        }

        let players = raw.map((p) => ({
          playerID: p.playerID,
          name: p.name,
          teamID: p.teamID,
          teamName: teamNames[p.teamID] ?? p.teamID,
          position: p.position,
        }));

        if (params.teamSide !== "both") {
          const wanted = params.teamSide === "home" ? homeID : awayID;
          players = players.filter((p) => p.teamID === wanted);
        }

        if (params.nameContains) {
          const needle = params.nameContains.toLowerCase();
          players = players.filter((p) => p.name.toLowerCase().includes(needle));
        }

        players.sort((a, b) => a.teamName.localeCompare(b.teamName) || a.name.localeCompare(b.name));

        if (!players.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No players matched the given filters on this event, though ${raw.length} player(s) are attached to it overall. Try widening nameContains or teamSide.`,
              },
            ],
          };
        }

        const output = {
          eventID: event.eventID,
          homeTeam: teamNames[homeID],
          awayTeam: teamNames[awayID],
          count: players.length,
          players,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${players.length} player(s) available for ${teamNames[awayID]} @ ${teamNames[homeID]}.\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching players: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
