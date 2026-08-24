import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { YES_NO_MARKETS } from "../services/marketCatalog.js";
import { extractPricedLine } from "../services/oddsPricing.js";
import { SUPPORTED_SPORTS, supportsCapability, unsupportedMessage, type SportKey } from "../constants.js";

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
        if (!supportsCapability(params.sport, "playerProps")) {
          return {
            content: [
              { type: "text" as const, text: unsupportedMessage(params.sport, "playerProps") },
            ],
          };
        }

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
          // Request only this exact market instead of the event's full 1000+
          // markets - same fix applied to tkb_get_odds.
          oddIDs: yesOddID,
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

        // GUARDRAIL: yes/no markets have no line by nature, but they still need a
        // real book price - see services/oddsPricing.ts.
        const pricing = extractPricedLine(event.odds?.[yesOddID], {
          requireLine: false,
          marketDescription: `"${market.label}"`,
        });

        if (!pricing.priced) {
          return {
            content: [
              {
                type: "text" as const,
                text: `NO USABLE ODDS - do not post this pick.\n\n${pricing.reason}`,
              },
            ],
          };
        }

        const output = {
          market: market.label,
          eventID: event.eventID,
          americanOdds: pricing.value!.americanOdds,
          bookmaker: pricing.value!.bookmaker,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${market.label}: ${output.americanOdds}\n\n${JSON.stringify(output, null, 2)}`,
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
