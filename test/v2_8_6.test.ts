import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveCfbdTeamName } from "../src/services/cfbdHitRateAggregator.js";
import { rawCharacterLength, weightedTweetLength } from "../src/tools/tweetChars.js";
import { isBlockedBookmaker } from "../src/services/oddsPricing.js";
import { DEFAULT_BOOKMAKERS } from "../src/constants.js";

/**
 * v2.8.6 TESTS.
 *
 * Every function asserted here is EXPORTED AND PURE for the reason v2.6.1 learned
 * the hard way and v2.6.3, v2.7.0, v2.8.4 and v2.8.5 each restated: logic that
 * decides WHICH DATA REACHES THE USER is correctness logic, and burying it inside a
 * function that needs an API client makes it unassertable. The 39-test suite passed
 * against the broken v2.6.0 window for exactly that reason.
 *
 * The cases below are built from the real 2026-09-02 CFB build, not from fixtures.
 */

// ---------------------------------------------------------------------------
// deriveCfbdTeamName - the bug this release exists for
// ---------------------------------------------------------------------------

test("deriveCfbdTeamName: the measured failing case", () => {
  // tools/hitRate.ts passed COLORADO_NCAAF into a matcher comparing against CFBD's
  // "Colorado". Exact normalised compare, never equal, so Julian Lewis returned
  // NO SAMPLE with cfbdPlayerID null and teamGamesScanned 0.
  assert.equal(deriveCfbdTeamName("COLORADO_NCAAF"), "Colorado");
});

test("deriveCfbdTeamName: multi-word programs", () => {
  assert.equal(deriveCfbdTeamName("GEORGIA_TECH_NCAAF"), "Georgia Tech");
  assert.equal(deriveCfbdTeamName("MICHIGAN_STATE_NCAAF"), "Michigan State");
  assert.equal(deriveCfbdTeamName("ILLINOIS_NCAAF"), "Illinois");
});

test("deriveCfbdTeamName: programs CFBD keeps capitalised", () => {
  // Title-casing these would produce "Uab" / "Byu", which match nothing.
  assert.equal(deriveCfbdTeamName("UAB_NCAAF"), "UAB");
  assert.equal(deriveCfbdTeamName("BYU_NCAAF"), "BYU");
  assert.equal(deriveCfbdTeamName("TCU_NCAAF"), "TCU");
  assert.equal(deriveCfbdTeamName("UCLA_NCAAF"), "UCLA");
});

test("deriveCfbdTeamName: explicit overrides for names title-case cannot reach", () => {
  assert.equal(deriveCfbdTeamName("OLE_MISS_NCAAF"), "Ole Miss");
  assert.equal(deriveCfbdTeamName("TEXAS_AM_NCAAF"), "Texas A&M");
  assert.equal(deriveCfbdTeamName("UMASS_NCAAF"), "UMass");
  assert.equal(deriveCfbdTeamName("UCONN_NCAAF"), "UConn");
});

test("deriveCfbdTeamName: already a plain name passes through", () => {
  // An explicit teamName always wins in hitRate.ts, but a caller passing a display
  // name into teamID must not have it mangled.
  assert.equal(deriveCfbdTeamName("Colorado"), "Colorado");
});

test("deriveCfbdTeamName: never returns empty", () => {
  // A blank result would silently match every team or none. Fall back to the input.
  assert.equal(deriveCfbdTeamName("_NCAAF"), "_NCAAF");
});

// ---------------------------------------------------------------------------
// rawCharacterLength - the second ceiling
// ---------------------------------------------------------------------------

/** The real Colorado @ Georgia Tech opener published for 2026-09-03. */
const REAL_OPENER =
  "\u{1F3C8} COLORADO @ GEORGIA TECH | 9/3 CFB PICKS \u{1F3C8}\n\n" +
  "CU fields an all-portal defense.\n\n" +
  "\u{1F6A8} SPREAD THE FIELD. BONUS BETS AT 6+ BOOKS. CODE TKBPICKS: nxtbets.com/playtkb/\n\n" +
  "⬇️ TODAY'S TOP 2 PICKS";

test("rawCharacterLength matches the python reference count", () => {
  // The CFB task computes this ceiling with
  //   python3 -c "print(len(open('f.txt').read()))"
  // which counts CODEPOINTS. This opener measured 182 there on 2026-09-02, so the
  // two counts must agree exactly or the tool is answering a different question.
  assert.equal(rawCharacterLength(REAL_OPENER), 182);
});

test("raw and weighted are genuinely different numbers", () => {
  // 182 raw vs 188 weighted on the same string: URLs cost 23 weighted but their
  // real length raw, and emoji cost 2 weighted but 1 raw. Clearing one ceiling
  // says nothing about the other, which is the whole reason both are reported.
  assert.equal(weightedTweetLength(REAL_OPENER).weighted, 188);
  assert.notEqual(rawCharacterLength(REAL_OPENER), weightedTweetLength(REAL_OPENER).weighted);
});

test("rawCharacterLength counts a variation selector, weighted does not", () => {
  const arrow = "⬇️"; // the coloured down arrow used in the swipe line
  assert.equal(rawCharacterLength(arrow), 2);
  assert.equal(weightedTweetLength(arrow).weighted, 2); // 2 for the emoji, 0 for VS16
});

test("rawCharacterLength counts surrogate pairs once", () => {
  assert.equal(rawCharacterLength("\u{1F3C8}"), 1);
});

// ---------------------------------------------------------------------------
// Bookmaker gates
// ---------------------------------------------------------------------------

test("hardrockbet is publishable", () => {
  // Never blocked by the pricing layer - it was invisible only because the request
  // filter excluded it. Pinned so a future blocklist edit cannot take it silently.
  assert.equal(isBlockedBookmaker("hardrockbet"), false);
});

test("real books observed live stay publishable", () => {
  for (const b of ["draftkings", "fanduel", "betmgm", "caesars", "espnbet"]) {
    assert.equal(isBlockedBookmaker(b), false, `${b} must not be blocked`);
  }
});

test("prophetexchange is deliberately NOT blocked", () => {
  // v2.6.2: it posts realistic two-way prices so it does not corrupt the edge
  // maths, and it is a TKB affiliate partner. Excluded from screening by the book
  // filter, which is a ranking decision, never by the pricing layer.
  assert.equal(isBlockedBookmaker("prophetexchange"), false);
});

test("offshore books are blocked at the pricing layer, not just by the filter", () => {
  // v2.8.3 caught tkb_get_line_movement pricing off BetOnline. Before v2.8.6 these
  // passed isRealBookmaker and were kept out only by a request filter three of six
  // tools happened to send.
  for (const b of ["betonline", "bovada", "mybookie", "betus", "everygame"]) {
    assert.equal(isBlockedBookmaker(b), true, `${b} must be blocked`);
  }
});

test("bookmaker matching is case and whitespace insensitive", () => {
  assert.equal(isBlockedBookmaker(" BetOnline "), true);
  assert.equal(isBlockedBookmaker("BOVADA"), true);
});

test("the three pre-existing block categories still hold", () => {
  assert.equal(isBlockedBookmaker("prizepicks"), true); // pick'em, flat pricing
  assert.equal(isBlockedBookmaker("underdog"), true);
  assert.equal(isBlockedBookmaker("fliff"), true); // real prices, unbettable here
  assert.equal(isBlockedBookmaker("polymarket"), true); // prediction market
  assert.equal(isBlockedBookmaker("kalshi"), true);
  assert.equal(isBlockedBookmaker("unknown"), true); // unattributable
});

test("DEFAULT_BOOKMAKERS contains only publishable venues", () => {
  const books = DEFAULT_BOOKMAKERS.split(",").map((b) => b.trim());
  assert.ok(books.length >= 5);
  for (const b of books) {
    assert.equal(isBlockedBookmaker(b), false, `${b} is in the default list but blocked`);
  }
  // A default containing a blocked venue would produce a permanently empty board
  // with no error, which is the failure shape this repo keeps rediscovering.
  assert.ok(books.includes("hardrockbet"));
});
