import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { extractPricedLine } from "../services/oddsPricing.js";
import { SUPPORTED_SPORTS, supportsCapability, unsupportedMessage, DEFAULT_BOOKMAKERS, type SportKey } from "../constants.js";
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
    preferredBookmakers: z
      .string()
      .default(DEFAULT_BOOKMAKERS)
      .describe(
        "Comma-separated bookmaker IDs to price against. DEFAULTS to the shared DEFAULT_BOOKMAKERS list in src/constants.ts (draftkings, fanduel, betmgm, caesars, hardrockbet). Pass 'all' to disable the filter for diagnosis only - never publish a price from an unfiltered board. BEHAVIOUR CHANGE IN v2.8.6: this was previously optional with NO default, so a caller who omitted it got whichever book SGO happened to return first - which on a soft board is routinely an offshore or pick'em venue. v2.6.2 made the book list a policy rather than a parameter and applied it to three tools; this one was missed."
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
player's over/under prop. Uses exact market construction (not fuzzy text matching)
AND requests only the specific oddID(s) needed from the API directly (not the full
event's 1000+ markets), so results are precise and fast.

Args:
  - sport, and either eventID or teamName to identify the game
  - marketType ('moneyline'|'spread'|'total'|'player_prop', default 'player_prop')
  - marketLabel: required for player_prop - exact stat name (e.g. "Hits", "Passing Yards").
    Must match this sport's supported list, which the tool returns if the label doesn't match.
  - playerID: required for player_prop
  - side ('over'|'under'|'home'|'away'): omit to get both sides of the line
  - preferredBookmakers: optional, comma-separated (e.g. "fanduel,draftkings") to narrow
    which book's price is returned, for consistency across calls

Returns: the odds line(s) with American odds, the line number, and the bookmaker
that priced it.

PRICING GUARDRAIL: this tool only returns markets a REAL sportsbook has priced.
If a market exists in the catalog but no book has posted a price yet, the tool
refuses it and explains why, rather than returning SportsGameOdds' internal
"fair odds" model estimate. Fair odds are not real odds and must never be posted.
Player props in particular are usually not priced until close to game time, so an
"unpriced" result weeks ahead of a game is expected and not a malfunction.

Examples:
  - Use when: "What's Semien's hits prop?" -> marketType="player_prop", marketLabel="Hits", playerID=...
  - Use when: "What's the moneyline for tonight's Rangers game?" -> marketType="moneyline", teamName="Rangers"
  - Use when: "What's the total?" -> marketType="total", teamName="Rangers"
  - Don't use when: you need recent game-log hit-rate stats - use tkb_get_player_hit_rate
  - Don't use when: you need a milestone/yes-no bet (first HR, double-double) - use tkb_get_yes_no_prop
  - Use when: a tennis match winner -> sport="atp"/"wta", marketType="moneyline", side omitted for both players
  - Don't use when: you need a period-specific line (1st half, 1st 5 innings) - use tkb_get_period_odds

TENNIS: moneyline is the ONLY market this account posts for atp/wta, and it is the
only one wired up. Players occupy the home/away participant slots, so 'home'/'away'
select the two players. marketType='player_prop' is refused for tennis with an
explanation rather than returning an empty result.

Error Handling:
  - Returns the full list of valid marketLabel options for this sport if the label doesn't match
  - Returns a clear message if neither eventID nor teamName is given
  - Returns a clear message if player_prop is requested without playerID
  - Returns "NO USABLE ODDS" with an explanation when the market exists but no
    sportsbook has priced it, or when a price came back with no line attached`,
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

        // ONLY player_prop is gated. moneyline/spread/total are event-level and
        // work for every sport including tennis - the ML path is in fact the whole
        // point of the tennis build, so guarding the tool as a whole would break it.
        if (params.marketType === "player_prop" && !supportsCapability(params.sport, "playerProps")) {
          return {
            content: [
              { type: "text" as const, text: unsupportedMessage(params.sport, "playerProps") },
            ],
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

        let statID = "points";
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
        const sidesToFetch: string[] = params.side
          ? [params.side]
          : params.marketType === "moneyline" || params.marketType === "spread"
            ? ["home", "away"]
            : ["over", "under"];

        const oddIDsToFetch = sidesToFetch.map((side) => {
          const entity =
            params.marketType === "player_prop"
              ? params.playerID!
              : params.marketType === "moneyline" || params.marketType === "spread"
                ? side
                : "all";
          return buildOddID({ statID, entity, period: "full_game", betType: betTypeCode, side });
        });

        const leagueID = sgo.leagueIDFor(params.sport);
        const todayISO = new Date().toISOString().slice(0, 10) + "T00:00:00Z";

        // "all" is an explicit diagnostic opt-out, matching gameLines/propBoard/
        // screenProps. Anything else is passed to SGO as a server-side filter,
        // which also shrinks the payload.
        const bookFilter =
          params.preferredBookmakers.trim().toLowerCase() === "all"
            ? undefined
            : params.preferredBookmakers;

        const events = params.eventID
          ? await sgo.getAllEvents({
              leagueID,
              eventIDs: params.eventID,
              oddIDs: oddIDsToFetch.join(","),
              bookmakerID: bookFilter,
            })
          : await sgo.getAllEvents({
              leagueID,
              oddsAvailable: true,
              finalized: false,
              startsAfter: todayISO,
              oddIDs: oddIDsToFetch.join(","),
              bookmakerID: bookFilter,
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
                text: `No matching ${params.sport.toUpperCase()} game found. This market may not be offered for this game yet, or confirm the team name / eventID is correct.`,
              },
            ],
          };
        }

        const event = matched[0];
        const lines: NormalizedOddsLine[] = [];
        const unpricedReasons: string[] = [];

        // Moneyline has no line by nature. Spreads, totals and player props are
        // meaningless without one, so those require it.
        const requireLine = params.marketType !== "moneyline";

        for (const side of sidesToFetch) {
          const entity =
            params.marketType === "player_prop"
              ? params.playerID!
              : params.marketType === "moneyline" || params.marketType === "spread"
                ? side
                : "all";
          const oddID = buildOddID({
            statID,
            entity,
            period: "full_game",
            betType: betTypeCode,
            side,
          });

          const description =
            params.marketType === "player_prop"
              ? `${params.playerName ?? params.playerID} ${side.toUpperCase()} ${params.marketLabel}`
              : `${params.marketType} (${side})`;

          // GUARDRAIL: only accept genuinely book-priced markets. See
          // services/oddsPricing.ts for why fair-odds fallback is banned.
          const pricing = extractPricedLine(event.odds?.[oddID], {
            requireLine,
            marketDescription: description,
          });

          if (!pricing.priced) {
            if (pricing.reason) unpricedReasons.push(pricing.reason);
            continue;
          }

          lines.push({
            oddID,
            statID,
            description,
            line: pricing.value!.line,
            americanOdds: pricing.value!.americanOdds,
            bookmaker: pricing.value!.bookmaker,
          });
        }

        if (!lines.length) {
          const detail = unpricedReasons.length
            ? unpricedReasons.join("\n\n")
            : `No market found for this selection on this event. For player props, confirm the playerID is correct and that the player is on this event's roster (use tkb_get_players).`;
          return {
            content: [
              {
                type: "text" as const,
                text: `NO USABLE ODDS - do not post this pick.\n\n${detail}`,
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
          ...(unpricedReasons.length ? { unpricedSides: unpricedReasons } : {}),
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
