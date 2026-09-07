import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { extractPricedLine } from "../services/oddsPricing.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

const FuturesInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    contains: z
      .string()
      .optional()
      .describe(
        "Optional filter on the market name, case-insensitive (e.g. 'MVP', 'Super Bowl', 'Win Total', 'Division')."
      ),
    maxMarkets: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(25)
      .describe("Cap on how many priced selections to return (default 25)."),
  })
  .strict();

type FuturesInput = z.infer<typeof FuturesInputSchema>;

/**
 * Futures / outright markets - season-long bets not tied to a single game.
 *
 * WHY THIS IS USEFUL BEYOND CURIOSITY: every other tool here is event-scoped and
 * expires within hours. Futures content does not go stale the same day, which makes
 * it the right fill for periods with no slate - most immediately the WNBA FIBA World
 * Cup break (31 Aug - 16 Sep 2026), which lands directly on NFL kickoff week.
 *
 * HOW SGO STRUCTURES THESE: futures are events with a `type` other than "match",
 * carrying the same odds object shape as games. This tool pulls non-match events for
 * the league and reads their markets. The exact type string is NOT independently
 * confirmed - every event seen in live testing so far has been type "match" - so if
 * this returns nothing, that is the first thing to check via tkb_debug_raw_event.
 * It fails with an explanation rather than pretending the markets do not exist.
 *
 * The same pricing guardrail applies as everywhere else: fair-odds estimates are
 * never returned as though they were real prices.
 */
export function registerFuturesTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_futures",
    {
      title: "Get Futures / Outright Odds",
      description: `Get season-long futures odds - MVP, championship winner, division winner,
season win totals, and similar outright markets that are not tied to one game.

WHY USE THIS: unlike game lines, futures do not expire the same day, so they work well
for standalone posts, off-day content, and stretches with no slate (the WNBA World Cup
break, MLB off-days, the gap between CFB Saturdays).

Args:
  - sport ('mlb'|'wnba'|'nfl'|'cfb')
  - contains (optional): filter market names, e.g. 'MVP', 'Super Bowl', 'Win Total'
  - maxMarkets (default 25): cap on returned selections

Returns: market name, the selection, real book odds, and the pricing bookmaker.

PRICING GUARDRAIL: same rule as every other odds tool here. Only genuinely
book-priced selections are returned. Fair-odds model estimates are never surfaced
as real odds.

Examples:
  - Use when: "what are the NFL MVP odds?" -> sport="nfl", contains="MVP"
  - Use when: building an off-day standalone post
  - Don't use when: you need a specific game's line - use tkb_get_odds

Error Handling:
  - If no futures events are found, returns an explanation including the likely cause
    (SGO's futures event type is not yet confirmed against a live response) rather
    than silently returning nothing`,
      inputSchema: FuturesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: FuturesInput) => {
      try {
        const leagueID = sgo.leagueIDFor(params.sport);

        const events = await sgo.getAllEvents({
          leagueID,
          oddsAvailable: true,
          finalized: false,
          limit: 100,
        });

        // Games are type "match"; anything else is a futures/outright container.
        const futuresEvents = events.filter((e) => e.type && e.type !== "match");

        if (!futuresEvents.length) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No futures markets found for ${params.sport.toUpperCase()}.\n\n` +
                  `Two possible causes, and they need different responses:\n\n` +
                  `1. SportsGameOdds may not expose futures on this plan or for this league. Check the SGO dashboard.\n` +
                  `2. More likely: the event "type" value used to identify futures is not yet confirmed. Every event seen in live ` +
                  `testing so far has been type "match", so the exact string for outright markets is an inference. Run ` +
                  `tkb_debug_raw_event on any event and inspect the top-level "type" field to confirm what futures actually look like, ` +
                  `then adjust the filter in src/tools/futures.ts.\n\n` +
                  `Until confirmed, pull futures odds via live web search rather than assuming they are unavailable.`,
              },
            ],
          };
        }

        const needle = params.contains?.toLowerCase();
        const selections: {
          market: string;
          selection: string;
          americanOdds: string;
          bookmaker?: string;
          eventID: string;
        }[] = [];
        let unpricedCount = 0;

        for (const event of futuresEvents) {
          for (const [oddID, odd] of Object.entries(event.odds ?? {})) {
            const marketName = odd.marketName ?? oddID;
            if (needle && !marketName.toLowerCase().includes(needle)) continue;

            const pricing = extractPricedLine(odd, {
              requireLine: false,
              marketDescription: marketName,
            });
            if (!pricing.priced) {
              unpricedCount++;
              continue;
            }

            selections.push({
              market: marketName,
              selection: odd.statEntityID ?? odd.sideID ?? oddID,
              americanOdds: pricing.value!.americanOdds,
              bookmaker: pricing.value!.bookmaker,
              eventID: event.eventID,
            });

            if (selections.length >= params.maxMarkets) break;
          }
          if (selections.length >= params.maxMarkets) break;
        }

        if (!selections.length) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Found ${futuresEvents.length} futures event(s) for ${params.sport.toUpperCase()}, but no selections matching` +
                  (needle ? ` "${params.contains}"` : "") +
                  ` are currently priced by a sportsbook` +
                  (unpricedCount ? ` (${unpricedCount} unpriced selection(s) skipped).` : `.`) +
                  `\n\nTry a broader 'contains' filter, or retry closer to the season when books post fuller futures boards.`,
              },
            ],
          };
        }

        const output = {
          sport: params.sport,
          futuresEventCount: futuresEvents.length,
          count: selections.length,
          unpricedSkipped: unpricedCount,
          selections,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${selections.length} priced futures selection(s) for ${params.sport.toUpperCase()}.\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching futures: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
