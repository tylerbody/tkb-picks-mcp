import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { getHomeRoadSplit, getOpponentSplit } from "../services/splitsAggregator.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

const SplitsInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    teamID: z.string().describe("SGO teamID for the team being checked."),
    teamName: z.string().describe("Team's display name, for output labeling."),
    splitType: z
      .enum(["home", "road", "opponent"])
      .describe("Which split to compute: home record, road record, or record vs a specific opponent."),
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
        "ISO date to bound the lookback window, e.g. start of current season. Omit for SGO's default lookback."
      ),
  })
  .strict();

type SplitsInput = z.infer<typeof SplitsInputSchema>;

export function registerSplitsTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_team_split",
    {
      title: "Get Team Split Record",
      description: `Get a team's home record, road record, or record against a specific opponent.

Computed from real finalized game results (not a season-averages shortcut), so it
reflects actual wins/losses in the requested split.

Args:
  - sport, teamID, teamName
  - splitType ('home'|'road'|'opponent')
  - opponentTeamID, opponentName (required if splitType='opponent')
  - seasonStartsAfter (optional): bound the lookback, e.g. current season start

Returns: wins, losses, and the context label (e.g. "home", "vs Athletics").

Examples:
  - Use when: building an opener hook like "Rangers are 24-11 at home"
  - Use when: "How have they done against this team historically?" -> splitType="opponent"
  - Don't use when: you need the team's overall record - this is specifically for splits

Error Handling:
  - Returns an error if splitType='opponent' but opponentTeamID/opponentName are missing
  - Ties/unfinished games are excluded from the win/loss tally, not counted either way`,
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

        const result = await getHomeRoadSplit(sgo, {
          sport: params.sport,
          teamID: params.teamID,
          teamName: params.teamName,
          location: params.splitType,
          seasonStartsAfter: params.seasonStartsAfter,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `${result.teamName} is ${result.wins}-${result.losses} ${result.context} this season.\n\n${JSON.stringify(result, null, 2)}`,
            },
          ],
          structuredContent: result,
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
