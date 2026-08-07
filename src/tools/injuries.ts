import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BDLClient } from "../services/bdlClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";
import type { NormalizedInjury } from "../types.js";

const InjuriesInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    playerName: z
      .string()
      .optional()
      .describe("Filter to a specific player (partial match, case-insensitive)."),
    teamName: z
      .string()
      .optional()
      .describe("Filter to a specific team's injury report (partial match)."),
  })
  .strict();

type InjuriesInput = z.infer<typeof InjuriesInputSchema>;

export function registerInjuriesTool(server: McpServer, bdl: BDLClient) {
  server.registerTool(
    "tkb_get_injuries",
    {
      title: "Get Player Injuries",
      description: `Get current injury reports from BALLDONTLIE for a sport, optionally filtered by player or team.

This is a structured injury data source (not a web search) - use it as the FIRST
check before including any player in a pick. It returns status (Out/Questionable/
Doubtful/etc.), a dated description, and expected return date where known.

IMPORTANT: this data has an update cadence that has not been independently verified
against real-time news. For a player with very recent (same-day) injury news, still
cross-check with a live web search before finalizing a pick - don't treat this as
the only source for breaking news, only as the fast first-pass structured check.

Args:
  - sport ('mlb'|'wnba'|'nfl'|'cfb'): which sport
  - playerName (string, optional): narrow to one player
  - teamName (string, optional): narrow to one team's report

Returns: list of injuries with player name, team, status, description, return date.

Examples:
  - Use when: about to include a player in a thread, checking they're clean to use
  - Use when: "Is anyone on the Rangers hurt right now?" -> teamName="Rangers"
  - Don't use when: you need breaking news from the last few hours - web search is faster for that

Error Handling:
  - Returns "no injuries found" (not an error) if the filtered list is empty - this
    is a normal, good outcome, not a failure`,
      inputSchema: InjuriesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: InjuriesInput) => {
      try {
        const allInjuries = await bdl.getAllInjuries(params.sport);

        let filtered = allInjuries;
        if (params.playerName) {
          const needle = params.playerName.toLowerCase();
          filtered = filtered.filter((i) =>
            `${i.player.first_name} ${i.player.last_name}`.toLowerCase().includes(needle)
          );
        }
        if (params.teamName) {
          const needle = params.teamName.toLowerCase();
          filtered = filtered.filter((i) =>
            i.player.team?.display_name?.toLowerCase().includes(needle)
          );
        }

        if (!filtered.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No injuries found matching the given filters for ${params.sport.toUpperCase()}. (This is a good sign, not an error - it likely means the filtered player/team has no current injury flags.)`,
              },
            ],
          };
        }

        const injuries: NormalizedInjury[] = filtered.map((i) => ({
          playerName: `${i.player.first_name} ${i.player.last_name}`,
          // CONFIRMED via live debug tool: real path is player.team.display_name
          team: i.player.team?.display_name ?? "unknown",
          status: i.status,
          type: i.type,
          detail: i.detail,
          side: i.side,
          summary: i.short_comment ?? i.description ?? "no summary available",
          returnDate: i.return_date,
        }));

        const output = { count: injuries.length, injuries };

        return {
          content: [
            {
              type: "text" as const,
              text: `${injuries.length} injury record(s) found.\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching injuries: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
