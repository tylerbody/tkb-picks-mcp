import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allBookPrices, extractPricedLine } from "../src/services/oddsPricing.js";
import { buildBoardRows, type PricedSide } from "../src/tools/propBoard.js";
import { DEFAULT_BOOKMAKERS } from "../src/constants.js";

/**
 * v2.10.5: THE BOOKS WERE THERE THE WHOLE TIME.
 *
 * Two separate things made a fully priced book look absent, and the owner caught the
 * second one by comparing the board against the Hard Rock app:
 *
 *   1. THE DEFAULT LIST. BetRivers, ESPN Bet and Bally Bet are regulated books, were
 *      in no block list, and were simply missing from DEFAULT_BOOKMAKERS. 80 priced
 *      rows became 102 with the filter off, and `Goals` 0.5 went from one-sided to
 *      two-sided because ESPN Bet is what prices the under.
 *
 *   2. THE DISPLAY SLOT, which is the more misleading of the two. extractPricedLine
 *      reports ONE price per side via firstAvailableBook, whichever SGO returned
 *      first. Filtered to hardrockbet alone, the same NHL event produced 89 rows
 *      across 15 players and six markets. On the multi-book board Hard Rock appeared
 *      on almost nothing. Nothing was missing from the data; another book kept
 *      winning the slot.
 *
 * The fix makes the rest of the market visible WITHOUT changing which price is
 * selected, because flipping the default selection changes every tool's output at
 * once and that is the owner's call.
 */

describe("v2.10.5 the default book list", () => {
  /**
   * TOKENS, NOT SUBSTRINGS. The first version of this file used
   * DEFAULT_BOOKMAKERS.includes(...) and reported that the pick'em app `betr` was in
   * the default list, because "betr" is a substring of "betrivers". The list is a
   * comma-separated set of exact bookmakerIDs and has to be compared as such.
   *
   * The source is not affected: the block lists are Sets and use `.has()`, which is
   * exact. This was a test-only mistake, and it is the same substring-versus-exact
   * confusion behind the market-label failures documented in
   * claude/market-label-contract.md, so it is worth leaving the reason written down.
   */
  const BOOKS = new Set(DEFAULT_BOOKMAKERS.split(",").map((b) => b.trim()));

  test("carries the three regulated books that were missing", () => {
    for (const book of ["betrivers", "espnbet", "ballybet"]) {
      assert.ok(BOOKS.has(book), `${book} missing from the default list`);
    }
  });

  test("still carries the original five, including hardrockbet", () => {
    for (const book of ["draftkings", "fanduel", "betmgm", "caesars", "hardrockbet"]) {
      assert.ok(BOOKS.has(book), `${book} was dropped`);
    }
  });

  test("is exactly eight books, so nothing crept in unnoticed", () => {
    assert.equal(BOOKS.size, 8);
  });

  test("adds NO blocked venue", () => {
    // The four block lists exist for four different documented reasons and this
    // release must not have relaxed any of them.
    for (const blocked of [
      "underdog", "prizepicks", "sleeper", "betr", "dabble", "parlayplay",
      "fliff", "polymarket", "kalshi", "predictit", "manifold",
      "betonline", "bovada", "mybookie", "betus",
    ]) {
      assert.ok(!BOOKS.has(blocked), `${blocked} must not be in the default list`);
    }
  });
});

describe("v2.10.5 allBookPrices returns the whole market, best first", () => {
  const odd = {
    oddID: "shots_onGoal-X-game-ou-over",
    byBookmaker: {
      betmgm: { odds: "-140", overUnder: "1.5", available: true },
      hardrockbet: { odds: "-130", overUnder: "1.5", available: true },
      fanduel: { odds: "+105", overUnder: "1.5", available: true },
      // Must never appear: blocked for four different reasons.
      underdog: { odds: "+100", overUnder: "1.5", available: true },
      polymarket: { odds: "+150", overUnder: "1.5", available: true },
      bovada: { odds: "+200", overUnder: "1.5", available: true },
      fliff: { odds: "+300", overUnder: "1.5", available: true },
      // Must never appear: flagged unavailable, and carries no price.
      caesars: { odds: "-110", overUnder: "1.5", available: false },
      espnbet: { overUnder: "1.5", available: true },
    },
  } as never;

  test("orders by value to the bettor, not by book name", () => {
    const books = allBookPrices(odd);
    assert.deepEqual(
      books.map((b) => b.bookmaker),
      ["fanduel", "hardrockbet", "betmgm"]
    );
    assert.equal(books[0]!.americanOdds, "+105");
  });

  test("THE HARD ROCK CASE: a book behind another in the slot is still returned", () => {
    const books = allBookPrices(odd);
    assert.ok(books.some((b) => b.bookmaker === "hardrockbet"));
    assert.equal(books.find((b) => b.bookmaker === "hardrockbet")!.americanOdds, "-130");
  });

  test("every blocked venue is excluded even when it has the best number", () => {
    const keys = allBookPrices(odd).map((b) => b.bookmaker);
    for (const blocked of ["underdog", "polymarket", "bovada", "fliff"]) {
      assert.ok(!keys.includes(blocked), `${blocked} leaked into allBookPrices`);
    }
  });

  test("an unavailable book and a book with no price are both skipped", () => {
    const keys = allBookPrices(odd).map((b) => b.bookmaker);
    assert.ok(!keys.includes("caesars"), "available:false must be skipped");
    assert.ok(!keys.includes("espnbet"), "a book with no odds must be skipped");
  });

  test("the line comes from the same book as the price", () => {
    assert.equal(allBookPrices(odd)[0]!.line, "1.5");
  });

  test("an odd with no byBookmaker yields an empty array rather than throwing", () => {
    assert.deepEqual(allBookPrices(undefined), []);
    assert.deepEqual(allBookPrices({ oddID: "x" } as never), []);
  });
});

describe("v2.10.5a a settled event, where every book is flagged unavailable", () => {
  /**
   * THE BUG THIS PINS. The first cut skipped `available === false` unconditionally, so
   * on any finished market it returned an EMPTY array. Measured live on NHL Boston at
   * Florida: every side came back `bookCount: 0, bestPrice: null` while the selected
   * price was intact and Hard Rock demonstrably priced the same markets.
   *
   * `firstAvailableBook` prefers an available book and falls back to any book with
   * odds. `allBookPrices` has to use the SAME two tiers, or bestPrice is drawn from a
   * smaller pool than the price it is compared against.
   */
  const settled = {
    oddID: "goalie_saves-X-game-ou-over",
    byBookmaker: {
      betmgm: { odds: "-125", overUnder: "24.5", available: false },
      hardrockbet: { odds: "-115", overUnder: "24.5", available: false },
      fanduel: { odds: "-130", overUnder: "24.5", available: false },
      bovada: { odds: "+200", overUnder: "24.5", available: false },
    },
  } as never;

  test("THE BUG: a fully unavailable market still returns its books", () => {
    const books = allBookPrices(settled);
    assert.equal(books.length, 3, "all three real books should come back");
    assert.equal(books[0]!.bookmaker, "hardrockbet");
    assert.equal(books[0]!.americanOdds, "-115");
  });

  test("the block list still applies on the fallback tier", () => {
    assert.ok(!allBookPrices(settled).some((b) => b.bookmaker === "bovada"));
  });

  test("when SOME books are available, only those are considered", () => {
    const mixed = {
      oddID: "x",
      byBookmaker: {
        betmgm: { odds: "-125", available: true },
        // Longer price but stale, so it must NOT win bestPrice.
        hardrockbet: { odds: "+150", available: false },
      },
    } as never;
    const books = allBookPrices(mixed);
    assert.equal(books.length, 1);
    assert.equal(books[0]!.bookmaker, "betmgm");
  });

  test("WIRING: the pool matches firstAvailableBook, so the selected book is always in it", () => {
    // extractPricedLine picks via firstAvailableBook. Whatever it selects must appear
    // in allBookPrices, otherwise betterPriceAvailable can contradict itself.
    const priced = extractPricedLine(settled, { requireLine: true, marketDescription: "saves" });
    assert.equal(priced.priced, true);
    const selected = priced.value!.bookmaker!;
    const pool = allBookPrices(settled).map((b) => b.bookmaker);
    assert.ok(pool.includes(selected), `selected book ${selected} is missing from the pool`);
  });
});

describe("v2.10.5 the board reports when a better price exists", () => {
  const resolve = {
    playerName: (id: string) => id,
    team: () => "Boston Bruins",
    marketLabel: (s: string) => s,
  };

  // betmgm won the display slot at -140 while hardrockbet has -130 on the same side.
  const side: PricedSide = {
    playerID: "DAVID_PASTRNAK_1_NHL",
    statID: "shots_onGoal",
    side: "over",
    line: 3.5,
    americanOdds: "-140",
    bookmaker: "betmgm",
    allBooks: [
      { bookmaker: "hardrockbet", americanOdds: "-130", line: "3.5" },
      { bookmaker: "betmgm", americanOdds: "-140", line: "3.5" },
    ],
  };

  test("THE BUG IN PLAIN VIEW: betterPriceAvailable is true and names the book", () => {
    const [row] = buildBoardRows([side], resolve);
    assert.equal(row!.over!.americanOdds, "-140");
    assert.equal(row!.over!.bookmaker, "betmgm");
    assert.equal(row!.over!.betterPriceAvailable, true);
    assert.equal(row!.over!.bestPrice!.bookmaker, "hardrockbet");
    assert.equal(row!.over!.bestPrice!.americanOdds, "-130");
    assert.equal(row!.over!.bookCount, 2);
  });

  test("betterPriceAvailable is false when the shown book IS the best", () => {
    const best: PricedSide = {
      ...side,
      americanOdds: "-130",
      bookmaker: "hardrockbet",
    };
    const [row] = buildBoardRows([best], resolve);
    assert.equal(row!.over!.betterPriceAvailable, false);
    assert.equal(row!.over!.bestPrice!.bookmaker, "hardrockbet");
  });

  test("allBooks is withheld by default and included on request", () => {
    const [plain] = buildBoardRows([side], resolve);
    assert.equal(plain!.over!.allBooks, undefined);

    const [full] = buildBoardRows([side], resolve, { includeAllBooks: true });
    assert.equal(full!.over!.allBooks!.length, 2);
    assert.equal(full!.over!.allBooks![0]!.bookmaker, "hardrockbet");
  });

  test("a side with no book data degrades to null bestPrice, not a crash", () => {
    const bare: PricedSide = { ...side, allBooks: undefined };
    const [row] = buildBoardRows([bare], resolve);
    assert.equal(row!.over!.bestPrice, null);
    assert.equal(row!.over!.betterPriceAvailable, false);
    assert.equal(row!.over!.bookCount, 0);
  });

  test("REGRESSION: the selected price is UNCHANGED, this is a visibility fix only", () => {
    // Flipping the default selection would change every tool's output at once, so
    // this release deliberately does not. If that ever changes, this test should be
    // the one that fails and forces the decision to be explicit.
    const [row] = buildBoardRows([side], resolve);
    assert.equal(row!.over!.americanOdds, side.americanOdds);
    assert.equal(row!.over!.bookmaker, side.bookmaker);
  });

  test("REGRESSION: split-line detection and one-sided rows still behave", () => {
    const under: PricedSide = { ...side, side: "under", line: 2.5, americanOdds: "+110", bookmaker: "espnbet", allBooks: [] };
    const [row] = buildBoardRows([side, under], resolve);
    assert.equal(row!.splitLine, true);
    assert.equal(row!.line, null);
    assert.equal(row!.sidesPriced, 2);

    const [solo] = buildBoardRows([side], resolve);
    assert.equal(solo!.sidesPriced, 1);
    assert.equal(solo!.under, null);
  });
});
