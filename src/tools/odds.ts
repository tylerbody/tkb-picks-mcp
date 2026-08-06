import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";
import type { NormalizedOddsLine } from "../types.js";

const OddsInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventID: z
      .string()
      .optional()
      .describe("Specific SGO eventID to get odds for. Get this from tkb_get_schedule first."),
    teamName: z
      .string()
      .optional()
      .describe("Alternative to eventID: filter to a team's upcoming/live game."),
    marketType: z
      .enum(["moneyline", "spread", "total", "player_prop"])
      .default("player_prop")
      .describe(
        "Which kind of market: 'moneyline'/'spread'/'total' for team-level game lines, 'player_prop' for an individual player's over/under (default)."
      ),
    marketLabel: z
      .string()
      .optional()
      .describe(
        "Required when marketType='player_prop'. Exact market name, e.g. 'Hits', 'Passing Yards', 'Rebounds'. Must match this sport's supported prop list - the tool returns the full list if given an unrecognized label."
      ),
    playerID: z
      .string()
      .optional()
      .describe("Required when marketType='player_prop'. SGO playerID for the player."),
    playerName: z
      .string()
      .optional()
      .describe("Player's display name, used only for output labeling."),
    side: z
      .enum(["over", "under", "home", "away"])
      .optional()
      .describe(
        "For player_prop: 'over' or 'under'. For moneyline/spread: 'home' or 'away'. For total: 'over' or 'under'. Omit to get both sides."
      ),
  })
  .strict();

type OddsInput = z.infer<typeof OddsInputSchema>;

const MARKET_TYPE_CODE: Record<string, "ml" | "sp" | "ou"> = {
  moneyline: "ml",
  spread: "sp",
  total: "ou",
  player_prop: "ou",
};

export function registerOddsTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_odds",
    {
      title: "Get Odds and Lines",
      description: `Get current odds/lines for a game - moneyline, spread, total, or an individual
player's over/under prop. Uses exact market construction (not fuzzy text matching),
so results are precise - e.g. asking for "Hits" won't accidentally also return
"Hits Allowed" or "Hits + Runs + RBIs".

Args:
  - sport, and either eventID or teamName to identify the game
  - marketType ('moneyline'|'spread'|'total'|'player_prop', default 'player_prop')
  - marketLabel: required for player_prop - exact stat name (e.g. "Hits", "Passing Yards").
    Must match this sport's supported list, which the tool returns if the label doesn't match.
  - playerID: required for player_prop
  - side ('over'|'under'|'home'|'away'): omit to get both sides of the line

Returns: the odds line(s) with American odds and bookmaker.

Examples:
  - Use when: "What's Semien's hits prop?" -> marketType="player_prop", marketLabel="Hits", playerID=...
  - Use when: "What's the moneyline for tonight's Rangers game?" -> marketType="moneyline", teamName="Rangers"
  - Use when: "What's the total?" -> marketType="total", teamName="Rangers"
  - Don't use when: you need recent game-log hit-rate stats - use tkb_get_player_hit_rate
  - Don't use when: you need a milestone/yes-no bet (first HR, double-double) - use tkb_get_yes_no_prop
  - Don't use when: you need a period-specific line (1st half, 1st 5 innings) - use tkb_get_period_odds

Error Handling:
  - Returns the full list of valid marketLabel options for this sport if the label doesn't match
  - Returns a clear message if neither eventID nor teamName is given
  - Returns a clear message if player_prop is requested without playerID`,
      inputSchema: OddsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: OddsInput) => {
      try {
        if (!params.eventID && !params.teamName) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: provide either eventID or teamName to identify which game's odds to fetch.",
              },
            ],
            isError: true,
          };
        }

        if (params.marketType === "player_prop" && (!params.marketLabel || !params.playerID)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Error: marketType='player_prop' requires both marketLabel and playerID.",
              },
            ],
            isError: true,
          };
        }

        const leagueID = sgo.leagueIDFor(params.sport);

        // For the teamName fallback (no explicit eventID), bound the search to
        // "today onward" explicitly rather than relying solely on finalized=false -
        // a live test showed a team-name-only search could surface a finished game
        // from months ago, so don't trust finalized alone to exclude old games.
        const todayISO = new Date().toISOString().slice(0, 10) + "T00:00:00Z";

        const events = params.eventID
          ? await sgo.getAllEvents({ leagueID, eventIDs: params.eventID, oddsAvailable: true })
          : await sgo.getAllEvents({
              leagueID,
              oddsAvailable: true,
              finalized: false,
              startsAfter: todayISO,
              limit: 50,
            });

        let matched = events;
        if (params.teamName && !params.eventID) {
          const needle = params.teamName.toLowerCase();
          matched = events.filter(
            (e) =>
              e.teams.home.names?.long?.toLowerCase().includes(needle) ||
              e.teams.away.names?.long?.toLowerCase().includes(needle)
          );
        }

        if (!matched.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No matching ${params.sport.toUpperCase()} game with available odds found.`,
              },
            ],
          };
        }

        const event = matched[0];

        // Resolve statID for player props from the catalog (exact match required)
        let statID = "points"; // default for moneyline/spread/total ("points" is SGO's universal winner-stat)
        if (params.marketType === "player_prop") {
          const catalog = OU_PROP_MARKETS[params.sport];
          const market = catalog.find(
            (m) => m.label.toLowerCase() === params.marketLabel!.toLowerCase()
          );
          if (!market) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `"${params.marketLabel}" is not a recognized prop market for ${params.sport.toUpperCase()}. Valid options: ${catalog.map((m) => m.label).join(", ")}`,
                },
              ],
              isError: true,
            };
          }
          statID = market.statID;
        }

        const betTypeCode = MARKET_TYPE_CODE[params.marketType];
        const entity =
          params.marketType === "player_prop"
            ? params.playerID!
            : params.side === "home" || params.side === "away"
              ? params.side
              : "all";

        const sidesToFetch: string[] = params.side
          ? [params.side]
          : params.marketType === "moneyline" || params.marketType === "spread"
            ? ["home", "away"]
            : ["over", "under"];

        const lines: NormalizedOddsLine[] = [];
        for (const side of sidesToFetch) {
          const oddID = buildOddID({
            statID,
            entity,
            period: "full_game",
            betType: betTypeCode,
            side,
          });
          const odd = event.odds?.[oddID];
          if (!odd) continue;

          const firstBook = odd.byBookmaker ? Object.entries(odd.byBookmaker)[0] : undefined;
          lines.push({
            oddID,
            statID,
            description:
              params.marketType === "player_prop"
                ? `${params.playerName ?? params.playerID} ${side.toUpperCase()} ${params.marketLabel}`
                : `${params.marketType} (${side})`,
            line: firstBook?.[1]?.spread ?? firstBook?.[1]?.overUnder,
            americanOdds: odd.bookOdds ?? odd.fairOdds ?? firstBook?.[1]?.odds,
            bookmaker: firstBook?.[0],
          });
        }

        if (!lines.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No odds currently available for this market on this event. The market may not be offered for this game right now, or (for player props) confirm the playerID is correct and the player is part of this event's roster.`,
              },
            ],
          };
        }

        const output = {
          eventID: event.eventID,
          homeTeam: event.teams.home.names?.long ?? event.teams.home.teamID,
          awayTeam: event.teams.away.names?.long ?? event.teams.away.teamID,
          lineCount: lines.length,
          lines,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${output.awayTeam} @ ${output.homeTeam} - ${lines.length} odds line(s) found.\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching odds: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
