import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { extractPricedLine, roundToNearestTen } from "../services/oddsPricing.js";
import { SUPPORTED_SPORTS, DEFAULT_BOOKMAKERS, type SportKey } from "../constants.js";
import type { SGOEvent } from "../types.js";

/**
 * SLATE-WIDE TEAM LINES - moneyline, spread and total for many games at once.
 *
 * THE GAP THIS FILLS, found 2026-08-27 alongside the prop-board work. Every
 * thread this account posts carries exactly one team-level pick, and tkb_get_odds
 * handles exactly one game and one market type per call. So assembling the
 * team-level picture for a five-game CFB Saturday costs fifteen calls, and a
 * fifteen-game MLB slate costs forty-five, almost all of it repetition.
 *
 * It also matters more than usual right now. Early-season CFB and any WNBA market
 * have no computable hit rate, so team markets are the only place a defensible
 * pick can come from, and they are the hardest thing in the connector to survey.
 *
 * COST. SGO bills per EVENT OBJECT, not per market, and this attaches at most six
 * oddIDs to each event, so a five-game slate costs about five entities and a full
 * MLB slate about fifteen. Compare roughly 56 entities for ONE screen_props call.
 * Surveying every team line on a slate is close to the cheapest thing this
 * connector can do.
 *
 * TWO FETCH PATHS, both already proven elsewhere in this codebase rather than
 * invented here:
 *   - explicit eventIDs, one fetch each, the pattern tools/gradePicks.ts uses
 *   - a date range, ONE ranged fetch with the oddIDs filter applied, the pattern
 *     tools/odds.ts already uses on its teamName path
 * The ranged path is preferred when available because it is one request rather
 * than N. Passing several IDs as one comma-separated eventIDs value might also
 * work, but it is NOT confirmed against a live response and this connector has
 * been bitten once already by sending a parameter SGO quietly ignored
 * (includeOpposingOdds, corrected 8 Aug 2026), so it is not assumed here.
 *
 * SAME PRICING GUARDRAIL AS EVERYWHERE ELSE. A market with only a fairOdds model
 * estimate is reported as unpriced rather than returned as a number. A moneyline
 * legitimately has no line, so requireLine is false there and true for spread and
 * total - the distinction extractPricedLine already draws.
 */

const MARKET_KINDS = ["moneyline", "spread", "total"] as const;
type MarketKind = (typeof MARKET_KINDS)[number];

const GameLinesInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    eventIDs: z
      .array(z.string())
      .min(1)
      .max(20)
      .optional()
      .describe(
        "Explicit eventIDs from tkb_get_schedule. One fetch per event. Use this OR a date range, not both."
      ),
    date: z
      .string()
      .optional()
      .describe("Single date YYYY-MM-DD. Pulls every game that day in ONE request."),
    startsAfter: z.string().optional().describe("ISO datetime lower bound."),
    startsBefore: z.string().optional().describe("ISO datetime upper bound."),
    markets: z
      .array(z.enum(MARKET_KINDS))
      .optional()
      .describe(
        "Which team markets to pull. Defaults to all three. Narrowing shrinks the payload but not the entity cost, which is per event."
      ),
    preferredBookmakers: z
      .string()
      .default(DEFAULT_BOOKMAKERS)
      .describe(
        "Comma-separated bookmaker IDs to price against. DEFAULTS to the shared DEFAULT_BOOKMAKERS list in src/constants.ts (draftkings, fanduel, betmgm, caesars, hardrockbet). Pass 'all' to disable the filter for diagnosis only - never publish a price from an unfiltered board."
      ),
  })
  .strict();

type GameLinesInput = z.infer<typeof GameLinesInputSchema>;

interface PricedEntry {
  line?: string;
  americanOdds: string;
  roundedOdds: string;
  bookmaker?: string;
}

interface GameLineRow {
  eventID: string;
  matchup: string;
  startTimeISO: string;
  homeTeam: string;
  awayTeam: string;
  moneyline?: { home?: PricedEntry; away?: PricedEntry; favorite?: string | null };
  spread?: { home?: PricedEntry; away?: PricedEntry };
  total?: { over?: PricedEntry; under?: PricedEntry };
  unpriced: string[];
}

/** The six oddIDs a full team-level pull needs. */
function oddIDsFor(kinds: MarketKind[]): string[] {
  const ids: string[] = [];
  if (kinds.includes("moneyline")) {
    ids.push(
      buildOddID({ statID: "points", entity: "home", period: "full_game", betType: "ml", side: "home" }),
      buildOddID({ statID: "points", entity: "away", period: "full_game", betType: "ml", side: "away" })
    );
  }
  if (kinds.includes("spread")) {
    ids.push(
      buildOddID({ statID: "points", entity: "home", period: "full_game", betType: "sp", side: "home" }),
      buildOddID({ statID: "points", entity: "away", period: "full_game", betType: "sp", side: "away" })
    );
  }
  if (kinds.includes("total")) {
    ids.push(
      buildOddID({ statID: "points", entity: "all", period: "full_game", betType: "ou", side: "over" }),
      buildOddID({ statID: "points", entity: "all", period: "full_game", betType: "ou", side: "under" })
    );
  }
  return ids;
}

/**
 * Which side the moneyline makes the favorite.
 *
 * REPORTED AS A FACT, NOT A RECOMMENDATION, for the same reason
 * tools/lineMovement.ts refuses to frame a line move as a signal: the price
 * already contains the information. Naming the favorite saves the reader
 * comparing two negative numbers in their head and nothing more. Note the
 * standing MLB rule that heavy favourites at -155 or shorter have historically
 * won often and still lost money.
 */
function favoriteFrom(
  home: PricedEntry | undefined,
  away: PricedEntry | undefined,
  homeName: string,
  awayName: string
): string | null {
  const h = home ? parseInt(home.americanOdds, 10) : NaN;
  const a = away ? parseInt(away.americanOdds, 10) : NaN;
  if (Number.isNaN(h) || Number.isNaN(a)) return null;
  if (h === a) return null;
  return h < a ? homeName : awayName;
}

function readGame(
  event: SGOEvent,
  kinds: MarketKind[]
): GameLineRow {
  const homeName = event.teams.home.names?.long ?? event.teams.home.teamID;
  const awayName = event.teams.away.names?.long ?? event.teams.away.teamID;

  const row: GameLineRow = {
    eventID: event.eventID,
    matchup: `${awayName} @ ${homeName}`,
    startTimeISO: event.status?.startsAt ?? "unknown",
    homeTeam: homeName,
    awayTeam: awayName,
    unpriced: [],
  };

  const read = (
    oddID: string,
    requireLine: boolean,
    description: string
  ): PricedEntry | undefined => {
    const pricing = extractPricedLine(event.odds?.[oddID], {
      requireLine,
      marketDescription: description,
    });
    if (!pricing.priced || !pricing.value) {
      row.unpriced.push(description);
      return undefined;
    }
    return {
      line: pricing.value.line,
      americanOdds: pricing.value.americanOdds,
      roundedOdds: roundToNearestTen(pricing.value.americanOdds),
      bookmaker: pricing.value.bookmaker,
    };
  };

  if (kinds.includes("moneyline")) {
    const home = read(
      buildOddID({ statID: "points", entity: "home", period: "full_game", betType: "ml", side: "home" }),
      false,
      `${homeName} moneyline`
    );
    const away = read(
      buildOddID({ statID: "points", entity: "away", period: "full_game", betType: "ml", side: "away" }),
      false,
      `${awayName} moneyline`
    );
    if (home || away) {
      row.moneyline = { home, away, favorite: favoriteFrom(home, away, homeName, awayName) };
    }
  }

  if (kinds.includes("spread")) {
    const home = read(
      buildOddID({ statID: "points", entity: "home", period: "full_game", betType: "sp", side: "home" }),
      true,
      `${homeName} spread`
    );
    const away = read(
      buildOddID({ statID: "points", entity: "away", period: "full_game", betType: "sp", side: "away" }),
      true,
      `${awayName} spread`
    );
    if (home || away) row.spread = { home, away };
  }

  if (kinds.includes("total")) {
    const over = read(
      buildOddID({ statID: "points", entity: "all", period: "full_game", betType: "ou", side: "over" }),
      true,
      `game total over`
    );
    const under = read(
      buildOddID({ statID: "points", entity: "all", period: "full_game", betType: "ou", side: "under" }),
      true,
      `game total under`
    );
    if (over || under) row.total = { over, under };
  }

  return row;
}

export function registerGameLinesTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_game_lines",
    {
      title: "Get moneyline, spread and total for a whole slate",
      description: `Team-level lines - moneyline, spread and total - for MANY games in one call.

WHY THIS EXISTS: tkb_get_odds handles one game and one market type per call, so
surveying a five-game CFB Saturday costs fifteen calls and a fifteen-game MLB slate
costs forty-five. This does the same work in one or a few.

CHEAP. SGO bills per EVENT OBJECT and this attaches at most six oddIDs per event,
so a five-game slate is about five entities. One tkb_screen_props call is about 56.

Args:
  - sport
  - EITHER eventIDs (array, up to 20) OR a date / startsAfter / startsBefore range
  - markets (optional): any of 'moneyline', 'spread', 'total'. Defaults to all three.
  - preferredBookmakers (default 'draftkings,fanduel,betmgm,caesars')

Returns per game: matchup, start time, and each requested market with the line,
the real price, the rounded publishable price, and the pricing book. Moneyline
rows also name which side is favoured, as a fact rather than a recommendation.

WHEN THIS IS THE RIGHT TOOL: every thread carries exactly one team-level pick, and
in early-season CFB or any WNBA market there is no computable hit rate, so a team
market is often the only defensible pick available. This is the fastest way to see
all of them at once.

PRICING GUARDRAIL: markets carrying only SGO's fairOdds model estimate are listed
as unpriced rather than returned as numbers. A moneyline has no line by nature and
is not required to have one; spreads and totals are.

Examples:
  - Use when: "what are the lines for Saturday's CFB slate?" -> date range
  - Use when: "pull ML and total for these four eventIDs" -> eventIDs + markets
  - Don't use when: you need one specific market on one game - use tkb_get_odds
  - Don't use when: you need player props - use tkb_get_prop_board

Error Handling:
  - Requires either eventIDs or a date bound, and says so rather than pulling
    an unbounded multi-season history
  - Games with no priced team markets are listed explicitly rather than dropped,
    so a short result is never mistaken for a short slate`,
      inputSchema: GameLinesInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: GameLinesInput) => {
      try {
        const kinds: MarketKind[] = input.markets?.length
          ? input.markets
          : [...MARKET_KINDS];

        const hasRange = Boolean(input.date || input.startsAfter || input.startsBefore);
        if (!input.eventIDs?.length && !hasRange) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Provide either eventIDs or a date bound (date, or startsAfter/startsBefore).\n\n` +
                  `Neither was given, and an unbounded pull returns multiple seasons of ` +
                  `history - a real bug this connector has already hit once on the schedule tool.`,
              },
            ],
            isError: true,
          };
        }

        const leagueID = sgo.leagueIDFor(input.sport as SportKey);
        const oddIDs = oddIDsFor(kinds).join(",");
        const bookFilter =
          input.preferredBookmakers.trim().toLowerCase() === "all"
            ? undefined
            : input.preferredBookmakers;

        let events: SGOEvent[] = [];
        let requestCount = 0;
        let missingEventIDs: string[] = [];

        if (input.eventIDs?.length) {
          // BATCHED IN v2.6.5. v2.6.4 fetched one event at a time because
          // comma-separated eventIDs was unverified. SGO's best-practices doc
          // settles it: "query by eventID or eventIDs - this is the fastest query
          // path". So N requests become 1.
          //
          // THE DOCUMENTED CAVEAT, worth knowing: when eventIDs is supplied every
          // OTHER filter is ignored (leagueID, live, startsAfter and so on). Only
          // the response-shaping params - oddID, bookmakerID, playerID - still
          // apply. That is fine here since the IDs already identify the games, but
          // it means you cannot combine eventIDs with a date bound and expect the
          // date to do anything.
          requestCount = 1;
          events = await sgo.getAllEvents({
            leagueID,
            eventIDs: input.eventIDs.join(","),
            oddIDs,
            bookmakerID: bookFilter,
            limit: 100,
          });

          // Report anything asked for that did not come back, rather than
          // silently returning a shorter list than was requested.
          const returned = new Set(events.map((e) => e.eventID));
          missingEventIDs = input.eventIDs.filter((id) => !returned.has(id));
        } else {
          let startsAfter = input.startsAfter;
          let startsBefore = input.startsBefore;
          if (input.date) {
            startsAfter = `${input.date}T00:00:00Z`;
            startsBefore = `${input.date}T23:59:59Z`;
          }
          requestCount = 1;
          events = await sgo.getAllEvents({
            leagueID,
            startsAfter,
            startsBefore,
            oddIDs,
            bookmakerID: bookFilter,
            limit: 100,
          });
        }

        if (!events.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No ${input.sport.toUpperCase()} games found for the requested events or window.`,
              },
            ],
          };
        }

        const rows = events
          .map((e) => readGame(e, kinds))
          .sort((a, b) => a.startTimeISO.localeCompare(b.startTimeISO));

        const withSomething = rows.filter(
          (r) => r.moneyline || r.spread || r.total
        );
        const withNothing = rows.filter((r) => !r.moneyline && !r.spread && !r.total);

        const bookLine = bookFilter
          ? `Priced against: ${bookFilter}.`
          : `Priced against ALL venues - filter disabled. Diagnostic only.`;

        const missingLine = missingEventIDs.length
          ? `\n\nREQUESTED BUT NOT RETURNED (${missingEventIDs.length}): ` +
            `${missingEventIDs.join(", ")}. Confirm these eventIDs are correct and belong to ` +
            `${input.sport.toUpperCase()}.`
          : "";

        const emptyLine = withNothing.length
          ? `\n\nNO PRICED TEAM MARKETS on ${withNothing.length} game(s): ` +
            `${withNothing.map((r) => r.matchup).join("; ")}. Listed rather than dropped, ` +
            `so a short board is never mistaken for a short slate.`
          : "";

        const summary =
          `${rows.length} game(s), ${withSomething.length} with at least one priced team ` +
          `market. Markets pulled: ${kinds.join(", ")}. ${requestCount} request(s), ` +
          `roughly ${events.length} entities.\n\n${bookLine}${missingLine}${emptyLine}\n\n` +
          `Use roundedOdds when publishing. Lines move, so re-pull before a thread ships.`;

        return {
          content: [
            { type: "text" as const, text: `${summary}\n\n${JSON.stringify(rows, null, 2)}` },
          ],
          structuredContent: {
            sport: input.sport,
            gameCount: rows.length,
            gamesWithPricedMarkets: withSomething.length,
            marketsPulled: kinds,
            requestCount,
            pricedAgainst: bookFilter ?? "all",
            games: rows,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching game lines: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
