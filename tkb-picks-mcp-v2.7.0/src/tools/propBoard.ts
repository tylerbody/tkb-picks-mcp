import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { extractPricedLine, roundToNearestTen } from "../services/oddsPricing.js";
import { parseOddID, type ParsedOddID } from "../services/oddIdParser.js";
import {
  SUPPORTED_SPORTS,
  supportsCapability,
  unsupportedMessage,
  type SportKey,
} from "../constants.js";

/**
 * PROP BOARD - every priced player market on one event, with NO hit-rate gate.
 *
 * WHY THIS EXISTS, measured 2026-08-27 on the CFB Week 0 slate.
 *
 * tkb_screen_props reported "Screened 43 priced markets across 17 players" for
 * North Carolina @ TCU and then printed NOTHING. Not a bug: no 2026 CFB game had
 * been played, BALLDONTLIE gates NCAAF player stats behind GOAT, so not one of
 * those 43 markets had a computable hit rate, and the screener refuses to rank
 * what it cannot score. Lowering minSample to 0 changed nothing, because the
 * problem was never the threshold - a rate cannot be computed from zero games.
 *
 * The board existed. The connector had already fetched it, filtered it to the
 * bettable books, and counted it. It was then discarded at the last step.
 *
 * Recovering it by hand meant one tkb_get_odds call per player per market, a
 * guess-and-check sweep across 23 markets and 63 players. Ten calls surfaced 7
 * of the 43 markets on that one game, and every "no market found" was ambiguous
 * between "this player has no props" and "I guessed the wrong market".
 *
 * SO THE SPLIT IS: screen_props answers "which of these should I bet", and needs
 * a hit rate to do it. THIS answers "what is actually on the board", and needs
 * nothing but a price. Those are different questions and only the first one is
 * blocked by a missing rate engine.
 *
 * ---- THREE DELIBERATE DIFFERENCES FROM screen_props ----
 *
 * 1. WALKS THE FULL CATALOG, NOT `wanted`. screenProps drops any market it
 *    cannot compute a rate for: NEVER_COUNTABLE kills fantasyScore outright and
 *    UNCOUNTABLE_STATIDS kills combos without a BDL derivation. Correct for a
 *    screener, wrong for a board. Those markets are real, book-priced, and
 *    bettable; the only thing missing is a number this tool never claimed to
 *    provide. On the CFB catalog that exclusion alone hides Fantasy Score.
 *
 * 2. NO PLAYER CAP BY DEFAULT. screenProps caps by sport because each extra
 *    player costs roughly two throttled BDL requests against a 60-second tool
 *    ceiling. This tool makes zero per-player requests, so the cap has no cost
 *    to justify it. maxPlayers is still accepted, and reports when it bites.
 *
 * 3. OVER AND UNDER COLLAPSE ONTO ONE ROW. Two rows per market doubles the
 *    output for no information, and separating them hides the single most useful
 *    thing on a soft board: the two sides disagreeing on the NUMBER. Measured on
 *    the same slate, Jai'den Thomas rushing yards was 79.5 at DraftKings over and
 *    76.5 at FanDuel under, and Brady Kluse receiving was 39.5 against 35.5.
 *    Three and four yards apart. Read as separate rows that looks like two props;
 *    read as one row it is a SPLIT LINE flag telling you the market is unformed
 *    and there is no single number to publish.
 *
 * ---- ON RESPONSE SIZE ----
 *
 * This walks the full odds map, which tools/players.ts records at 1,180 markets
 * on an MLB game inside an hour of first pitch. That is the shape of payload
 * that caused the historical OOM crashes and got tkb_debug_raw_event deleted in
 * v2.0.0 as a quota footgun.
 *
 * Four things bound it, in order of how much work they do:
 *   - periodID must be "game", which drops every half, quarter, inning and set
 *     variant of the same prop
 *   - includeAltLines is OFF by default in SGOClient.getEvents, so alternate
 *     lines never arrive in the first place
 *   - bookmakerID filters server-side to the four books, so most venues never
 *     serialise
 *   - grouping collapses two sides into one row
 *
 * maxRows is the backstop after all of that, and truncation is REPORTED rather
 * than silent, following the ROSTER CLIPPED precedent from v2.6.3. A clipped
 * board that looks complete is the failure mode this connector keeps rediscovering.
 */

/**
 * Same default as screenProps, and a policy rather than a parameter for the same
 * reason stated there: passing it from the nightly tasks was an open follow-up in
 * v2.5.3, v2.5.4 and v2.6.1 and never happened. There is no situation where this
 * account wants to look at a board priced by a book its followers cannot bet.
 */
const DEFAULT_BOOKMAKERS = "draftkings,fanduel,betmgm,caesars";

/**
 * Re-exported so existing callers and tests keep one import site. The parser
 * itself moved to services/oddIdParser.ts in v2.6.5 when it was hardened against
 * the documented six-segment oddID form; see that file for why.
 */
export { parseOddID };
export type { ParsedOddID };

export interface PricedSide {
  playerID: string;
  statID: string;
  side: "over" | "under";
  line: number;
  americanOdds: string;
  bookmaker: string;
}

export interface SidePrice {
  line: number;
  americanOdds: string;
  roundedOdds: string;
  bookmaker: string;
}

export interface BoardRow {
  playerID: string;
  playerName: string;
  team: string;
  market: string;
  statID: string;
  /** The agreed line, or null when the two sides are priced at different numbers. */
  line: number | null;
  /** True when over and under disagree on the number. See splitLineNote. */
  splitLine: boolean;
  splitLineNote: string | null;
  /** Read the per-side numbers off over.line / under.line, never duplicated here. */
  over: SidePrice | null;
  under: SidePrice | null;
  sidesPriced: number;
}

export interface BoardResolvers {
  playerName: (playerID: string) => string;
  team: (playerID: string) => string;
  marketLabel: (statID: string) => string;
}

/**
 * Collapse priced sides into one row per player/market.
 *
 * PURE AND EXPORTED, for the reason given on parseOddID. Both real split-line
 * cases from 2026-08-27 are pinned as tests.
 *
 * A row with only one side priced is KEPT, not dropped. "FanDuel posted the over
 * and nobody posted the under" is real information about a soft market, and
 * silently discarding it would make the board understate what exists - the same
 * class of error as the clipped roster.
 */
export function buildBoardRows(
  sides: PricedSide[],
  resolve: BoardResolvers
): BoardRow[] {
  const byKey = new Map<string, { over?: PricedSide; under?: PricedSide }>();

  for (const s of sides) {
    const key = `${s.playerID}|${s.statID}`;
    const entry = byKey.get(key) ?? {};
    // First price wins if SGO somehow returns the same side twice. Deterministic
    // beats last-write-wins, which would make output depend on map ordering.
    if (s.side === "over" && !entry.over) entry.over = s;
    if (s.side === "under" && !entry.under) entry.under = s;
    byKey.set(key, entry);
  }

  const rows: BoardRow[] = [];

  for (const [key, entry] of byKey) {
    const playerID = key.slice(0, key.lastIndexOf("|"));
    const statID = key.slice(key.lastIndexOf("|") + 1);
    const { over, under } = entry;
    if (!over && !under) continue;

    const splitLine =
      over !== undefined && under !== undefined && over.line !== under.line;

    const toSidePrice = (s: PricedSide | undefined): SidePrice | null =>
      s
        ? {
            line: s.line,
            americanOdds: s.americanOdds,
            roundedOdds: roundToNearestTen(s.americanOdds),
            bookmaker: s.bookmaker,
          }
        : null;

    rows.push({
      playerID,
      playerName: resolve.playerName(playerID),
      team: resolve.team(playerID),
      market: resolve.marketLabel(statID),
      statID,
      line: splitLine ? null : (over?.line ?? under?.line ?? null),
      splitLine,
      splitLineNote: splitLine
        ? `SPLIT LINE: over is ${over!.line} at ${over!.bookmaker}, under is ` +
          `${under!.line} at ${under!.bookmaker}. There is no single number to ` +
          `publish here - pick one book's line and state it, or leave this market alone.`
        : null,
      over: toSidePrice(over),
      under: toSidePrice(under),
      sidesPriced: (over ? 1 : 0) + (under ? 1 : 0),
    });
  }

  // Deterministic ordering: team, then player, then market. Not ranked, because
  // ranking is what screen_props is for and a board that reorders itself between
  // calls is hard to read against a previous pull.
  rows.sort(
    (a, b) =>
      a.team.localeCompare(b.team) ||
      a.playerName.localeCompare(b.playerName) ||
      a.market.localeCompare(b.market)
  );

  return rows;
}

const PropBoardInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]),
    eventID: z.string().describe("SGO eventID from tkb_get_schedule."),
    markets: z
      .array(z.string())
      .optional()
      .describe(
        "Optional market-label filter, e.g. ['Receiving Yards','Rushing Yards']. Omit to see every market in this sport's catalog."
      ),
    preferredBookmakers: z
      .string()
      .default(DEFAULT_BOOKMAKERS)
      .describe(
        "Comma-separated bookmaker IDs to price against. DEFAULTS to 'draftkings,fanduel,betmgm,caesars'. Pass 'all' to disable the filter for diagnosis - never publish a price from an unfiltered board."
      ),
    maxPlayers: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe(
        "Optional cap on players included. NO DEFAULT CAP, unlike tkb_screen_props - this tool makes no per-player requests so there is no latency cost to justify one. If passed, the cut follows SGO's response order rather than player quality, and the board says so."
      ),
    maxRows: z
      .number()
      .int()
      .min(5)
      .max(250)
      .default(80)
      .describe(
        "Backstop on rows returned. A live MLB event can carry 1,180 markets. Truncation is always reported, never silent."
      ),
    includeUnpriced: z
      .boolean()
      .default(false)
      .describe(
        "Also list markets that exist in SGO's catalog for this event but that NO sportsbook has priced. Useful for telling 'not offered' apart from 'not posted yet'. Their prices are model estimates and are never returned, only the market names."
      ),
  })
  .strict();

type PropBoardInput = z.infer<typeof PropBoardInputSchema>;

export function registerPropBoardTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_prop_board",
    {
      title: "Get the full priced prop board for one event",
      description: `Every player prop a real sportsbook has priced on one event, with the line and
both sides, and NO hit-rate requirement.

THE DIFFERENCE FROM tkb_screen_props, which matters: the screener ranks props and
therefore refuses to print anything it cannot score. When no hit rate is computable
it returns an empty board even though a full one exists. Measured 2026-08-27 on CFB
Week 0 - 43 priced markets found, zero printed, because no 2026 games had been
played yet. This tool prints the board.

USE THIS WHEN:
  - "what props are actually on the board for this game?"
  - Early season in any sport, before there is enough played to compute a rate
  - CFB and WNBA generally, where BALLDONTLIE gates player stats behind GOAT
  - You want to see what exists before deciding what to research

USE tkb_screen_props INSTEAD WHEN: you want the board ranked by edge or hit rate
and the sport has a working rate source. This tool deliberately returns no hit
rates, no edge, and no ranking. It answers "what is bettable", not "what is good".

Args:
  - sport, eventID
  - markets (optional): label filter, e.g. ['Receiving Yards']
  - preferredBookmakers (default 'draftkings,fanduel,betmgm,caesars', 'all' to disable)
  - maxPlayers (optional): no default cap
  - maxRows (default 80)
  - includeUnpriced (default false): also name catalog markets no book has priced

Returns per row: player, team, market, line, both sides with real and rounded
odds, and the pricing book for each side.

SPLIT LINE FLAG: when the over and under are priced at DIFFERENT numbers, the row
carries splitLine: true and no single line. That is a real and common state on a
soft board - two Week 0 markets were 3 and 4 yards apart across books - and it
means there is no single number to publish.

PRICING GUARDRAIL: identical to every other odds tool here. Only genuinely
book-priced markets appear. SGO's fairOdds model estimates are never returned as
prices, and pick'em apps, Fliff and prediction markets are blocked at the pricing
layer.

Examples:
  - Use when: "show me every prop on TCU/North Carolina"
  - Use when: a screen returns nothing and you need to know whether that means
    "no value" or "no rate source"
  - Don't use when: you want picks ranked - use tkb_screen_props
  - Don't use when: you already know the exact player and market - use tkb_get_odds

Error Handling:
  - Distinguishes "no markets priced at all" from "none priced at YOUR books"
  - Reports roster clipping and row truncation explicitly, never silently
  - Refused for tennis with an explanation: participants occupy event slots
    rather than roster positions, so there is no player board to build`,
      inputSchema: PropBoardInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: PropBoardInput) => {
      try {
        // Tennis has no roster, permanently. Without this the empty-roster branch
        // below would say "props are not posted yet, retry closer to match time",
        // which is false and invites an indefinite retry - the exact failure the
        // capability flags were added in v2.6.0 to prevent.
        if (!supportsCapability(input.sport as SportKey, "playerProps")) {
          return {
            content: [
              {
                type: "text" as const,
                text: unsupportedMessage(input.sport as SportKey, "playerProps"),
              },
            ],
          };
        }

        const sport = input.sport as SportKey;
        const leagueID = sgo.leagueIDFor(sport);
        const catalog = OU_PROP_MARKETS[sport] ?? [];

        // THE FULL CATALOG, deliberately. See the header note: screenProps filters
        // to markets it can compute a rate for, and that exclusion has no meaning
        // on a board.
        const wanted = input.markets
          ? catalog.filter((m) => input.markets!.includes(m.label))
          : catalog;

        if (wanted.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No markets matched${input.markets ? ` ${input.markets.join(", ")}` : ""} for ` +
                  `${sport.toUpperCase()}.\n\nValid labels: ${catalog.map((m) => m.label).join(", ")}`,
              },
            ],
          };
        }

        const statIDToLabel = new Map(wanted.map((m) => [m.statID, m.label]));

        const bookFilter =
          input.preferredBookmakers.trim().toLowerCase() === "all"
            ? undefined
            : input.preferredBookmakers;

        // ONE fetch. bookmakerID filters server-side, and includeAltLines stays
        // off by default in the client, so the payload is bounded before it is
        // ever walked.
        const events = await sgo.getAllEvents({
          leagueID,
          eventIDs: input.eventID,
          bookmakerID: bookFilter,
        });

        if (!events.length) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No event found for eventID "${input.eventID}".`,
              },
            ],
          };
        }

        const event = events[0]!;
        const homeID = event.teams.home.teamID;
        const awayID = event.teams.away.teamID;
        const teamNames: Record<string, string> = {
          [homeID]: event.teams.home.names?.long ?? homeID,
          [awayID]: event.teams.away.names?.long ?? awayID,
        };
        const matchup = `${teamNames[awayID]} @ ${teamNames[homeID]}`;

        const roster = Object.values(event.players ?? {});
        if (roster.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No players attached to ${matchup} yet.\n\n` +
                  `SGO builds the player list from posted markets, so an empty roster means ` +
                  `"not priced yet" rather than "no players". Player props typically post ` +
                  `within a few days of kickoff, and for MLB often only on the morning of.\n\n` +
                  `Team-level markets (moneyline, spread, total) are available much earlier ` +
                  `via tkb_get_odds or tkb_get_game_lines.`,
              },
            ],
          };
        }

        const rosterClipped =
          input.maxPlayers !== undefined && roster.length > input.maxPlayers;
        const included =
          input.maxPlayers !== undefined ? roster.slice(0, input.maxPlayers) : roster;
        const allowedPlayerIDs = new Set(included.map((p) => p.playerID));
        const playerByID = new Map(roster.map((p) => [p.playerID, p]));

        const sides: PricedSide[] = [];
        const unpriced = new Map<string, string>(); // "player | market" -> reason bucket
        let cancelledCount = 0;

        for (const [oddID, odd] of Object.entries(event.odds ?? {})) {
          const parsed = parseOddID(oddID);
          if (!parsed) continue;

          if (parsed.betType !== "ou") continue;
          if (parsed.period !== "game") continue;
          if (parsed.side !== "over" && parsed.side !== "under") continue;
          if (!statIDToLabel.has(parsed.statID)) continue;
          if (!allowedPlayerIDs.has(parsed.entity)) continue;

          const label = statIDToLabel.get(parsed.statID)!;
          const playerName = playerByID.get(parsed.entity)?.name ?? parsed.entity;

          const priced = extractPricedLine(odd, {
            requireLine: true,
            marketDescription: `${label} for ${playerName}`,
          });

          if (!priced.priced || !priced.value) {
            if (odd.cancelled) {
              cancelledCount++;
            } else {
              // One entry per player/market rather than per side, since both
              // sides of an unpriced market fail for the same reason.
              const key = `${playerName} | ${label}`;
              if (!unpriced.has(key)) {
                unpriced.set(
                  key,
                  odd.fairOdds ? "catalog only, no book has posted" : "no book price"
                );
              }
            }
            continue;
          }

          const line = parseFloat(priced.value.line ?? "");
          if (Number.isNaN(line)) continue;

          sides.push({
            playerID: parsed.entity,
            statID: parsed.statID,
            side: parsed.side,
            line,
            americanOdds: priced.value.americanOdds,
            bookmaker: priced.value.bookmaker ?? "unknown",
          });
        }

        const allRows = buildBoardRows(sides, {
          playerName: (id) => playerByID.get(id)?.name ?? id,
          team: (id) => {
            const t = playerByID.get(id)?.teamID;
            return t ? (teamNames[t] ?? t) : "unknown";
          },
          marketLabel: (statID) => statIDToLabel.get(statID) ?? statID,
        });

        const truncated = allRows.length > input.maxRows;
        const rows = allRows.slice(0, input.maxRows);

        const bookLine = bookFilter
          ? `Priced against: ${bookFilter}.`
          : `Priced against ALL venues - book filter disabled. Diagnostic only; do NOT ` +
            `publish a price from this board without re-pulling at your books.`;

        if (allRows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `NO PRICED PROPS on ${matchup}.\n\n` +
                  `Walked every market on this event and none of them carries a real ` +
                  `sportsbook price` +
                  (bookFilter ? ` at ${bookFilter}` : "") +
                  `. ${unpriced.size} market(s) exist in SGO's catalog with only a ` +
                  `fair-odds model estimate attached, which is never publishable.\n\n` +
                  (bookFilter
                    ? `"Nothing priced" and "nothing priced at YOUR books" are different ` +
                      `statements. Re-run with preferredBookmakers="all" to see which is ` +
                      `true here, for diagnosis only.\n\n`
                    : ``) +
                  `Team-level markets usually post much earlier - try tkb_get_game_lines.`,
              },
            ],
            structuredContent: {
              eventID: input.eventID,
              matchup,
              rows: [],
              pricedRowCount: 0,
              unpricedMarketCount: unpriced.size,
            },
          };
        }

        const distinctPlayers = new Set(rows.map((r) => r.playerID)).size;
        const splitLines = rows.filter((r) => r.splitLine).length;
        const oneSided = rows.filter((r) => r.sidesPriced === 1).length;

        const rosterLine = rosterClipped
          ? ` ROSTER CLIPPED: ${roster.length} players attached, ${input.maxPlayers} ` +
            `included. The cut follows SGO's response order, not player quality. Drop ` +
            `maxPlayers to see the whole board.`
          : "";

        const truncationLine = truncated
          ? ` BOARD TRUNCATED: ${allRows.length} priced market(s) built, ${rows.length} ` +
            `shown. Raise maxRows or narrow with the markets filter.`
          : "";

        const splitLineNote = splitLines
          ? ` ${splitLines} market(s) carry a SPLIT LINE, meaning the two sides are ` +
            `priced at different numbers. Those have no single publishable line.`
          : "";

        const oneSidedNote = oneSided
          ? ` ${oneSided} market(s) have only one side priced.`
          : "";

        const unpricedNote = unpriced.size
          ? ` ${unpriced.size} further market(s) exist in the catalog with no book price ` +
            `yet` +
            (input.includeUnpriced ? `, listed below` : `; pass includeUnpriced to name them`) +
            `.`
          : "";

        const cancelledNote = cancelledCount
          ? ` ${cancelledCount} cancelled market(s) skipped.`
          : "";

        const summary =
          `${rows.length} priced market(s) across ${distinctPlayers} player(s) in ${matchup}.` +
          `\n\n${bookLine}${rosterLine}${truncationLine}${splitLineNote}${oneSidedNote}` +
          `${unpricedNote}${cancelledNote}` +
          `\n\nNO HIT RATES ON THIS BOARD BY DESIGN. This tool reports what is priced, ` +
          `not what is likely to win. Use tkb_screen_props for ranking where a rate ` +
          `source exists, and remember that early-season CFB and any WNBA market have ` +
          `no computable rate at all - preview language only.`;

        const unpricedList = input.includeUnpriced
          ? `\n\nUNPRICED (in catalog, no book has posted):\n` +
            [...unpriced.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([k, reason]) => `- ${k} (${reason})`)
              .join("\n")
          : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `${summary}\n\n${JSON.stringify(rows, null, 2)}${unpricedList}`,
            },
          ],
          structuredContent: {
            eventID: event.eventID,
            matchup,
            pricedRowCount: rows.length,
            totalRowsBuilt: allRows.length,
            truncated,
            distinctPlayers,
            playersAttached: roster.length,
            rosterClipped,
            splitLineCount: splitLines,
            oneSidedCount: oneSided,
            unpricedMarketCount: unpriced.size,
            cancelledCount,
            pricedAgainst: bookFilter ?? "all",
            rows,
            ...(input.includeUnpriced
              ? { unpricedMarkets: [...unpriced.keys()].sort() }
              : {}),
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error building prop board: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
