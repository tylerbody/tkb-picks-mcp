import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  roundToNearestTen,
  impliedProbability,
  computeEdge,
} from "../src/services/oddsPricing.js";
import {
  describeRecency,
  STARTING_PITCHER_THRESHOLDS,
} from "../src/services/sampleRecency.js";
import { resolveStat } from "../src/services/bdlStatMap.js";
import { seasonForDate } from "../src/services/seasonBoundary.js";
import { buildOddID } from "../src/services/oddIdBuilder.js";
import { weightedTweetLength } from "../src/tools/tweetChars.js";
import {
  OU_PROP_MARKETS,
  YES_NO_MARKETS,
  SUPPORTED_PERIODS,
} from "../src/services/marketCatalog.js";
import {
  SUPPORTED_SPORTS,
  supportsCapability,
  isIndividualSport,
  type SportKey,
} from "../src/constants.js";

/**
 * WHY THIS FILE EXISTS.
 *
 * Every case below was worked out and confirmed BY HAND during a previous
 * release, and then existed only as prose in a CHANGES markdown file. v2.5.2
 * verified nine combo-stat cases. v2.5.3 verified six recency cases. v2.5.4
 * verified six more. That is twenty-one confirmed behaviours with nothing
 * stopping the next edit from silently breaking any of them.
 *
 * The `p_k` case in particular is currently protected by a COMMENT asking future
 * editors not to add "k" back to the pitcher strikeout resolver. A comment is a
 * request. A failing test is a wall - and the bug it guards against would have
 * published how often a PITCHER struck out as a HITTER: fully populated,
 * entirely plausible, completely wrong.
 *
 * Everything here is a pure function. No network, no API keys, no fixtures.
 * `npm test` runs in about a second.
 */

// ---------------------------------------------------------------------------
describe("odds rounding and pricing maths", () => {
  test("rounds to the nearest ten, with 5 going away from zero", () => {
    // The four cases named explicitly in oddsPricing.ts.
    assert.equal(roundToNearestTen("-136"), "-140");
    assert.equal(roundToNearestTen("-134"), "-130");
    assert.equal(roundToNearestTen("+106"), "+110");
    assert.equal(roundToNearestTen("+104"), "+100");
  });

  test("the 5 boundary rounds away from zero on both signs", () => {
    assert.equal(roundToNearestTen("-135"), "-140");
    assert.equal(roundToNearestTen("+105"), "+110");
  });

  test("exact tens are unchanged", () => {
    assert.equal(roundToNearestTen("-110"), "-110");
    assert.equal(roundToNearestTen("+100"), "+100");
  });

  /**
   * NOTE A DOC DISCREPANCY, deliberately asserted against the CODE.
   *
   * TKB_Picks_Style_Guide states "-113 -> -115". That contradicts the same
   * sentence's own rule ("0-4 rounds toward zero"), since 3 is in 0-4. Nearest
   * ten from -113 is -110, which is what this connector produces and what the
   * memory note ("odds rounded to nearest 10, 5-9 rounds away from zero")
   * describes. Treating the style guide example as a typo rather than changing
   * working code - but pinning it here so the decision is recorded rather than
   * rediscovered in an argument later.
   */
  test("-113 rounds to -110, not -115 (style guide example is a typo)", () => {
    assert.equal(roundToNearestTen("-113"), "-110");
    assert.equal(roundToNearestTen("-112"), "-110");
  });

  test("implied probability matches the documented example", () => {
    // "-150 returns 0.60, meaning the bet must win 60% of the time to break even."
    assert.equal(Number(impliedProbability(-150).toFixed(4)), 0.6);
    assert.equal(impliedProbability(100), 0.5);
    assert.equal(Number(impliedProbability(-110).toFixed(4)), 0.5238);
  });

  test("the Hoerner case: 7 of 11 at -186 is a NEGATIVE edge", () => {
    // The case oddsPricing.ts cites as the reason edge is returned at all. A raw
    // 63.6% hit rate reads like a play; break-even at -186 is 65.0%.
    const hitRate = 7 / 11;
    const edge = computeEdge(hitRate, -186);
    assert.ok(edge < 0, `expected negative edge, got ${edge}`);
    assert.ok(Math.abs(edge) < 0.02, "expected the miss to be narrow, near 1.4 points");
  });

  test("the Underdog case: a flat +100 board makes everything look like edge", () => {
    // 12 of 12 against a flat 50% break-even showed a 50-point edge. This is why
    // pick'em apps are blocked at the pricing layer rather than filtered later.
    assert.equal(computeEdge(1.0, 100), 0.5);
  });
});

// ---------------------------------------------------------------------------
describe("BDL stat resolution", () => {
  /**
   * THE MOST IMPORTANT TEST IN THIS FILE.
   *
   * BDL returns batting and pitching values on the SAME ROW and prefixes the
   * pitching counterparts with p_. An early resolver listed
   * ["pitching_strikeouts","strikeouts_pitched","pitcher_strikeouts",
   *  "strikeouts","so","k"] - none of the first five exist, so it fell through to
   * `k`, the BATTER strikeout field, which is populated on every row.
   */
  test("pitcher strikeouts read p_k and NEVER fall back to k", () => {
    const row = { k: 3, p_k: 7 };
    const res = resolveStat("mlb", "pitching_strikeouts", row);
    assert.equal(res.value, 7, "must read the pitching field, not the batting field");
    assert.equal(res.source, "p_k");
  });

  test("pitcher strikeouts return null rather than borrowing the batter field", () => {
    // A row with only the batting field must produce NO ANSWER. Returning 3 here
    // is the silent-failure mode: a real-looking number that means something else.
    const res = resolveStat("mlb", "pitching_strikeouts", { k: 3 });
    assert.equal(res.value, null);
    assert.equal(res.source, null);
  });

  test("the other p_ prefixed pitching fields behave the same way", () => {
    assert.equal(resolveStat("mlb", "pitching_hits", { hits: 2, p_hits: 5 }).value, 5);
    assert.equal(resolveStat("mlb", "pitching_basesOnBalls", { bb: 1, p_bb: 4 }).value, 4);
    assert.equal(resolveStat("mlb", "pitching_hits", { hits: 2 }).value, null);
  });

  test("a direct total_bases field wins over the derivation", () => {
    const res = resolveStat("mlb", "batting_totalBases", {
      total_bases: 7,
      hits: 2,
      doubles: 1,
      triples: 0,
      hr: 0,
    });
    assert.equal(res.value, 7);
    assert.equal(res.source, "total_bases");
  });

  test("total bases derive correctly when no direct field exists", () => {
    // 1 single + 1 double + 1 HR = 1 + 2 + 4 = 7
    const res = resolveStat("mlb", "batting_totalBases", {
      hits: 3,
      doubles: 1,
      triples: 0,
      hr: 1,
    });
    assert.equal(res.value, 7);
    assert.equal(res.source, "derived");
  });

  test("an inconsistent row returns null rather than a negative total", () => {
    // More extra-base hits than hits. Fabricating a number here would be worse
    // than admitting the row is broken.
    const res = resolveStat("mlb", "batting_totalBases", {
      hits: 1,
      doubles: 2,
      triples: 0,
      hr: 0,
    });
    assert.equal(res.value, null);
  });

  test("WNBA combo stats sum exactly (the Collier case from v2.5.2)", () => {
    // 8/16: 19 points, 6 rebounds, 2 assists = 27
    const res = resolveStat("wnba", "points+rebounds+assists", {
      pts: 19,
      reb: 6,
      ast: 2,
    });
    assert.equal(res.value, 27);
  });

  test("an all-zero combo sums to 0 and is NOT dropped", () => {
    // Verified before the feature was written: SGO stores a genuine 0 rather than
    // omitting the key. Had zeros been dropped, every summed line would have
    // silently lost a player's quiet games and inflated the rate.
    const res = resolveStat("wnba", "points+rebounds+assists", { pts: 0, reb: 0, ast: 0 });
    assert.equal(res.value, 0);
  });

  test("a missing component returns null, never a partial sum", () => {
    const res = resolveStat("wnba", "points+rebounds+assists", { pts: 19, reb: 6 });
    assert.equal(res.value, null, "a half-computed combo is the failure mode to avoid");
  });

  test("an unmapped stat returns null cleanly", () => {
    assert.equal(resolveStat("mlb", "fantasyScore", { pts: 40 }).value, null);
  });
});

// ---------------------------------------------------------------------------
describe("sample recency", () => {
  const NOW = new Date("2026-08-19T12:00:00Z");
  const log = (dates: string[]) => dates.map((d) => ({ date: d, statValue: 1 }));

  test("Sasaki: a healthy starter on normal rest is CLEAN", () => {
    // The v2.5.4 false positive. Ten starts every ~6 days naturally span ~60
    // days, so a 30-day ratio window was arithmetically impossible to satisfy.
    const dates = [
      "2026-08-14", "2026-08-08", "2026-07-31", "2026-07-24", "2026-07-17",
      "2026-07-09", "2026-07-03", "2026-06-27", "2026-06-21", "2026-06-15",
    ];
    const r = describeRecency(log(dates), STARTING_PITCHER_THRESHOLDS, NOW);
    assert.equal(r.isStale, false, `expected clean, fired: ${r.reasons.join("; ")}`);
  });

  test("Bassitt: one start in the window plus a 72-day hole is STALE", () => {
    // The case that motivated the whole module. Every number correct, the story
    // three months out of date.
    const dates = [
      "2026-08-14", "2026-06-03", "2026-05-28", "2026-05-22", "2026-05-16", "2026-05-10",
    ];
    const r = describeRecency(log(dates), STARTING_PITCHER_THRESHOLDS, NOW);
    assert.equal(r.isStale, true);
    assert.ok(r.largestGapDays !== null && r.largestGapDays > 30);
    assert.ok(r.warning?.includes("STALE SAMPLE"));
  });

  test("Sykes: a position player with a 63-day hole is STALE", () => {
    // Screened 8 of 8 and was the top prop on the WNBA board on v2.5.2.
    const dates = [
      "2026-08-16", "2026-06-14", "2026-06-12", "2026-06-09",
      "2026-06-06", "2026-06-03", "2026-06-01", "2026-05-30",
    ];
    const r = describeRecency(log(dates), {}, NOW);
    assert.equal(r.isStale, true);
  });

  test("Grisham: an everyday player is CLEAN", () => {
    const dates = [
      "2026-08-18", "2026-08-17", "2026-08-16", "2026-08-15", "2026-08-14",
      "2026-08-13", "2026-08-12", "2026-08-11", "2026-08-10", "2026-08-09",
    ];
    const r = describeRecency(log(dates), {}, NOW);
    assert.equal(r.isStale, false, `fired: ${r.reasons.join("; ")}`);
  });

  test("Collier: 9 straight since returning is CLEAN despite prior DNPs", () => {
    // Staleness and the IRREGULAR play-rate flag answer DIFFERENT questions.
    // IRREGULAR asks "will she play tonight". This asks "is the sample current".
    // She fails the first and passes the second, correctly.
    const dates = [
      "2026-08-16", "2026-08-13", "2026-08-09", "2026-08-08",
      "2026-08-07", "2026-08-02", "2026-07-31", "2026-07-29",
    ];
    const r = describeRecency(log(dates), {}, NOW);
    assert.equal(r.isStale, false, `fired: ${r.reasons.join("; ")}`);
  });

  test("DNP entries are ignored rather than counted as appearances", () => {
    const mixed = [
      { date: "2026-08-18", statValue: 2 },
      { date: "2026-08-17", statValue: null },
      { date: "2026-08-16", statValue: 1 },
    ];
    const r = describeRecency(mixed, {}, NOW);
    assert.equal(r.countedAppearances, 2);
  });

  test("an empty log is not stale, it is unknown", () => {
    const r = describeRecency([], {}, NOW);
    assert.equal(r.isStale, false);
    assert.equal(r.warning, null);
  });
});

// ---------------------------------------------------------------------------
describe("season boundary", () => {
  test("a January NFL playoff game belongs to the PREVIOUS season", () => {
    // The Drake Maye case: five games dated Jan/Feb 2026, all from the 2025
    // season, presented identically to current-season form.
    assert.equal(seasonForDate("nfl", "2026-01-15")?.seasonYear, 2025);
    assert.equal(seasonForDate("nfl", "2026-09-15")?.seasonYear, 2026);
  });

  test("tennis runs on the calendar year and never crosses a boundary", () => {
    assert.equal(seasonForDate("atp", "2026-01-15")?.seasonYear, 2026);
    assert.equal(seasonForDate("wta", "2026-11-01")?.seasonYear, 2026);
  });

  test("an unparseable date returns null rather than a guess", () => {
    assert.equal(seasonForDate("mlb", "not-a-date"), null);
  });
});

// ---------------------------------------------------------------------------
describe("oddID construction", () => {
  test("moneyline shape is what every tool assumes it is", () => {
    // Hardcoded as a payload-narrowing oddID in five separate tools. If this
    // shape ever changes, those all silently start pulling full odds maps.
    assert.equal(
      buildOddID({ statID: "points", entity: "home", period: "full_game", betType: "ml", side: "home" }),
      "points-home-game-ml-home"
    );
  });

  test("tennis set codes resolve", () => {
    assert.equal(
      buildOddID({ statID: "games", entity: "all", period: "1st_set", betType: "ou", side: "over" }),
      "games-all-1s-ou-over"
    );
  });

  test("the one confirmed MLB inning code still holds", () => {
    assert.equal(
      buildOddID({ statID: "points", entity: "all", period: "1st_5_innings", betType: "ou", side: "over" }),
      "points-all-1ix5-ou-over"
    );
  });

  test("an unknown period throws instead of building a broken oddID", () => {
    assert.throws(() =>
      buildOddID({
        statID: "points",
        entity: "all",
        period: "7th_set" as never,
        betType: "ou",
        side: "over",
      })
    );
  });
});

// ---------------------------------------------------------------------------
describe("X character weighting", () => {
  test("a URL costs a flat 23 regardless of its real length", () => {
    const short = weightedTweetLength("nxtbets.com/playtkb/");
    assert.equal(short.weighted, 23);
    assert.equal(short.urlsFound.length, 1);

    const long = weightedTweetLength("https://example.com/a/very/long/path/that/keeps/going");
    assert.equal(long.weighted, 23, "length of the real URL must not matter");
  });

  test("emoji cost 2 and variation selectors cost 0", () => {
    assert.equal(weightedTweetLength("A").weighted, 1);
    assert.equal(weightedTweetLength("\u26BE").weighted, 2); // baseball
    assert.equal(weightedTweetLength("\u2B07\uFE0F").weighted, 2); // down arrow + VS16
  });

  test("the CTA line is measured, not eyeballed", () => {
    const cta = "\uD83D\uDEA8 STACK A BONUS AT 6+ BOOKS. CODE TKBPICKS: nxtbets.com/playtkb/";
    const { weighted } = weightedTweetLength(cta);
    assert.ok(weighted < 280, `CTA should fit: ${weighted}`);
    assert.ok(weighted > 60, "sanity check that weighting actually ran");
  });
});

// ---------------------------------------------------------------------------
describe("sport configuration completeness", () => {
  /**
   * THE FORGOTTEN-TABLE TEST.
   *
   * SportKey is derived from SPORT_CONFIG, so adding a sport makes TypeScript
   * demand entries in every Record<SportKey, ...>. That protects the tables that
   * are TYPED that way. This test covers the rest: that the entries are present
   * and the right shape at runtime, and it will fail loudly the day NBA or NHL is
   * added and one of these is left out.
   */
  test("every sport has all three market-catalog tables", () => {
    for (const sport of SUPPORTED_SPORTS) {
      assert.ok(Array.isArray(OU_PROP_MARKETS[sport]), `OU_PROP_MARKETS missing ${sport}`);
      assert.ok(Array.isArray(YES_NO_MARKETS[sport]), `YES_NO_MARKETS missing ${sport}`);
      assert.ok(Array.isArray(SUPPORTED_PERIODS[sport]), `SUPPORTED_PERIODS missing ${sport}`);
    }
  });

  test("every sport resolves a season", () => {
    for (const sport of SUPPORTED_SPORTS) {
      assert.ok(seasonForDate(sport, "2026-06-15"), `no season for ${sport}`);
    }
  });

  test("tennis declares no roster-dependent capabilities", () => {
    for (const sport of ["atp", "wta"] as SportKey[]) {
      assert.equal(supportsCapability(sport, "playerProps"), false);
      assert.equal(supportsCapability(sport, "hitRates"), false);
      assert.equal(supportsCapability(sport, "weather"), false);
      assert.equal(supportsCapability(sport, "teamSplits"), false);
      assert.equal(isIndividualSport(sport), true);
    }
  });

  test("team sports keep every capability they had before the tennis build", () => {
    for (const sport of ["mlb", "nfl"] as SportKey[]) {
      assert.equal(supportsCapability(sport, "playerProps"), true);
      assert.equal(supportsCapability(sport, "hitRates"), true);
      assert.equal(supportsCapability(sport, "teamSplits"), true);
      assert.equal(isIndividualSport(sport), false);
    }
    // Known gaps, asserted so they are deliberate rather than accidental.
    assert.equal(supportsCapability("wnba", "weather"), false, "WNBA is indoors");
    assert.equal(supportsCapability("cfb", "injuries"), false, "not on the current BDL plan");
  });

  test("tennis prop catalogs are empty, which is what stops the screener", () => {
    assert.equal(OU_PROP_MARKETS.atp.length, 0);
    assert.equal(YES_NO_MARKETS.wta.length, 0);
    assert.ok(SUPPORTED_PERIODS.atp.includes("1st_set"));
  });
});
