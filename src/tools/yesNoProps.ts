import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { YES_NO_MARKETS } from "../services/marketCatalog.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

const YesNoInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventID: z.string().describe("SGO eventID for the game, from tkb_get_schedule."),
    marketLabel: z
      .string()
      .describe(
        "Human-readable market name, e.g. 'Any Home Runs', 'First Touchdown', 'Double-Double'. Must match one of this sport's supported Yes/No markets - call this tool with no marketLabel match to see the full list in the error message."
      ),
    playerID: z
      .string()
      .optional()
      .describe(
        "SGO playerID, required for player-level markets (most of them). Omit only for team/game-wide markets like 'Any Score'."
      ),
    entity: z
      .enum(["home", "away", "all"])
      .optional()
      .describe(
        "For team/game-wide markets instead of a player: 'home', 'away', or 'all'. Omit if using playerID."
      ),
  })
  .strict();

type YesNoInput = z.infer<typeof YesNoInputSchema>;

export function registerYesNoPropsTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_yes_no_prop",
    {
      title: "Get Yes/No Milestone Prop",
      description: `Get odds for a Yes/No "milestone" bet - did the player/team do X at all this
game (not an over/under line). Examples: first touchdown, any home run, double-double,
pitching win, defensive safety.

This is DIFFERENT from tkb_get_odds, which handles over/under lines. Use this tool
specifically for milestone-style yes/no markets.

Args:
  - sport, eventID
  - marketLabel: human-readable name (e.g. "Any Home Runs") - must match this sport's
    supported list, which varies by sport (MLB has pitching win, NBA has first-basket, etc.)
  - playerID: required for player-level markets
  - entity ('home'|'away'|'all'): use instead of playerID for team/game markets

Returns: yes/no odds for the requested market.

Examples:
  - Use when: "What's the odds Ohtani hits a home run tonight?" -> marketLabel="Any Home Runs", playerID=...
  - Use when: "First team to score odds?" -> marketLabel="Any Score" or a first-to-score market, entity="home"/"away"
  - Don't use when: you need an over/under prop line - use tkb_get_odds instead

Error Handling:
  - Returns the full list of valid marketLabel options for this sport if the given label doesn't match
  - Returns a clear message if neither playerID nor entity is provided for a player-level market`,
      inputSchema: YesNoInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: YesNoInput) => {
      try {
        const catalog = YES_NO_MARKETS[params.sport];
        const market = catalog.find(
          (m) => m.label.toLowerCase() === params.marketLabel.toLowerCase()
        );

        if (!market) {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${params.marketLabel}" is not a recognized Yes/No market for ${params.sport.toUpperCase()}. Valid options: ${catalog.map((m) => m.label).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const entity = params.playerID ?? params.entity;
        if (!entity) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: provide either playerID (for a player-level market) or entity ('home'/'away'/'all' for a team/game-wide market).",
              },
            ],
            isError: true,
          };
        }

        const yesOddID = buildOddID({
          statID: market.statID,
          entity,
          period: "full_game",
          betType: "yn",
          side: "yes",
        });

        const leagueID = sgo.leagueIDFor(params.sport);
        const events = await sgo.getAllEvents({
          leagueID,
          eventIDs: params.eventID,
          oddsAvailable: true,
        });

        if (!events.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No event found for eventID "${params.eventID}".`,
              },
            ],
          };
        }

        const event = events[0];
        const yesOdd = event.odds?.[yesOddID];

        if (!yesOdd) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No odds currently available for "${market.label}" in this event. This can mean the market isn't offered for this game, or the exact oddID format used here doesn't match what SGO returns - if this keeps happening, flag it to double check the oddID construction against a live response.`,
              },
            ],
          };
        }

        const firstBook = yesOdd.byBookmaker ? Object.entries(yesOdd.byBookmaker)[0] : undefined;
        const output = {
          market: market.label,
          eventID: event.eventID,
          americanOdds: yesOdd.bookOdds ?? yesOdd.fairOdds ?? firstBook?.[1]?.odds,
          bookmaker: firstBook?.[0],
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${market.label}: ${output.americanOdds ?? "no price available"}\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching Yes/No prop: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
