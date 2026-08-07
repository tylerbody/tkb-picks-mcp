import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID, PERIOD_CODES } from "../services/oddIdBuilder.js";
import { SUPPORTED_PERIODS } from "../services/marketCatalog.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

const PeriodOddsInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventID: z.string().describe("SGO eventID for the game, from tkb_get_schedule."),
    period: z
      .string()
      .describe(
        "Which period, e.g. '1st_half', '1st_5_innings', '3rd_quarter'. Valid options vary by sport - MLB supports innings-based periods, others support half/quarter periods. Returns valid options in the error if an unsupported period is given for this sport."
      ),
    betType: z
      .enum(["moneyline", "spread", "total"])
      .describe("Which market type for this period: moneyline, spread, or total (over/under)."),
    side: z
      .enum(["home", "away", "over", "under"])
      .describe("Which side of the bet - home/away for moneyline/spread, over/under for total."),
  })
  .strict();

type PeriodOddsInput = z.infer<typeof PeriodOddsInputSchema>;

const BET_TYPE_CODE: Record<string, "ml" | "sp" | "ou"> = {
  moneyline: "ml",
  spread: "sp",
  total: "ou",
};

export function registerPeriodOddsTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_period_odds",
    {
      title: "Get Period-Specific Odds",
      description: `Get moneyline/spread/total odds for a specific PERIOD of a game rather than
the full event - first half, first 5 innings, a specific quarter, etc.

Args:
  - sport, eventID
  - period: e.g. "1st_half", "1st_5_innings", "3rd_quarter". Valid periods differ
    by sport - MLB uses innings-based periods (1st_inning through 9th_inning, plus
    1st_3/5/7_innings), other sports use half/quarter periods.
  - betType ('moneyline'|'spread'|'total')
  - side ('home'|'away'|'over'|'under')

Returns: the odds line and price for that specific period/market combination.

Examples:
  - Use when: "What's the first 5 innings line?" -> period="1st_5_innings", betType="moneyline"
  - Use when: "First half spread for this game?" -> period="1st_half", betType="spread"
  - Don't use when: you want the full-game line - use tkb_get_odds instead

Error Handling:
  - Returns the list of valid periods for this sport if an unsupported period is given
  - Returns a clear "no odds available" message rather than an error if the market
    exists but isn't currently priced for this game`,
      inputSchema: PeriodOddsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: PeriodOddsInput) => {
      try {
        const validPeriods = SUPPORTED_PERIODS[params.sport];
        if (!validPeriods.includes(params.period)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${params.period}" is not a supported period for ${params.sport.toUpperCase()}. Valid periods: ${validPeriods.join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        const betTypeCode = BET_TYPE_CODE[params.betType];
        const entity =
          params.side === "over" || params.side === "under" ? "all" : params.side;
        const side = params.side;

        const oddID = buildOddID({
          statID: "points",
          entity,
          period: params.period as keyof typeof PERIOD_CODES,
          betType: betTypeCode,
          side,
        });

        const leagueID = sgo.leagueIDFor(params.sport);
        const events = await sgo.getAllEvents({
          leagueID,
          eventIDs: params.eventID,
          oddsAvailable: true,
          oddIDs: oddID,
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
        const odd = event.odds?.[oddID];

        if (!odd) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No odds currently available for ${params.period} ${params.betType} (${params.side}) in this event. This market may not be offered for this game, or the period code mapping used here hasn't been verified against a live response yet - flag this if it keeps happening.`,
              },
            ],
          };
        }

        const firstBook = odd.byBookmaker ? Object.entries(odd.byBookmaker)[0] : undefined;
        const output = {
          period: params.period,
          betType: params.betType,
          side: params.side,
          eventID: event.eventID,
          line: firstBook?.[1]?.spread ?? firstBook?.[1]?.overUnder,
          americanOdds: odd.bookOdds ?? odd.fairOdds ?? firstBook?.[1]?.odds,
          bookmaker: firstBook?.[0],
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${params.period} ${params.betType} (${params.side}): ${output.line ?? ""} ${output.americanOdds ?? "no price"}\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching period odds: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
