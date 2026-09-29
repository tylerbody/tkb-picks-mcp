import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import {
  OU_PROP_MARKETS,
  YES_NO_MARKETS,
  yesNoGradingFor,
} from "../services/marketCatalog.js";
import { allBookPrices, extractPricedLine, roundToNearestTen, type BookPrice } from "../services/oddsPricing.js";
import { PERIOD_CODES } from "../services/oddIdBuilder.js";
import {
  flexBoolean,
  flexIntOptional,
  asBoolean,
  asNumber,
} from "../services/flexibleInput.js";
import { parseOddID, type ParsedOddID } from "../services/oddIdParser.js";
import {
  participantModel,
  SUPPORTED_SPORTS,
  supportsCapability,
  unsupportedMessage,
  DEFAULT_BOOKMAKERS,
  type SportKey,
} from "../constants.js";
import { readMatchTeams } from "../services/eventShape.js";

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
 * The book list moved to src/constants.ts in v2.8.6 - it was declared identically
 * here and in screenProps.ts and a third time inline in gameLines.ts. See
 * DEFAULT_BOOKMAKERS there for the reasoning, including why hardrockbet was added
 * and what it does to an early-season CFB board.
 */

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
  /** Every real book's price on this side, best first. v2.10.5. */
  allBooks?: BookPrice[];
}

export interface SidePrice {
  line: number;
  americanOdds: string;
  roundedOdds: string;
  /**
   * v2.10.5. The best price any real book has on this side, and whether the book
   * shown above is that book. `firstAvailableBook` picks whichever venue SGO
   * returned first, so these two routinely differ, and a caller that publishes
   * `americanOdds` without reading `bestPrice` is accepting a worse number than the
   * account can actually get.
   */
  bestPrice?: { bookmaker: string; americanOdds: string; line?: string } | null;
  betterPriceAvailable?: boolean;
  bookCount?: number;
  /**
   * v2.11.0. How many of those books are quoting THIS row's line. `bookCount` counts
   * every real book with a price on the side; this counts the ones offering the same
   * bet. When they differ, the rest of the field is priced at other numbers.
   */
  bookCountAtLine?: number;
  /**
   * v2.11.0. A longer price that exists at a DIFFERENT line, reported separately
   * because it is a different bet and must never be published as this row's number.
   * Null when the best price in the field is already at this line.
   */
  betterPriceAtDifferentLine?: {
    bookmaker: string;
    americanOdds: string;
    line?: string;
    note: string;
  } | null;
  /** Populated only when includeAllBooks is set, to keep the default payload small. */
  allBooks?: BookPrice[];
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
 * ROW CAP BY SPORT, v2.10.7.
 *
 * A flat 80 was wrong in a way that was invisible. Measured 2026-09-28 on
 * Philadelphia at Chicago, eventID iVXqTw1LGEj0TGVxDgTs: 142 rows built, 70 returned,
 * and every returned row was a Bears player, because the truncation cut follows SGO's
 * response order rather than anything meaningful. A thread builder reading that board
 * saw half a game and had no way to know.
 *
 * The numbers below are sized off measured row counts per sport, not guessed:
 * NFL carries the widest market set (22 distinct on one team's half of a board), a
 * full MLB event has been measured at 254 built rows and can carry far more markets
 * than that, and NHL at 102. The cap exists to stop an unbounded payload, so it is
 * set well above a normal full board rather than near it.
 */
export function defaultMaxRowsFor(sport: SportKey): number {
  switch (sport) {
    case "nfl":
    case "mlb":
      return 400;
    case "cfb":
    case "nhl":
      return 300;
    default:
      return 150;
  }
}

/**
 * Is this book's line the same number as the row's line? v2.11.0.
 *
 * `undefined` is NOT a match. A book entry with no line attached cannot be confirmed
 * to be quoting the same bet, and assuming it does is how a price from another number
 * gets published as this one.
 */
export function lineMatches(bookLine: string | undefined, rowLine: number): boolean {
  if (bookLine === undefined) return false;
  const n = parseFloat(bookLine);
  return !Number.isNaN(n) && n === rowLine;
}

/** Is American odds `a` a longer price than `b`? Longer is better on either side. */
export function americanIsLonger(a: string, b: string): boolean {
  const v = (x: string) => {
    const n = parseFloat(String(x).replace(/[+\s]/g, ""));
    return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n;
  };
  return v(a) > v(b);
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
  resolve: BoardResolvers,
  opts: { includeAllBooks?: boolean } = {}
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

    const toSidePrice = (s: PricedSide | undefined): SidePrice | null => {
      if (!s) return null;
      /* v2.10.5: surface the best available price alongside the selected one. The
       * selected book comes from firstAvailableBook, which is arbitrary, so these
       * differ often enough that hiding the difference costs real money.
       *
       * ---- THE LINE BUG, FIXED v2.11.0 ----
       *
       * `books[0]` is the longest price in the field REGARDLESS OF LINE, because
       * allBookPrices sorts on price alone. So a row could say: under 4.5 is -164 at
       * DraftKings, better price +120 at Caesars. Measured live on 2026-09-29,
       * Courtney Williams rebounds. Those are not the same bet. Caesars was quoting
       * 3.5. Anyone shopping off that field would have moved to a different market
       * believing they had found 284 cents of value that does not exist.
       *
       * The comparison is now confined to books quoting THIS row's line. A longer
       * price at another number is still reported, in its own field, labelled as a
       * different bet. An entry with no line at all cannot be confirmed as the same
       * bet, so it is excluded from the comparison rather than assumed to match. */
      const books = s.allBooks ?? [];
      const atThisLine = books.filter((b) => lineMatches(b.line, s.line));
      const best = atThisLine[0];
      const offLine = books.find((b) => !lineMatches(b.line, s.line));
      const offLineIsBetter =
        offLine !== undefined &&
        (best === undefined ||
          americanIsLonger(offLine.americanOdds, best.americanOdds));
      return {
        line: s.line,
        americanOdds: s.americanOdds,
        roundedOdds: roundToNearestTen(s.americanOdds),
        bookmaker: s.bookmaker,
        bestPrice: best
          ? { bookmaker: best.bookmaker, americanOdds: best.americanOdds, line: best.line }
          : null,
        betterPriceAvailable: Boolean(best && best.bookmaker !== s.bookmaker),
        bookCount: books.length,
        bookCountAtLine: atThisLine.length,
        betterPriceAtDifferentLine: offLineIsBetter
          ? {
              bookmaker: offLine!.bookmaker,
              americanOdds: offLine!.americanOdds,
              line: offLine!.line,
              note:
                `DIFFERENT BET: this price is on ${offLine!.line ?? "an unstated line"}, ` +
                `not ${s.line}. Do not publish it as this row's number.`,
            }
          : null,
        ...(opts.includeAllBooks ? { allBooks: books } : {}),
      };
    };

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

/* ===========================================================================
 * YES/NO MARKETS ON THE BOARD, v2.11.0
 *
 * Until now this board discarded every yes/no odd and counted it under
 * `notOverUnder`. That bucket was the largest measured hole anywhere in the
 * connector: 686 of 1104 odds on an NHL board, 757 of 1814 on an NFL board, 98 to 108
 * per WNBA board. A board that drops three fifths of an event's markets and calls
 * itself the prop board is misnamed.
 *
 * THEY COST NOTHING TO ADD. The yes/no odds are already in the same event payload the
 * board fetches; `seenOdds` has been counting them the whole time. This release stops
 * throwing them away. No extra request, no extra entity billed.
 *
 * WHY THEY ARE A SEPARATE SECTION rather than extra rows in `rows`. A yes/no market
 * has no line and no over/under, so forcing it into BoardRow would mean a null line
 * and two sides named the wrong thing. Every existing consumer reading `rows` would
 * have to learn to skip them. A second array with its own shape breaks nothing and
 * reads honestly.
 *
 * WHY THEY ARE OPT-IN. An NHL board carries roughly 340 yes/no rows on top of its 112
 * over/under rows, and the full response already runs against the tool-result size
 * ceiling. Returning both by default would push every NHL and NFL call over it, which
 * would be a worse failure than the one being fixed. `includeYesNo` turns them on and
 * the coverage block always reports how many are waiting, so nothing is hidden.
 */

export interface YesNoPricedSide {
  playerID: string;
  statID: string;
  side: "yes" | "no";
  americanOdds: string;
  bookmaker: string;
  allBooks?: BookPrice[];
}

export interface YesNoSidePrice {
  americanOdds: string;
  roundedOdds: string;
  bookmaker: string;
  /** No line filtering here: a yes/no market has one question, so every book on it
   * is quoting the same bet. This is the one place the v2.11.0 line guard does not
   * apply, and it does not apply because there is no line to disagree about. */
  bestPrice?: { bookmaker: string; americanOdds: string } | null;
  betterPriceAvailable?: boolean;
  bookCount?: number;
  allBooks?: BookPrice[];
}

export type YesNoCrossCheck = {
  status: "agrees" | "mismatch" | "no_comparable_line";
  book: string | null;
  yesPrice: string | null;
  overPrice: string | null;
  detail: string;
};

export interface YesNoBoardRow {
  playerID: string;
  playerName: string;
  team: string;
  market: string;
  statID: string;
  yes: YesNoSidePrice | null;
  no: YesNoSidePrice | null;
  sidesPriced: number;
  /** Can tkb_grade_pick settle this market. Derived in marketCatalog.ts. */
  gradeable: boolean;
  /** Why not, when it cannot. Null when it can. */
  gradingNote: string | null;
  crossCheck: YesNoCrossCheck | null;
}

export interface YesNoResolvers {
  playerName: (playerID: string) => string;
  team: (playerID: string) => string;
  marketLabel: (statID: string) => string | undefined;
  grading: (statID: string) => { gradeable: boolean; reason?: string };
  /** Books quoting this player/market's over/under at the 0.5 line, best first. */
  overAtHalf: (playerID: string, statID: string) => BookPrice[];
}

/**
 * THE CONSISTENCY CHECK, and the mistake it exists to prevent.
 *
 * "Anytime Goalscorer" and "Goals over 0.5" are the same bet, so one book must price
 * them the same. Comparing them is therefore a real correctness check on the whole
 * yes/no mapping, and it is the check that settled whether the NHL hockey label
 * crossover (`points` is goals, `goals+assists` is points) was wired correctly.
 *
 * IT MUST BE BOOK-PINNED ON BOTH SIDES. Run unpinned it produced a false alarm that
 * I repeated for several turns as fact: Carrier anytime goalscorer read +1800 against
 * a board showing +750, which looks exactly like a broken mapping. It was FanDuel
 * against ESPN Bet. FanDuel posts no 0.5 goals line for him, so the board never showed
 * its number. Pinned to one book the two agree to the cent. This function compares
 * only prices from the same bookmaker, and reports `no_comparable_line` rather than
 * reaching across venues for something to compare.
 */
export function crossCheckYesNo(
  yes: YesNoSidePrice | null,
  overBooks: BookPrice[]
): YesNoCrossCheck {
  if (!yes) {
    return {
      status: "no_comparable_line",
      book: null,
      yesPrice: null,
      overPrice: null,
      detail: "No yes price on this market, so there is nothing to cross-check.",
    };
  }

  const candidates = [yes.bookmaker, ...(yes.allBooks ?? []).map((b) => b.bookmaker)];
  for (const book of candidates) {
    const over = overBooks.find((b) => b.bookmaker === book);
    if (!over) continue;
    const yesAtBook =
      book === yes.bookmaker
        ? yes.americanOdds
        : (yes.allBooks ?? []).find((b) => b.bookmaker === book)!.americanOdds;
    const agrees = yesAtBook === over.americanOdds;
    return {
      status: agrees ? "agrees" : "mismatch",
      book,
      yesPrice: yesAtBook,
      overPrice: over.americanOdds,
      detail: agrees
        ? `${book} prices the yes side and its own over 0.5 identically at ${yesAtBook}, ` +
          `which is what the same bet must do. Mapping confirmed on this market.`
        : `MISMATCH at ${book}: yes is ${yesAtBook} but the same book's over 0.5 is ` +
          `${over.americanOdds}. These are the same bet and must agree. Treat the ` +
          `statID mapping for this market as unverified and do not post off it.`,
    };
  }

  return {
    status: "no_comparable_line",
    book: null,
    yesPrice: yes.americanOdds,
    overPrice: null,
    detail:
      `No book quotes BOTH this yes/no market and an over/under at 0.5 for this ` +
      `player, so there is nothing to compare within a single venue. Comparing across ` +
      `books is what produced a false mapping alarm on 2026-09-29 and is not done ` +
      `here. Pass includeAltLines to pull the 0.5 rung when it is an alternate line.`,
  };
}

/** Collapse yes/no sides into one row per player/market. Same shape of job as
 * buildBoardRows, kept separate because the row shape is genuinely different. */
export function buildYesNoRows(
  sides: YesNoPricedSide[],
  resolve: YesNoResolvers
): YesNoBoardRow[] {
  const byKey = new Map<string, { yes?: YesNoPricedSide; no?: YesNoPricedSide }>();
  for (const s of sides) {
    const key = `${s.playerID}|${s.statID}`;
    const entry = byKey.get(key) ?? {};
    if (s.side === "yes" && !entry.yes) entry.yes = s;
    if (s.side === "no" && !entry.no) entry.no = s;
    byKey.set(key, entry);
  }

  const toSide = (s: YesNoPricedSide | undefined): YesNoSidePrice | null => {
    if (!s) return null;
    const books = s.allBooks ?? [];
    const best = books[0];
    return {
      americanOdds: s.americanOdds,
      roundedOdds: roundToNearestTen(s.americanOdds),
      bookmaker: s.bookmaker,
      bestPrice: best
        ? { bookmaker: best.bookmaker, americanOdds: best.americanOdds }
        : null,
      betterPriceAvailable: Boolean(best && best.bookmaker !== s.bookmaker),
      bookCount: books.length,
      allBooks: books,
    };
  };

  const rows: YesNoBoardRow[] = [];
  for (const [key, entry] of byKey) {
    const playerID = key.slice(0, key.lastIndexOf("|"));
    const statID = key.slice(key.lastIndexOf("|") + 1);
    if (!entry.yes && !entry.no) continue;
    const grading = resolve.grading(statID);
    const yes = toSide(entry.yes);
    rows.push({
      playerID,
      playerName: resolve.playerName(playerID),
      team: resolve.team(playerID),
      market: resolve.marketLabel(statID) ?? statID,
      statID,
      yes,
      no: toSide(entry.no),
      sidesPriced: (entry.yes ? 1 : 0) + (entry.no ? 1 : 0),
      gradeable: grading.gradeable,
      gradingNote: grading.gradeable ? null : (grading.reason ?? "Not gradeable."),
      crossCheck: crossCheckYesNo(yes, resolve.overAtHalf(playerID, statID)),
    });
  }

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
        "Comma-separated bookmaker IDs to price against. DEFAULTS to the shared DEFAULT_BOOKMAKERS list in src/constants.ts (draftkings, fanduel, betmgm, caesars, hardrockbet). Pass 'all' to disable the filter for diagnosis only - never publish a price from an unfiltered board."
      ),
    maxPlayers: flexIntOptional(1, 60)
      .describe(
        "Optional cap on players included. NO DEFAULT CAP, unlike tkb_screen_props - this tool makes no per-player requests so there is no latency cost to justify one. If passed, the cut follows SGO's response order rather than player quality, and the board says so."
      ),
    maxRows: flexIntOptional(5, 600)
      .describe(
        "Backstop on rows returned. OMIT IT and the cap comes from the sport (v2.10.7): NFL and MLB 400, CFB and NHL 300, everything else 150. The old flat default of 80 was measured returning 70 of 142 rows on one NFL game, and because the cut follows SGO's response order that was ONE TEAM's board presented as the game's. Ceiling raised from 250 to 600. Truncation is always reported, never silent."
      ),
    period: z
      .string()
      .default("full_game")
      .describe(
        "ADDED v2.10.8. Which period's props to return. Defaults to `full_game`, which is what this board has always returned and the only thing it could return before now. Pass a PERIOD_CODES key from src/services/oddIdBuilder.ts to reach period props instead: football and basketball use 1st_half, 2nd_half, 1st_quarter through 4th_quarter; hockey uses 1st_period, 2nd_period, 3rd_period and regulation; baseball uses 1st_inning through 9th_inning plus 1st_3_innings, 1st_5_innings and 1st_7_innings; soccer uses 1st_half, 2nd_half and regulation. MEASURED which codes actually carry odds, 2026-09-28: NFL 1h/2h/1q/2q/3q/4q, CFB and WNBA 1h/1q/2q/3q/4q, MLB 1i to 9i plus 1h plus 1ix3/1ix5/1ix7, NHL 1p/2p/3p/reg, EPL 1h/2h/reg. A period with no posted markets returns an empty board and says so, which is the correct outcome."
      ),
    includeAltLines: flexBoolean(false)
      .describe(
        "ADDED v2.10.7. Ask SGO for ALTERNATE lines as well as the main one. A book posts a main receiving-yards number plus a ladder of alts, and with this OFF, which it has always been, the board shows only the main line and every alt is invisible. Turn it on when the question is 'what is available on this player', because the main line alone is not the whole market. It materially increases response size, which is the OOM risk this connector has been bitten by once, so it stays off by default and the row cap still applies."
      ),
    includeYesNo: flexBoolean(false)
      .describe(
        "ADDED v2.11.0. Also return the YES/NO milestone markets on this event - anytime goalscorer, any home run, any touchdown, double-double, first basket - as a separate `yesNoRows` array. These have always been in the payload this board fetches and were silently discarded: measured 686 of 1104 odds on an NHL board, 757 of 1814 on NFL, about 100 per WNBA game. They cost no extra request. OFF BY DEFAULT ONLY FOR SIZE: an NHL board carries roughly 340 of these on top of its over/under rows and returning both by default pushes the response past the tool-result ceiling. The coverage block always reports how many are waiting, so turning this on is never a guess. Each row carries `gradeable` plus a `crossCheck` that verifies the yes price against the SAME book's over/under at 0.5."
      ),
    maxYesNoRows: flexIntOptional(5, 600)
      .describe(
        "Backstop on yes/no rows returned, independent of maxRows so one section cannot starve the other. Omit and it follows the same sport-aware default as maxRows. Truncation is always reported."
      ),
    includeUnpriced: flexBoolean(false)
      .describe(
        "Also list markets that exist in SGO's catalog for this event but that NO sportsbook has priced. Useful for telling 'not offered' apart from 'not posted yet'. Their prices are model estimates and are never returned, only the market names."
      ),
    includeAllBooks: flexBoolean(false)
      .describe(
        "ADDED v2.10.5. Include EVERY real book's price on each side, best first, as `allBooks`. Off by default because it multiplies payload size. The board always reports `bestPrice`, `betterPriceAvailable` and `bookCount` per side regardless, so you can see when the displayed book is not the best one without asking for the full set. Use this when line shopping, or when a book you can see in its own app appears to be missing: it is usually present in the data and simply lost the display slot, because the shown price comes from whichever book SGO returned first rather than from the best one."
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
  - preferredBookmakers (defaults to the 8-book house list in constants.ts, 'all' to disable)
  - maxPlayers (optional): no default cap
  - includeAltLines (default false): also fetch each market's ALTERNATE lines
  - maxRows (omit for the sport default: NFL and MLB 400, CFB and NHL 300, else 150)
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

        /* NORMALISED IN CODE, NOT ONLY IN THE SCHEMA, v2.11.1. See flexibleInput.ts:
         * a direct handler call skips zod, and `includeYesNo: "false"` arriving as a
         * string is truthy, which would turn the section ON for a caller asking to
         * turn it off. Same reasoning as the v2.10.8 fix for `period`. */
        const wantYesNo = asBoolean(input.includeYesNo, false);
        const wantAltLines = asBoolean(input.includeAltLines, false);
        const wantUnpriced = asBoolean(input.includeUnpriced, false);
        const wantAllBooks = asBoolean(input.includeAllBooks, false);
        const askedMaxRows = asNumber(input.maxRows);
        const askedMaxYesNoRows = asNumber(input.maxYesNoRows);
        const askedMaxPlayers = asNumber(input.maxPlayers);

        const sport = input.sport as SportKey;
        const leagueID = sgo.leagueIDFor(sport);
        const catalog = OU_PROP_MARKETS[sport] ?? [];

        // THE FULL CATALOG, deliberately. See the header note: screenProps filters
        // to markets it can compute a rate for, and that exclusion has no meaning
        // on a board.
        const wanted = input.markets
          ? catalog.filter((m) => input.markets!.includes(m.label))
          : catalog;

        /* The `markets` filter names LABELS, and as of v2.11.0 a label can belong to
         * either catalog. Filtering both means `markets: ["Anytime Goalscorer"]` works
         * the way a caller would expect instead of matching nothing. */
        const ynCatalog = YES_NO_MARKETS[sport] ?? [];
        const ynWanted = input.markets
          ? ynCatalog.filter((m) => input.markets!.includes(m.label))
          : ynCatalog;

        if (wanted.length === 0 && ynWanted.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No markets matched${input.markets ? ` ${input.markets.join(", ")}` : ""} for ` +
                  `${sport.toUpperCase()}.\n\nValid over/under labels: ${catalog.map((m) => m.label).join(", ")}` +
                  (ynCatalog.length
                    ? `\n\nValid yes/no labels (pass includeYesNo to see them on the board): ` +
                      `${ynCatalog.map((m) => m.label).join(", ")}`
                    : ""),
              },
            ],
          };
        }

        const statIDToLabel = new Map(wanted.map((m) => [m.statID, m.label]));
        const ynStatIDToLabel = new Map(ynWanted.map((m) => [m.statID, m.label]));

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
          // v2.10.7: opt-in. Off by default for payload size, but reachable now
          // instead of being a permanently invisible slice of the market.
          includeAltLines: wantAltLines,
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

        /* v2.10.8: the board is no longer hardwired to the full game. `period` maps
         * through the same PERIOD_CODES table every oddID builder uses, so there is one
         * period vocabulary in the connector rather than two that can drift. An unknown
         * key is refused by name rather than silently returning an empty board, which
         * would be indistinguishable from "this period has no markets". */
        // Defaulted IN CODE, not only in the schema. A direct handler call bypasses
        // zod's default, which is the same fragility toolWiring.test.ts records for
        // preferredBookmakers and .trim().
        const requestedPeriod = input.period ?? "full_game";
        const periodCode = PERIOD_CODES[requestedPeriod];
        if (!periodCode) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `"${requestedPeriod}" is not a recognized period. Valid keys: ` +
                  `${Object.keys(PERIOD_CODES).join(", ")}.`,
              },
            ],
            isError: true,
          };
        }

        // v2.10.7: an omitted maxRows resolves per sport rather than to a flat 80.
        const effectiveMaxRows =
          askedMaxRows ?? defaultMaxRowsFor(input.sport as SportKey);
        // Its own cap, so a wide yes/no set cannot crowd out over/under rows or the
        // reverse. Same sport-aware default.
        const effectiveMaxYesNoRows =
          askedMaxYesNoRows ?? defaultMaxRowsFor(input.sport as SportKey);
        // Refuse a non-match event readably rather than throwing a bare TypeError.
        // See services/eventShape.ts.
        const shape = readMatchTeams(event);
        if (!shape.ok) {
          return { content: [{ type: "text" as const, text: shape.reason }] };
        }
        const homeID = shape.teams.homeID;
        const awayID = shape.teams.awayID;
        const teamNames: Record<string, string> = {
          [homeID]: event.teams.home.names?.long ?? homeID,
          [awayID]: event.teams.away.names?.long ?? awayID,
        };
        const matchup = `${teamNames[awayID]} @ ${teamNames[homeID]}`;

        const roster = Object.values(event.players ?? {});
        if (roster.length === 0) {
          // UFC GETS A DIFFERENT ANSWER, AND THIS IS THE THIRD TIME THIS RELEASE
          // CYCLE THAT AN AUDIT WAS SCOPED TOO NARROWLY.
          //
          // v2.9.0 wrote the fighter-aware empty message into tools/players.ts and
          // stopped there. Measured 2026-09-15 on UFC 331 Pantoja vs Van, the two
          // tools disagreed in the same minute: tkb_get_players gave the correct
          // fighter explanation, and this tool told the reader that props "typically
          // post within a few days of kickoff, and for MLB often only on the morning
          // of" - advice about baseball, on a fight card, that may be permanently
          // wrong rather than early.
          //
          // The generic text is not merely unhelpful here. It invites a retry that
          // can never succeed, which is the exact failure class this connector
          // exists to refuse.
          if (participantModel(input.sport as SportKey) === "fighters") {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `No FIGHTER props are attached to ${matchup}.\n\n` +
                    `This may be permanent rather than early. SGO documents UFC as a ` +
                    `single-participant league where the two fighters occupy the home and ` +
                    `away slots, and this connector has NOT verified that fighter ids are ` +
                    `ever surfaced in the players object on this account. Do not read this ` +
                    `as "check back closer to the fight".\n\n` +
                    `WHAT IS AVAILABLE RIGHT NOW, and needs no fighter id: the fight ` +
                    `moneyline via tkb_get_odds marketType="moneyline" (measured working on ` +
                    `this card), and the rounds total via marketType="total", which settles ` +
                    `on roundsCompleted rather than points. Method-of-victory markets can be ` +
                    `pulled but cannot be graded automatically - a UFC event carries a ` +
                    `winner, not a method.`,
                },
              ],
            };
          }

          /* ---- THE EMPTY PATH USED TO REPORT NOTHING, FIXED v2.10.8 ----
           *
           * This early return fired before any coverage was computed, so a board with
           * no attached players produced a response with no diagnostics at all.
           *
           * MEASURED 2026-09-28 on two UCL fixtures including Paris Saint-Germain at
           * Manchester City: `pricedRowCount: 0, unpricedMarketCount: 0` and NO coverage
           * block, while EPL fixtures the same week returned `seenOdds` in the 600s. So a
           * UCL league-mapping gap was INDISTINGUISHABLE from "books have not posted
           * yet", which are opposite problems needing opposite responses.
           *
           * The two numbers below separate them. `oddsOnEvent` is how many odds SGO
           * returned at all: zero means the event carries no markets, which is a mapping
           * or coverage question. Non-zero with no attached players means markets exist
           * but none are addressable by playerID, which is the tennis and UFC shape.
           */
          const oddsOnEvent = Object.keys(event.odds ?? {}).length;
          const playerKeyedOdds = Object.keys(event.odds ?? {}).filter((k) => {
            const pp = parseOddID(k);
            return pp ? pp.entity !== "home" && pp.entity !== "away" && pp.entity !== "all" : false;
          }).length;

          return {
            structuredContent: {
              eventID: event.eventID,
              matchup,
              pricedRowCount: 0,
              playersAttached: 0,
              coverage: {
                oddsOnEvent,
                playerKeyedOdds,
                diagnosis:
                  oddsOnEvent === 0
                    ? `SGO returned NO odds of any kind for this event. That is not "props ` +
                      `have not posted": a priced event carries team markets long before ` +
                      `player props. Treat this as a league coverage or mapping question ` +
                      `and check a second fixture in the same league before planning content.`
                    : playerKeyedOdds === 0
                      ? `This event carries ${oddsOnEvent} odds but NONE are keyed to a ` +
                        `playerID, so there is no player board to build and there may never ` +
                        `be. That is the documented shape for tennis and UFC, where ` +
                        `competitors occupy the home and away participant slots.`
                      : `This event carries ${oddsOnEvent} odds, ${playerKeyedOdds} of them ` +
                        `player-keyed, but SGO's players object is empty so they cannot be ` +
                        `resolved to names. Retry closer to game time.`,
              },
            },
            content: [
              {
                type: "text" as const,
                text:
                  `No players attached to ${matchup} yet.\n\n` +
                  `DIAGNOSTIC (v2.10.8): SGO returned ${oddsOnEvent} odds for this event, ` +
                  `${playerKeyedOdds} of them player-keyed. ` +
                  (oddsOnEvent === 0
                    ? `ZERO odds means this is a league coverage or mapping question, NOT a ` +
                      `timing one, because team markets post long before player props.\n\n`
                    : `\n\n`) +
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
          askedMaxPlayers !== undefined && roster.length > askedMaxPlayers;
        const included =
          askedMaxPlayers !== undefined ? roster.slice(0, askedMaxPlayers) : roster;
        const allowedPlayerIDs = new Set(included.map((p) => p.playerID));
        const playerByID = new Map(roster.map((p) => [p.playerID, p]));

        const sides: PricedSide[] = [];
        const unpriced = new Map<string, string>(); // "player | market" -> reason bucket
        let cancelledCount = 0;

        // ---- v2.11.0 yes/no collectors ----
        const ynSides: YesNoPricedSide[] = [];
        const unpricedYesNo = new Map<string, string>();
        /* Books quoting an over/under at EXACTLY 0.5, keyed player|statID, for the
         * cross-check. Filtered per book rather than per oddID on purpose: one odd
         * object can carry different numbers at different books, which is how a 0.5
         * rung shows up on a market whose displayed line is 1.5. Recorded before the
         * catalog and entity filters so the check survives a `markets` narrowing. */
        const ouHalfBooks = new Map<string, BookPrice[]>();
        let ynSeen = 0;
        let ynDroppedNonGamePeriod = 0;
        const ynDroppedPeriods = new Map<string, number>();
        let ynDroppedNotYesNoSide = 0;
        const ynDroppedSides = new Map<string, number>();
        let ynDroppedNotInCatalog = 0;
        const ynDroppedStatIDs = new Map<string, number>();
        let ynDroppedTeamOrUnknownEntity = 0;
        let ynDroppedNoBookPrice = 0;
        let ynCancelled = 0;
        let droppedOtherBetType = 0;
        const otherBetTypesSeen = new Map<string, number>();

        /* ---- COMPLETENESS ACCOUNTING, ADDED v2.10.7 ----
         *
         * This loop DISCARDS most of what SGO sends and, until now, said nothing about
         * it. A board that silently drops four fifths of an event reads as "this is
         * every prop" to whoever is building a thread from it. These counters are the
         * denominator: every odd is either turned into a row or counted here under the
         * reason it was dropped.
         *
         * They are diagnostics, not gates. Nothing about which props are eligible
         * changed in this release; only whether the caller can see what was removed.
         */
        let seenOdds = 0;
        let droppedUnparsable = 0;
        /* NAMED, NOT JUST COUNTED, v2.11.2. Every other drop bucket names what it
         * dropped; this one has reported a bare number since v2.10.7. It sits at 28 on
         * every WNBA board and 14 on NHL, unexplained, and SGO's docs do not say how an
         * alternate line is represented given the line is NOT part of the oddID - which
         * makes these the most likely place to find out. Capped, verbatim, no parsing. */
        const unparsableSamples: string[] = [];
        let droppedNonOverUnderSide = 0;
        let droppedNonGamePeriod = 0;
        const droppedPeriods = new Map<string, number>();
        const droppedSides = new Map<string, number>();
        let droppedNotInCatalog = 0;
        const droppedStatIDs = new Map<string, number>();
        let droppedTeamOrUnknownEntity = 0;
        let droppedNoBookPrice = 0;
        let droppedUnparsableLine = 0;

        for (const [oddID, odd] of Object.entries(event.odds ?? {})) {
          seenOdds++;
          const parsed = parseOddID(oddID);
          if (!parsed) {
            droppedUnparsable++;
            if (unparsableSamples.length < 10) unparsableSamples.push(oddID);
            continue;
          }

          /* ---- YES/NO MARKETS, ON THE BOARD AS OF v2.11.0 ----
           *
           * Anytime scorer, first scorer, double-double and every other milestone
           * market lives on betType `yn`. Until this release all of them were counted
           * under one `notOverUnder` bucket and thrown away, and that bucket was the
           * biggest hole in the connector. They are collected here now, through the
           * same filter discipline the over/under branch uses, with their own counters
           * so neither section's denominator borrows from the other. */
          if (parsed.betType === "yn") {
            ynSeen++;
            if (parsed.period !== periodCode) {
              ynDroppedNonGamePeriod++;
              ynDroppedPeriods.set(
                parsed.period,
                (ynDroppedPeriods.get(parsed.period) ?? 0) + 1
              );
              continue;
            }
            if (parsed.side !== "yes" && parsed.side !== "no") {
              ynDroppedNotYesNoSide++;
              ynDroppedSides.set(parsed.side, (ynDroppedSides.get(parsed.side) ?? 0) + 1);
              continue;
            }
            if (!ynStatIDToLabel.has(parsed.statID)) {
              ynDroppedNotInCatalog++;
              ynDroppedStatIDs.set(
                parsed.statID,
                (ynDroppedStatIDs.get(parsed.statID) ?? 0) + 1
              );
              continue;
            }
            if (!allowedPlayerIDs.has(parsed.entity)) {
              ynDroppedTeamOrUnknownEntity++;
              continue;
            }
            const ynLabel = ynStatIDToLabel.get(parsed.statID)!;
            const ynPlayerName = playerByID.get(parsed.entity)?.name ?? parsed.entity;
            /* requireLine FALSE, and that is the whole difference from the branch
             * below. A yes/no market has no line by nature, so demanding one would
             * reject every market in this section. It still needs a real book price;
             * a fair-odds model number is as unpublishable here as anywhere. */
            const ynPriced = extractPricedLine(odd, {
              requireLine: false,
              marketDescription: `${ynLabel} for ${ynPlayerName}`,
            });
            if (!ynPriced.priced || !ynPriced.value) {
              if (odd.cancelled) {
                ynCancelled++;
              } else {
                ynDroppedNoBookPrice++;
                const key = `${ynPlayerName} | ${ynLabel}`;
                if (!unpricedYesNo.has(key)) {
                  unpricedYesNo.set(
                    key,
                    odd.fairOdds ? "catalog only, no book has posted" : "no book price"
                  );
                }
              }
              continue;
            }
            ynSides.push({
              playerID: parsed.entity,
              statID: parsed.statID,
              side: parsed.side,
              americanOdds: ynPriced.value.americanOdds,
              bookmaker: ynPriced.value.bookmaker ?? "unknown",
              allBooks: allBookPrices(odd),
            });
            continue;
          }

          /* Everything that is neither an over/under nor a yes/no: moneylines,
           * spreads, three-way prices. Named rather than lumped, because "757 odds
           * were not over/under" told the caller nothing about what they were. */
          if (parsed.betType !== "ou") {
            droppedOtherBetType++;
            otherBetTypesSeen.set(
              parsed.betType,
              (otherBetTypesSeen.get(parsed.betType) ?? 0) + 1
            );
            continue;
          }

          /* THE 0.5 INDEX FOR THE CROSS-CHECK. Recorded before the CATALOG and ENTITY
           * filters, so narrowing `markets` cannot quietly disable the verification,
           * but AFTER the period check below in spirit - which is why the period is
           * tested right here rather than relying on position.
           *
           * ---- THE PERIOD BUG, FIXED v2.11.2 ----
           *
           * The first cut of this index tested only `side === "over"`, which put it
           * ahead of the period filter and therefore indexed PERIOD markets. A hockey
           * first-period "points over 0.5" then overwrote the full-game one, and the
           * cross-check compared a full-game yes/no price against a one-period line.
           *
           * It produced 25 mismatches on Montreal at Toronto, 2026-09-29, every one of
           * them false, and every one of them phrased as "do not post off it". Kreider
           * any point read as +125 against an "over 0.5" of +500; DraftKings' real
           * full-game over 0.5 on that market is +125, an exact match, and the +500 was
           * his FIRST-PERIOD line. A verification tool that cries wolf is worse than no
           * verification tool, because the next real mismatch gets ignored with the rest.
           *
           * Caught by pulling the over/under board for the same event and the same book
           * and reading what DraftKings actually posts, rather than by believing my own
           * instrument. That check is the only reason this is a bug report and not
           * another retraction.
           *
           * A PLAIN `set` IS CORRECT, and I first shipped a merge branch here on the
           * assumption that an alt-line ladder could produce several odds for one
           * market. It cannot reach this key. `odds` is keyed BY oddID and an oddID is
           * exactly {statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}, so there is
           * at most ONE odd per key this index builds. A mutation run proved the merge
           * branch unreachable: removing it broke no test, because no fixture could
           * legally exercise it. Untestable code that looks defensive is worse than no
           * code, so it is gone.
           *
           * WHAT THAT LEAVES OPEN. Alt lines therefore are NOT extra copies of the same
           * oddID, and SGO's docs state the line is a separate field without saying how
           * a ladder is represented. `unparsableOddIDsSeen` below is the instrument for
           * finding out, rather than another assumption. */
          if (parsed.side === "over" && parsed.period === periodCode) {
            const half = allBookPrices(odd).filter((b) => lineMatches(b.line, 0.5));
            if (half.length) {
              ouHalfBooks.set(`${parsed.entity}|${parsed.statID}`, half);
            }
          }

          // PERIOD PROPS. Halves, quarters, hockey periods and first-N-innings props
          // are real markets and are all discarded here, because the board is
          // full-game only.
          if (parsed.period !== periodCode) {
            droppedNonGamePeriod++;
            droppedPeriods.set(parsed.period, (droppedPeriods.get(parsed.period) ?? 0) + 1);
            continue;
          }

          /* SIDE VOCABULARY. betType `ou` is an over/under market, but SGO still emits
           * sides this board cannot use on it: `yes`, `no`, and the `home`/`away`
           * team-sided spellings. This filter has always been here and until v2.10.9
           * it was the ONE drop path with no counter, which meant `seenOdds` did not
           * reconcile: on a 422-odd WNBA board roughly 32 odds vanished into a bucket
           * that was not reported. A denominator that does not add up is worse than
           * no denominator, because it reads as complete. */
          if (parsed.side !== "over" && parsed.side !== "under") {
            droppedNonOverUnderSide++;
            droppedSides.set(parsed.side, (droppedSides.get(parsed.side) ?? 0) + 1);
            continue;
          }

          // NOT IN THE HARDCODED CATALOG. This is the one that can hide a market the
          // books do offer, because OU_PROP_MARKETS is maintained by hand. Recording
          // the statIDs makes catalog drift visible without a /markets call.
          if (!statIDToLabel.has(parsed.statID)) {
            droppedNotInCatalog++;
            droppedStatIDs.set(parsed.statID, (droppedStatIDs.get(parsed.statID) ?? 0) + 1);
            continue;
          }

          if (!allowedPlayerIDs.has(parsed.entity)) {
            droppedTeamOrUnknownEntity++;
            continue;
          }

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
              droppedNoBookPrice++;
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
          if (Number.isNaN(line)) {
            // A priced side whose line is missing or non-numeric. Rare, and previously
            // silent, which is the same reconciliation defect as the side filter above.
            droppedUnparsableLine++;
            continue;
          }

          sides.push({
            playerID: parsed.entity,
            statID: parsed.statID,
            side: parsed.side,
            line,
            americanOdds: priced.value.americanOdds,
            bookmaker: priced.value.bookmaker ?? "unknown",
            allBooks: allBookPrices(odd),
          });
        }

        const allRows = buildBoardRows(sides, {
          playerName: (id) => playerByID.get(id)?.name ?? id,
          team: (id) => {
            const t = playerByID.get(id)?.teamID;
            return t ? (teamNames[t] ?? t) : "unknown";
          },
          marketLabel: (statID) => statIDToLabel.get(statID) ?? statID,
        }, { includeAllBooks: wantAllBooks });

        const truncated = allRows.length > effectiveMaxRows;
        const rows = allRows.slice(0, effectiveMaxRows);

        /* BUILT WHETHER OR NOT THEY ARE RETURNED. Building is cheap; serialising is
         * what costs payload. Always building means the coverage block can state
         * exactly how many yes/no markets are sitting there, so `includeYesNo` is an
         * informed choice rather than a shot in the dark. */
        const allYesNoRows = buildYesNoRows(ynSides, {
          playerName: (id) => playerByID.get(id)?.name ?? id,
          team: (id) => {
            const t = playerByID.get(id)?.teamID;
            return t ? (teamNames[t] ?? t) : "unknown";
          },
          marketLabel: (statID) => ynStatIDToLabel.get(statID),
          grading: (statID) => yesNoGradingFor(sport, statID),
          overAtHalf: (playerID, statID) => ouHalfBooks.get(`${playerID}|${statID}`) ?? [],
        });
        const yesNoTruncated = allYesNoRows.length > effectiveMaxYesNoRows;
        const yesNoRows = wantYesNo
          ? allYesNoRows.slice(0, effectiveMaxYesNoRows)
          : [];
        const yesNoMismatches = allYesNoRows.filter(
          (r) => r.crossCheck?.status === "mismatch"
        );
        const yesNoUngradeable = allYesNoRows.filter((r) => !r.gradeable).length;

        const bookLine = bookFilter
          ? `Priced against: ${bookFilter}.`
          : `Priced against ALL venues - book filter disabled. Diagnostic only; do NOT ` +
            `publish a price from this board without re-pulling at your books.`;

        if (allRows.length === 0 && allYesNoRows.length === 0) {
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
          ? ` ROSTER CLIPPED: ${roster.length} players attached, ${askedMaxPlayers} ` +
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
            (wantUnpriced ? `, listed below` : `; pass includeUnpriced to name them`) +
            `.`
          : "";

        const cancelledNote = cancelledCount
          ? ` ${cancelledCount} cancelled market(s) skipped.`
          : "";

        /* v2.11.0. Said in the prose, not only in the coverage object, because the
         * thing this release fixes is a caller believing the board was complete. */
        const yesNoNote = !allYesNoRows.length
          ? ` No yes/no milestone markets are priced on this event.`
          : wantYesNo
            ? ` ${yesNoRows.length} YES/NO milestone market(s) included below as ` +
              `yesNoRows` +
              (yesNoTruncated
                ? ` (${allYesNoRows.length} built, raise maxYesNoRows)`
                : "") +
              `.` +
              (yesNoUngradeable
                ? ` ${yesNoUngradeable} of them CANNOT be graded by tkb_grade_pick ` +
                  `(ordering and composite markets); each row says so and why.`
                : "") +
              (yesNoMismatches.length
                ? ` WARNING: ${yesNoMismatches.length} failed the cross-check against ` +
                  `their own book's over 0.5. Do not post those.`
                : "")
            : ` ${allYesNoRows.length} YES/NO milestone market(s) are priced on this ` +
              `event and NOT shown. Pass includeYesNo for anytime scorer, any home run, ` +
              `any touchdown, double-double and the rest.`;

        const summary =
          `${rows.length} priced market(s) across ${distinctPlayers} player(s) in ${matchup}.` +
          `\n\n${bookLine}${rosterLine}${truncationLine}${splitLineNote}${oneSidedNote}` +
          `${unpricedNote}${cancelledNote}${yesNoNote}` +
          `\n\nNO HIT RATES ON THIS BOARD BY DESIGN. This tool reports what is priced, ` +
          `not what is likely to win. Use tkb_screen_props for ranking where a rate ` +
          `source exists, and remember that early-season CFB and any WNBA market have ` +
          `no computable rate at all - preview language only.`;

        const unpricedList = wantUnpriced
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
              text:
                `${summary}\n\n${JSON.stringify(rows, null, 2)}` +
                (wantYesNo && yesNoRows.length
                  ? `\n\nYES/NO MARKETS:\n${JSON.stringify(yesNoRows, null, 2)}`
                  : "") +
                unpricedList,
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
            yesNoRowsBuilt: allYesNoRows.length,
            yesNoRowsReturned: yesNoRows.length,
            yesNoCrossCheckMismatches: yesNoMismatches.length,
            pricedAgainst: bookFilter ?? "all",
            maxRowsApplied: effectiveMaxRows,
            period: requestedPeriod,
            periodCode,
            altLinesIncluded: wantAltLines,
            /* WHAT THIS BOARD IS NOT SHOWING YOU, v2.10.7.
             *
             * `seenOdds` is the denominator: every odd SGO returned for this event.
             * Each dropped bucket names why those odds never became rows. This exists
             * because a board that discards four fifths of an event used to read as
             * "every prop in this game", and a thread built off that assumption is
             * building off a slice. */
            /* COVERAGE, RESTRUCTURED v2.11.0.
             *
             * It used to be one flat set of buckets, which worked while the board had
             * one section. Now that yes/no markets are collected too, a single
             * `notInCatalog` or `noBookPrice` figure would be two different facts added
             * together. Each section owns its own denominator and its own drop reasons,
             * and `unaccounted` spans both. A number that mixes two populations is the
             * kind of thing that reads as precise and is not. */
            coverage: {
              seenOdds,
              overUnder: {
                sidesAccepted: sides.length,
                rowsBuilt: allRows.length,
                rowsReturned: rows.length,
                dropped: {
                  nonOverUnderSide: droppedNonOverUnderSide,
                  nonGamePeriod: droppedNonGamePeriod,
                  notInCatalog: droppedNotInCatalog,
                  teamOrUnknownEntity: droppedTeamOrUnknownEntity,
                  noBookPrice: droppedNoBookPrice,
                  cancelled: cancelledCount,
                  unparsableLine: droppedUnparsableLine,
                },
                sidesNotOverUnder: Object.fromEntries(
                  [...droppedSides.entries()].sort((a, b) => b[1] - a[1])
                ),
                nonGamePeriodsSeen: Object.fromEntries(
                  [...droppedPeriods.entries()].sort((a, b) => b[1] - a[1])
                ),
                statIDsNotInCatalog: Object.fromEntries(
                  [...droppedStatIDs.entries()].sort((a, b) => b[1] - a[1])
                ),
              },
              yesNo: {
                included: wantYesNo,
                seenOdds: ynSeen,
                sidesAccepted: ynSides.length,
                rowsBuilt: allYesNoRows.length,
                rowsReturned: yesNoRows.length,
                truncated: yesNoTruncated,
                dropped: {
                  notYesNoSide: ynDroppedNotYesNoSide,
                  nonGamePeriod: ynDroppedNonGamePeriod,
                  notInCatalog: ynDroppedNotInCatalog,
                  teamOrUnknownEntity: ynDroppedTeamOrUnknownEntity,
                  noBookPrice: ynDroppedNoBookPrice,
                  cancelled: ynCancelled,
                },
                sidesNotYesNo: Object.fromEntries(
                  [...ynDroppedSides.entries()].sort((a, b) => b[1] - a[1])
                ),
                nonGamePeriodsSeen: Object.fromEntries(
                  [...ynDroppedPeriods.entries()].sort((a, b) => b[1] - a[1])
                ),
                statIDsNotInCatalog: Object.fromEntries(
                  [...ynDroppedStatIDs.entries()].sort((a, b) => b[1] - a[1])
                ),
                /* THE MAPPING CHECK, reported whether or not the rows are returned.
                 * A mismatch here means a yes/no market and its own book's over 0.5
                 * disagree, which is the same bet at two prices and therefore a
                 * mapping defect. Zero mismatches is the claim this release makes. */
                crossCheck: {
                  agrees: allYesNoRows.filter((r) => r.crossCheck?.status === "agrees")
                    .length,
                  mismatch: yesNoMismatches.length,
                  noComparableLine: allYesNoRows.filter(
                    (r) => r.crossCheck?.status === "no_comparable_line"
                  ).length,
                  mismatchDetail: yesNoMismatches
                    .slice(0, 10)
                    .map((r) => `${r.playerName} ${r.market}: ${r.crossCheck!.detail}`),
                },
                ungradeableRowCount: yesNoUngradeable,
              },
              /* Moneylines, spreads and three-way prices. Counted and NAMED, because
               * the old single `notOverUnder` figure of 757 told the caller nothing
               * about what those odds actually were. */
              otherBetTypes: {
                count: droppedOtherBetType,
                betTypesSeen: Object.fromEntries(
                  [...otherBetTypesSeen.entries()].sort((a, b) => b[1] - a[1])
                ),
              },
              unparsableOddID: droppedUnparsable,
              unparsableOddIDsSeen: unparsableSamples,
              /* RECONCILIATION, now spanning both sections. Every odd SGO returned is
               * either an accepted side in one of the two sections or counted under a
               * reason. If this is ever non-zero a drop path was added without a
               * counter and the board is hiding markets again. */
              unaccounted:
                seenOdds -
                sides.length -
                ynSides.length -
                droppedUnparsable -
                droppedOtherBetType -
                droppedNonOverUnderSide -
                droppedNonGamePeriod -
                droppedNotInCatalog -
                droppedTeamOrUnknownEntity -
                droppedNoBookPrice -
                cancelledCount -
                droppedUnparsableLine -
                ynDroppedNotYesNoSide -
                ynDroppedNonGamePeriod -
                ynDroppedNotInCatalog -
                ynDroppedTeamOrUnknownEntity -
                ynDroppedNoBookPrice -
                ynCancelled,
              note:
                `Period ${requestedPeriod} (${periodCode}). Two sections: over/under and ` +
                `yes/no. nonGamePeriod is halves, quarters, hockey periods and ` +
                `first-N-innings props, reachable by passing period. nonOverUnderSide is an ` +
                `ou market carrying a side this board cannot use (yes/no, home/away) and ` +
                `notYesNoSide is its mirror in the yes/no section; the sides are named in ` +
                `each section. notInCatalog means the ` +
                `books price a market the catalog does not list, which is drift, and the ` +
                `statIDs are named. noBookPrice is a market carrying only a fair-odds model ` +
                `number, which is never publishable. otherBetTypes is every betType this ` +
                `board does not build: ml, sp and ml3way belong to tkb_get_game_lines, but ` +
                `SGO also documents \`eo\` (even/odd) and \`prop\` (custom one-off), which are ` +
                `PLAYER markets this connector has never handled anywhere. Read betTypesSeen ` +
                `rather than assuming this bucket is only game lines. ` +
                (wantYesNo
                  ? `Yes/no rows ARE included.`
                  : `Yes/no rows were NOT requested: ${allYesNoRows.length} are built and ` +
                    `waiting, pass includeYesNo to see them.`) +
                ` ` +
                (wantAltLines
                  ? `Alt lines WERE requested.`
                  : `Alt lines were NOT requested, so only each market's main line is here; ` +
                    `pass includeAltLines to see the ladder.`),
            },
            rows,
            ...(wantYesNo ? { yesNoRows } : {}),
            ...(wantUnpriced
              ? {
                  unpricedMarkets: [...unpriced.keys()].sort(),
                  unpricedYesNoMarkets: [...unpricedYesNo.keys()].sort(),
                }
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
