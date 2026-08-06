import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

const TeamRecordInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    teamID: z.string().describe("SGO teamID for the team."),
  })
  .strict();

type TeamRecordInput = z.infer<typeof TeamRecordInputSchema>;

export function registerTeamRecordTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_team_record",
    {
      title: "Get Team Overall Record",
      description: `Get a team's overall season record (wins, losses, streak, last 5) directly
from SGO's real standings data - fast, single call, no event-tallying involved.

This is DIFFERENT from tkb_get_team_split, which computes home/road/opponent-specific
splits by tallying individual games (standings data doesn't break down that granularly).
Use this tool for a simple "what's their overall record" question; use tkb_get_team_split
for home/road/opponent-specific splits.

Args:
  - sport, teamID

Returns: wins, losses, ties, record string, games played, last 5 results, current streak
(fields may be partially populated depending on what SGO has for that team/sport).

Examples:
  - Use when: "What's the Braves' record?" -> just the overall wins/losses
  - Don't use when: you need home-only or road-only record - use tkb_get_team_split
  - Don't use when: you need record vs a specific opponent - use tkb_get_team_split

Error Handling:
  - Returns a clear message if no team is found for the given teamID
  - If standings data isn't populated for this team/sport, reports which fields are missing
    rather than silently returning zeros`,
      inputSchema: TeamRecordInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: TeamRecordInput) => {
      try {
        const team = await sgo.getTeam(params.teamID);

        if (!team) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No team found for teamID "${params.teamID}".`,
              },
            ],
          };
        }

        if (!team.standings) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Team "${team.name}" was found but has no standings data currently populated. Use tkb_get_team_split instead if you need a computed record.`,
              },
            ],
          };
        }

        const s = team.standings;
        const output = {
          teamName: team.name,
          wins: s.wins,
          losses: s.losses,
          ties: s.ties,
          record: s.record,
          played: s.played,
          last5: s.last5,
          streak: s.streak,
        };

        const summary =
          s.record ?? (s.wins !== undefined && s.losses !== undefined ? `${s.wins}-${s.losses}` : "record unavailable");

        return {
          content: [
            {
              type: "text" as const,
              text: `${team.name}: ${summary}${s.streak ? `, streak: ${s.streak}` : ""}\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching team record: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
