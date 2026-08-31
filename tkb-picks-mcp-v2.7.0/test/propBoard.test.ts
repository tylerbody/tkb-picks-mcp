import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseOddID,
  buildBoardRows,
  type PricedSide,
  type BoardResolvers,
} from "../src/tools/propBoard.js";

/**
 * Every case here is REAL DATA pulled live on 2026-08-27 from the CFB Week 0
 * board, not invented fixtures. That matters for the two split-line cases in
 * particular: a hand-written example would probably have made both sides differ
 * only in price, which is the common case and not the one that breaks anything.
 *
 * Pinned per the v2.6.1 rule: logic that changes WHICH data reaches the user is
 * correctness logic and needs a test. npm test passed 39/39 against a build that
 * was returning year-stale hit rates, because the logic lived inside a function
 * that needed a network client.
 */

const resolvers: BoardResolvers = {
  playerName: (id) =>
    ({
      JORDAN_DWYER_1_NCAAF: "Jordan Dwyer",
      JORDAN_SHIPP_1_NCAAF: "Jordan Shipp",
      JAIDEN_THOMAS_1_NCAAF: "Jai'den Thomas",
      BRADY_KLUSE_1_NCAAF: "Brady Kluse",
      BENJAMIN_HALL_1_NCAAF: "Benjamin Hall",
    })[id] ?? id,
  team: (id) =>
    ({
      JORDAN_DWYER_1_NCAAF: "TCU",
      JORDAN_SHIPP_1_NCAAF: "North Carolina",
      JAIDEN_THOMAS_1_NCAAF: "UNLV",
      BRADY_KLUSE_1_NCAAF: "Memphis",
      BENJAMIN_HALL_1_NCAAF: "North Carolina",
    })[id] ?? "unknown",
  marketLabel: (statID) =>
    ({
      receiving_yards: "Receiving Yards",
      receiving_receptions: "Receptions",
      rushing_yards: "Rushing Yards",
      "batting_hits+runs+rbi": "Hits + Runs + RBIs",
    })[statID] ?? statID,
};

// ---- parseOddID ----

test("parseOddID splits a real CFB player prop oddID", () => {
  const p = parseOddID("receiving_yards-JORDAN_DWYER_1_NCAAF-game-ou-over");
  assert.deepEqual(p, {
    statID: "receiving_yards",
    entity: "JORDAN_DWYER_1_NCAAF",
    period: "game",
    betType: "ou",
    side: "over",
  });
});

test("parseOddID handles a combo statID", () => {
  // Combos join with "+", not "-", so parts[0] happens to work for every statID
  // currently in the catalog. Asserted anyway because that is a property of
  // today's catalog rather than of the format.
  const p = parseOddID("batting_hits+runs+rbi-SOME_PLAYER_1_MLB-game-ou-under");
  assert.equal(p?.statID, "batting_hits+runs+rbi");
  assert.equal(p?.entity, "SOME_PLAYER_1_MLB");
  assert.equal(p?.side, "under");
});

test("parseOddID slices from the RIGHT, so a hyphenated statID stays intact", () => {
  // THIS is the case that makes the slice load-bearing rather than stylistic.
  // Every statID in the catalog today is hyphen-free, so parts[0] would pass
  // every other test in this file - which is exactly why this one exists.
  // The last four segments are always entity/period/betType/side; everything
  // before them is the statID, however many hyphens it contains.
  const p = parseOddID("some-hyphenated-stat-PLAYER_1_NFL-game-ou-over");
  assert.equal(p?.statID, "some-hyphenated-stat");
  assert.equal(p?.entity, "PLAYER_1_NFL");
  assert.equal(p?.period, "game");
  assert.equal(p?.betType, "ou");
  assert.equal(p?.side, "over");
});

test("parseOddID reads team-level and period oddIDs without special-casing them", () => {
  assert.deepEqual(parseOddID("points-home-game-ml-home"), {
    statID: "points",
    entity: "home",
    period: "game",
    betType: "ml",
    side: "home",
  });
  // Non-game periods parse fine; the PERIOD FILTER lives in the tool, so this
  // must not be rejected here or the filter could never see it.
  assert.equal(parseOddID("points-all-1ix5-ou-over")?.period, "1ix5");
});

test("parseOddID returns null on malformed input instead of guessing", () => {
  assert.equal(parseOddID(""), null);
  assert.equal(parseOddID("points"), null);
  assert.equal(parseOddID("points-home-game-ml"), null);
});

// ---- buildBoardRows ----

test("collapses over and under onto a single row", () => {
  const sides: PricedSide[] = [
    {
      playerID: "JORDAN_DWYER_1_NCAAF",
      statID: "receiving_yards",
      side: "over",
      line: 52.5,
      americanOdds: "-114",
      bookmaker: "fanduel",
    },
    {
      playerID: "JORDAN_DWYER_1_NCAAF",
      statID: "receiving_yards",
      side: "under",
      line: 52.5,
      americanOdds: "-114",
      bookmaker: "fanduel",
    },
  ];
  const rows = buildBoardRows(sides, resolvers);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.playerName, "Jordan Dwyer");
  assert.equal(rows[0]!.market, "Receiving Yards");
  assert.equal(rows[0]!.line, 52.5);
  assert.equal(rows[0]!.splitLine, false);
  assert.equal(rows[0]!.sidesPriced, 2);
});

test("attaches the publishable rounded price to each side", () => {
  // Jordan Shipp receptions, the one market on the whole Week 0 board where the
  // two sides carried genuinely different prices at the same number.
  const rows = buildBoardRows(
    [
      {
        playerID: "JORDAN_SHIPP_1_NCAAF",
        statID: "receiving_receptions",
        side: "over",
        line: 5.5,
        americanOdds: "+116",
        bookmaker: "fanduel",
      },
      {
        playerID: "JORDAN_SHIPP_1_NCAAF",
        statID: "receiving_receptions",
        side: "under",
        line: 5.5,
        americanOdds: "-154",
        bookmaker: "fanduel",
      },
    ],
    resolvers
  );
  assert.equal(rows[0]!.over!.roundedOdds, "+120");
  assert.equal(rows[0]!.under!.roundedOdds, "-150");
  assert.equal(rows[0]!.splitLine, false);
});

test("flags a SPLIT LINE when the two sides are priced at different numbers", () => {
  // REAL: Jai'den Thomas rushing yards, 2026-08-27. DraftKings posted the over
  // at 79.5 and FanDuel the under at 76.5. Three yards apart. Read as two rows
  // this looks like two props; it is one unformed market with no single number.
  const rows = buildBoardRows(
    [
      {
        playerID: "JAIDEN_THOMAS_1_NCAAF",
        statID: "rushing_yards",
        side: "over",
        line: 79.5,
        americanOdds: "-124",
        bookmaker: "draftkings",
      },
      {
        playerID: "JAIDEN_THOMAS_1_NCAAF",
        statID: "rushing_yards",
        side: "under",
        line: 76.5,
        americanOdds: "-114",
        bookmaker: "fanduel",
      },
    ],
    resolvers
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.splitLine, true);
  // No single line, because publishing either one alone would misrepresent the market.
  assert.equal(rows[0]!.line, null);
  assert.equal(rows[0]!.over!.line, 79.5);
  assert.equal(rows[0]!.under!.line, 76.5);
  assert.match(rows[0]!.splitLineNote!, /SPLIT LINE/);
  assert.match(rows[0]!.splitLineNote!, /draftkings/);
  assert.equal(rows[0]!.over!.roundedOdds, "-120");
});

test("second real split line, four yards apart", () => {
  const rows = buildBoardRows(
    [
      {
        playerID: "BRADY_KLUSE_1_NCAAF",
        statID: "receiving_yards",
        side: "over",
        line: 39.5,
        americanOdds: "-103",
        bookmaker: "draftkings",
      },
      {
        playerID: "BRADY_KLUSE_1_NCAAF",
        statID: "receiving_yards",
        side: "under",
        line: 35.5,
        americanOdds: "-114",
        bookmaker: "fanduel",
      },
    ],
    resolvers
  );
  assert.equal(rows[0]!.splitLine, true);
  assert.equal(rows[0]!.over!.roundedOdds, "-100");
});

test("keeps a one-sided market rather than dropping it", () => {
  // "FanDuel posted the over and nobody posted the under" is real information
  // about a soft market. Dropping it would make the board understate what exists,
  // the same class of error as a silently clipped roster.
  const rows = buildBoardRows(
    [
      {
        playerID: "BENJAMIN_HALL_1_NCAAF",
        statID: "rushing_yards",
        side: "over",
        line: 46.5,
        americanOdds: "-114",
        bookmaker: "fanduel",
      },
    ],
    resolvers
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sidesPriced, 1);
  assert.equal(rows[0]!.under, null);
  assert.equal(rows[0]!.line, 46.5);
  assert.equal(rows[0]!.splitLine, false);
});

test("separates different markets belonging to the same player", () => {
  const rows = buildBoardRows(
    [
      {
        playerID: "JORDAN_DWYER_1_NCAAF",
        statID: "receiving_yards",
        side: "over",
        line: 52.5,
        americanOdds: "-114",
        bookmaker: "fanduel",
      },
      {
        playerID: "JORDAN_DWYER_1_NCAAF",
        statID: "receiving_receptions",
        side: "over",
        line: 4.5,
        americanOdds: "-120",
        bookmaker: "fanduel",
      },
    ],
    resolvers
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.market).sort(),
    ["Receiving Yards", "Receptions"]
  );
});

test("orders deterministically by team, then player, then market", () => {
  // A board that reorders itself between identical calls is hard to read against
  // a previous pull. Ranking is screen_props' job, not this tool's.
  const mk = (playerID: string, statID: string): PricedSide => ({
    playerID,
    statID,
    side: "over",
    line: 1.5,
    americanOdds: "-110",
    bookmaker: "fanduel",
  });
  const rows = buildBoardRows(
    [
      mk("JAIDEN_THOMAS_1_NCAAF", "rushing_yards"),
      mk("JORDAN_SHIPP_1_NCAAF", "receiving_yards"),
      mk("BENJAMIN_HALL_1_NCAAF", "rushing_yards"),
      mk("JORDAN_DWYER_1_NCAAF", "receiving_yards"),
      mk("BRADY_KLUSE_1_NCAAF", "receiving_yards"),
    ],
    resolvers
  );
  assert.deepEqual(
    rows.map((r) => `${r.team}/${r.playerName}`),
    [
      "Memphis/Brady Kluse",
      "North Carolina/Benjamin Hall",
      "North Carolina/Jordan Shipp",
      "TCU/Jordan Dwyer",
      "UNLV/Jai'den Thomas",
    ]
  );
});

test("an empty board is an empty array, not a throw", () => {
  assert.deepEqual(buildBoardRows([], resolvers), []);
});

test("falls back to raw ids when a name or label cannot be resolved", () => {
  const rows = buildBoardRows(
    [
      {
        playerID: "UNKNOWN_PLAYER_1_NCAAF",
        statID: "some_unmapped_stat",
        side: "over",
        line: 10.5,
        americanOdds: "-110",
        bookmaker: "fanduel",
      },
    ],
    resolvers
  );
  assert.equal(rows[0]!.playerName, "UNKNOWN_PLAYER_1_NCAAF");
  assert.equal(rows[0]!.market, "some_unmapped_stat");
  assert.equal(rows[0]!.team, "unknown");
});
