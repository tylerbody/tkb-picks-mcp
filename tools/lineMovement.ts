import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { extractPricedLine, roundToNearestTen } from "../services/oddsPricing.js";
import { SUPPORTED_SPORTS, DEFAULT_BOOKMAKERS, type SportKey } from "../constants.js";

/**
 * LINE MOVEMENT
 *
 * WHY THIS IS WORTH A TOOL: "this total opened at 8.5 and it's 10 now" is a
 * genuinely interesting sentence to a betting audience, and it is content that
 * needs no pick attached to it. It also strengthens a reasoning bullet in a way
 * nothing else in this connector can - a number moving is evidence about what the
 * market learned, which is different in kind from a hit rate or an injury note.
 *
 * IT COSTS NOTHING EXTRA. SGO exposes opening odds on the same event object via
 * includeOpenCloseOdds, so this is one flag on a fetch already being made rather
 * than a new class of request. That matters given the per-event billing model
 * that made other additions expensive.
 *
 * WHAT MOVEMENT DOES AND DOES NOT TELL YOU: a line moving toward a side means
 * money and/or information arrived on that side. It does NOT mean that side is
 * more likely to win - by the time the number has moved, the value that caused
 * the move is largely gone. This tool therefore reports the movement plainly and
 * refuses to characterise it as a signal to follow, because dressing market
 * movement up as an edge is exactly the kind of reasoning this account's rules
 * already ban elsewhere.
 */

const LineMovementInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventID: z.string().describe("SGO eventID from tkb_get_schedule."),
    marketType: z
      .enum(["moneyline", "spread", "total", "player_prop"])
      .default("total")
      .describe("Which market to track. Totals and spreads move most visibly."),
    side: z
      .enum(["over", "under", "home", "away"])
      .default("over")
      .describe("Which side of the market."),
    marketLabel: z.string().optional().describe("Required for player_prop, e.g. 'Hits'."),
    playerID: z.string().optional().describe("Required for player_prop."),
    playerName: z.string().optional(),
    preferredBookmakers: z
      .string()
      .default(DEFAULT_BOOKMAKERS)
      .describe(
        "Comma-separated bookmaker IDs to price against. DEFAULTS to the shared list in src/constants.ts. ADDED IN v2.8.6 - this tool previously accepted no book parameter at all and sent no bookmakerID, so it priced against whichever venue SGO returned first. Pass 'all' to disable for diagnosis only."
      ),
  })
  .strict();

type LineMovementInput = z.infer<typeof LineMovementInputSchema>;

const MARKET_TYPE_CODE: Record<string, "ml" | "sp" | "ou"> = {
  moneyline: "ml",
  spread: "sp",
  total: "ou",
  player_prop: "ou",
};

export function registerLineMovementTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_line_movement",
    {
      title: "Compare opening odds to current odds",
      description: `Show how a line has moved from open to now - the number it opened at, where it
sits currently, and the size and direction of the move.

WHY IT IS USEFUL: "this total opened at 8.5 and it's 10 now" is postable on its own,
with no pick attached, and it also strengthens a reasoning bullet in a way a hit rate
cannot. Costs no extra requests - opening odds ride along on the same event fetch.

Args:
  - sport, eventID
  - marketType ('moneyline'|'spread'|'total'|'player_prop', default 'total')
  - side ('over'|'under'|'home'|'away')
  - marketLabel + playerID for player props

Returns: opening line and price, current line and price, the movement, and a
plain-language description.

IMPORTANT INTERPRETATION NOTE: a line moving toward a side means money or information
arrived there. It does NOT mean that side is now more likely to win - by the time the
number moved, the value that caused it is largely gone. This tool reports movement as
a fact and does not present it as a reason to follow.

Examples:
  - Use when: building a standalone "the market moved" post
  - Use when: a total looks off and you want to know whether it moved to get there
  - Don't use when: you just need the current price - use tkb_get_odds

Error Handling:
  - Reports honestly when SGO carries no opening data for a market rather than
    presenting the current line as if it were the open`,
      inputSchema: LineMovementInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: LineMovementInput) => {
      try {
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
          const market = OU_PROP_MARKETS[params.sport].find(
            (m) => m.label.toLowerCase() === params.marketLabel!.toLowerCase()
          );
          if (!market) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `"${params.marketLabel}" is not a recognized ${params.sport.toUpperCase()} prop market.`,
                },
              ],
              isError: true,
            };
          }
          statID = market.statID;
        }

        const entity =
          params.marketType === "player_prop"
            ? params.playerID!
            : params.marketType === "total"
              ? "all"
              : params.side;

        const oddID = buildOddID({
          statID,
          entity,
          period: "full_game",
          betType: MARKET_TYPE_CODE[params.marketType]!,
          side: params.side,
        });

        // v2.8.3 MEASURED THIS TOOL PRICING OFF BetOnline and recorded it as a
        // missing-parameter problem. It was half that. The other half was that the
        // pricing layer had no offshore set, so with no filter there was nothing
        // left to catch it. v2.8.6 fixes both ends.
        const bookFilter =
          params.preferredBookmakers.trim().toLowerCase() === "all"
            ? undefined
            : params.preferredBookmakers;

        const events = await sgo.getAllEvents({
          leagueID: sgo.leagueIDFor(params.sport),
          eventIDs: params.eventID,
          oddIDs: oddID,
          includeOpenCloseOdds: true,
          bookmakerID: bookFilter,
        });

        if (!events.length) {
          return {
            content: [
              { type: "text" as const, text: `No event found for eventID "${params.eventID}".` },
            ],
          };
        }

        const event = events[0]!;
        const odd = event.odds?.[oddID] as Record<string, unknown> | undefined;

        if (!odd) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No market found for ${oddID} on this event.`,
              },
            ],
          };
        }

        const current = extractPricedLine(odd as never, {
          requireLine: params.marketType !== "moneyline",
          marketDescription: `${params.marketType} ${params.side}`,
        });

        const openOddsRaw = odd.openOdds ?? odd.openBookOdds;
        const openLineRaw = odd.openOverUnder ?? odd.openSpread;

        const openLine =
          typeof openLineRaw === "string" ? parseFloat(openLineRaw) : (openLineRaw as number | undefined);
        const currentLine = current.priced && current.value?.line ? parseFloat(current.value.line) : undefined;

        if (openOddsRaw === undefined && openLineRaw === undefined) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No opening data available for this market on SportsGameOdds.\n\n` +
                  `Current: ${current.priced ? `${current.value?.line ?? ""} ${current.value?.americanOdds}` : "not priced"}\n\n` +
                  `Opening odds coverage is not universal - do NOT present the current number as ` +
                  `though it were the open.`,
              },
            ],
          };
        }

        const lineMove =
          openLine !== undefined && currentLine !== undefined && Number.isFinite(openLine)
            ? Number((currentLine - openLine).toFixed(2))
            : null;

        const direction =
          lineMove === null || lineMove === 0
            ? "no movement"
            : lineMove > 0
              ? `up ${Math.abs(lineMove)}`
              : `down ${Math.abs(lineMove)}`;

        const description =
          lineMove !== null && lineMove !== 0
            ? `Opened at ${openLine} and sits at ${currentLine} now, ${direction}.`
            : openLine !== undefined
              ? `Line has not moved from its ${openLine} open.`
              : `Price moved but the line itself is unavailable.`;

        const output = {
          eventID: event.eventID,
          matchup: `${event.teams.away.names?.long ?? event.teams.away.teamID} @ ${event.teams.home.names?.long ?? event.teams.home.teamID}`,
          market: params.marketType,
          side: params.side,
          player: params.playerName ?? params.playerID ?? null,
          openingLine: openLine ?? null,
          openingOdds: openOddsRaw ? String(openOddsRaw) : null,
          currentLine: currentLine ?? null,
          currentOdds: current.priced ? current.value?.americanOdds ?? null : null,
          currentOddsRounded: current.priced && current.value?.americanOdds
            ? roundToNearestTen(current.value.americanOdds)
            : null,
          lineMovement: lineMove,
          movementDirection: direction,
          description,
          bookmaker: current.priced ? current.value?.bookmaker ?? null : null,
        };

        return {
          content: [
            {
              type: "text" as const,
              text:
                `${description}\n\n${JSON.stringify(output, null, 2)}\n\n` +
                `Interpretation caution: movement shows where money and information went. It is ` +
                `NOT evidence the side is more likely to win - the value that caused the move is ` +
                `mostly gone by the time it shows up in the number.`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching line movement: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
