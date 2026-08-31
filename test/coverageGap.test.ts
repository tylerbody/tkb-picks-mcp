import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  lookupPlayerStat,
  assessAvailability,
  sizeLookbackWindow,
  PRIOR_SEASON_LOOKBACK,
  MAX_WINDOW_DAYS,
} from "../src/services/hitRateAggregator.js";
import type { SGOEvent } from "../src/types.js";

/**
 * THE REAL CASE THESE TESTS ARE BUILT FROM, not an invented fixture.
 *
 * Measured 2026-08-31 against the live connector. Dante Moore started every game of
 * Oregon's 2025 season. Asked for his passing-yards history, the connector reported:
 *
 *   playRate 0.2, IRREGULAR
 *   "appeared in only 3 of the last 15 team games (12 DNPs)"
 *
 * All twelve "DNPs" are games he started. SGO carries CFB games but not CFB player
 * box scores outside the playoff, and the absence of DATA was being counted as the
 * absence of a PLAYER. Maddux Madsen came back at playRate 0.07 the same way.
 */

/** A finalized game where the provider carries no player results at all. */
function gameWithNoBoxScore(): SGOEvent {
  return {
    eventID: "xY5k4b3KlF1azboyQUIw",
    players: {
      DANTE_MOORE_1_NCAAF: { firstName: "Dante", lastName: "Moore" },
      DAKORIEN_MOORE_1_NCAAF: { firstName: "Dakorien", lastName: "Moore" },
    },
    // The period keys exist - this is the detail that makes the bug subtle. What is
    // absent is any PLAYER entry inside them.
    results: { game: {}, "1q": {}, "2q": {} },
    teams: { home: { teamID: "OREGON_NCAAF" }, away: { teamID: "INDIANA_NCAAF" } },
  } as unknown as SGOEvent;
}

/** A game with a real box score in which our player genuinely does not appear. */
function gameWherePlayerSatOut(): SGOEvent {
  return {
    eventID: "playoff-1",
    players: {
      DANTE_MOORE_1_NCAAF: { firstName: "Dante", lastName: "Moore" },
      DAKORIEN_MOORE_1_NCAAF: { firstName: "Dakorien", lastName: "Moore" },
    },
    results: {
      game: { DAKORIEN_MOORE_1_NCAAF: { receiving_yards: 88 } },
    },
    teams: { home: { teamID: "OREGON_NCAAF" }, away: { teamID: "INDIANA_NCAAF" } },
  } as unknown as SGOEvent;
}

function gameWithValue(yards: number): SGOEvent {
  return {
    eventID: "playoff-2",
    players: { DANTE_MOORE_1_NCAAF: { firstName: "Dante", lastName: "Moore" } },
    results: { game: { DANTE_MOORE_1_NCAAF: { passing_yards: yards } } },
    teams: { home: { teamID: "OREGON_NCAAF" }, away: { teamID: "TEXAS_TECH_NCAAF" } },
  } as unknown as SGOEvent;
}

describe("coverage gap is not a DNP (the Dante Moore case)", () => {
  test("a game with no player results at all reports no_box_score, not a DNP", () => {
    const r = lookupPlayerStat(gameWithNoBoxScore(), "DANTE_MOORE_1_NCAAF", "passing_yards");
    assert.equal(r.kind, "no_box_score");
  });

  test("a game whose box score lists others but not this player IS a real DNP", () => {
    const r = lookupPlayerStat(gameWherePlayerSatOut(), "DANTE_MOORE_1_NCAAF", "passing_yards");
    assert.equal(r.kind, "player_absent");
  });

  test("a player present in the box score with an unsettled stat is not a DNP either", () => {
    const r = lookupPlayerStat(
      gameWithValue(285),
      "DANTE_MOORE_1_NCAAF",
      "rushing_yards" // he is in the box score, this stat is not settled
    );
    assert.equal(r.kind, "stat_unsettled");
  });

  test("a settled value still resolves normally", () => {
    const r = lookupPlayerStat(gameWithValue(285), "DANTE_MOORE_1_NCAAF", "passing_yards");
    assert.equal(r.kind, "value");
    if (r.kind === "value") assert.equal(r.value, 285);
  });

  test("THE REGRESSION: 3 appearances across 15 games, 12 of them uncovered, is NOT a 0.2 play rate", () => {
    // 15 scanned, 12 with no box score, 3 appearances, 0 genuine DNPs.
    const a = assessAvailability(3, 15, 0, 12, "position_player");
    // Denominator is the games that actually carry data, so 3 of 3 is a full rate.
    assert.equal(a.gamesWithData, 3);
    assert.equal(a.playRate, 1);
    assert.notEqual(a.flag, "IRREGULAR");
  });

  test("a genuine bench player still flags IRREGULAR", () => {
    // 30 scanned, all covered, appeared in 8. This must keep working.
    const a = assessAvailability(8, 30, 22, 0, "position_player");
    assert.equal(a.gamesWithData, 30);
    assert.equal(a.flag, "IRREGULAR");
    assert.match(a.note ?? "", /PLAYING TIME RISK/);
  });

  test("no covered games at all reports UNKNOWN, never a clean OK", () => {
    const a = assessAvailability(0, 14, 0, 14, "position_player");
    assert.equal(a.flag, "UNKNOWN");
    assert.match(a.note ?? "", /AVAILABILITY UNKNOWN/);
    // A false all-clear here is what a naive fix would produce.
    assert.notEqual(a.flag, "OK");
  });

  test("starting pitchers keep their rotation exemption", () => {
    const a = assessAvailability(6, 30, 24, 0, "starting_pitcher");
    assert.equal(a.flag, "ROTATION_NORMAL");
    assert.equal(a.note, null);
  });
});

describe("the opening-weeks window (the NFL Week 1 case)", () => {
  test("the in-season NFL default really is the 173-day window that misses last season", () => {
    const w = sizeLookbackWindow({
      sport: "nfl",
      targetAppearances: 15,
      teamGamesPerAppearance: 1,
      maxScan: 30,
    });
    assert.equal(w.windowDays, 173);
  });

  test("PRIOR_SEASON_LOOKBACK reaches the 400-day ceiling", () => {
    const w = sizeLookbackWindow({
      sport: "nfl",
      targetAppearances: PRIOR_SEASON_LOOKBACK.lookbackGames,
      teamGamesPerAppearance: 1,
      maxScan: PRIOR_SEASON_LOOKBACK.maxTeamGamesScanned,
    });
    assert.equal(w.windowDays, MAX_WINDOW_DAYS);
  });

  test("THE TRAP: raising lookbackGames ALONE is clamped to 225 days and misses the regular season", () => {
    // maxScan left at the position_player default of 30. This is what a caller who
    // passes one argument gets, and 225 days before a September opener lands in
    // January - the playoffs, not the season. It looks like it worked.
    const w = sizeLookbackWindow({
      sport: "nfl",
      targetAppearances: PRIOR_SEASON_LOOKBACK.lookbackGames,
      teamGamesPerAppearance: 1,
      maxScan: 30,
    });
    assert.equal(w.windowDays, 225);
    assert.notEqual(w.windowDays, MAX_WINDOW_DAYS);
  });

  test("CFB reaches the ceiling on the same flag", () => {
    const w = sizeLookbackWindow({
      sport: "cfb",
      targetAppearances: PRIOR_SEASON_LOOKBACK.lookbackGames,
      teamGamesPerAppearance: 1,
      maxScan: PRIOR_SEASON_LOOKBACK.maxTeamGamesScanned,
    });
    assert.equal(w.windowDays, MAX_WINDOW_DAYS);
  });
});
