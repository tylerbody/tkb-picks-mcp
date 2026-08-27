import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOddID } from "../src/services/oddIdParser.js";

/**
 * The five-segment cases are real oddIDs observed live. The six-segment cases are
 * built from SGO's DOCUMENTED format, which appends a bookmakerID:
 *   {statID}-{statEntityID}-{periodID}-{betTypeID}-{sideID}-{bookmakerID}
 *
 * No six-segment key has been seen in an event.odds payload to date. These tests
 * exist so that if one ever arrives it is parsed rather than silently misread as
 * side=bookmaker, betType=side, period=betType - all of which are plausible
 * strings that no downstream guardrail would catch.
 */

test("five-segment: real CFB player prop", () => {
  assert.deepEqual(parseOddID("receiving_yards-JORDAN_DWYER_1_NCAAF-game-ou-over"), {
    statID: "receiving_yards",
    entity: "JORDAN_DWYER_1_NCAAF",
    period: "game",
    betType: "ou",
    side: "over",
  });
});

test("five-segment: team moneyline and game total", () => {
  assert.equal(parseOddID("points-home-game-ml-home")?.betType, "ml");
  assert.equal(parseOddID("points-all-game-ou-under")?.entity, "all");
  assert.equal(parseOddID("points-all-1ix5-ou-over")?.period, "1ix5");
});

test("SIX-segment: trailing bookmakerID does not shift the other fields", () => {
  // Naive right-slicing reads side="fanduel", betType="over", period="ou".
  const p = parseOddID("receiving_yards-JORDAN_DWYER_1_NCAAF-game-ou-over-fanduel");
  assert.equal(p?.statID, "receiving_yards");
  assert.equal(p?.entity, "JORDAN_DWYER_1_NCAAF");
  assert.equal(p?.period, "game");
  assert.equal(p?.betType, "ou");
  assert.equal(p?.side, "over");
  assert.equal(p?.bookmakerID, "fanduel");
});

test("SIX-segment: works on a team market too", () => {
  const p = parseOddID("points-home-game-ml-home-draftkings");
  assert.equal(p?.side, "home");
  assert.equal(p?.betType, "ml");
  assert.equal(p?.bookmakerID, "draftkings");
});

test("hyphenated statID survives both forms", () => {
  assert.equal(parseOddID("some-hyphenated-stat-PLAYER_1_NFL-game-ou-over")?.statID, "some-hyphenated-stat");
  assert.equal(parseOddID("some-hyphenated-stat-PLAYER_1_NFL-game-ou-over-betmgm")?.statID, "some-hyphenated-stat");
});

test("combo statID (joined with +, not -) is unaffected", () => {
  assert.equal(
    parseOddID("batting_hits+runs+rbi-SOME_PLAYER_1_MLB-game-ou-under")?.statID,
    "batting_hits+runs+rbi"
  );
});

test("yes/no and 3-way sides are recognised", () => {
  assert.equal(parseOddID("batting_homeRuns-P_1_MLB-game-yn-yes")?.side, "yes");
  assert.equal(parseOddID("points-home-game-ml3way-draw")?.betType, "ml3way");
});

test("refuses rather than guessing when neither shape matches", () => {
  assert.equal(parseOddID(""), null);
  assert.equal(parseOddID("points"), null);
  assert.equal(parseOddID("points-home-game-ml"), null);
  // Unknown bet type in the anchor position: refuse, do not invent a reading.
  assert.equal(parseOddID("points-home-game-xx-over"), null);
  // Unknown side: same.
  assert.equal(parseOddID("points-home-game-ou-sideways"), null);
});

test("empty statID is refused", () => {
  assert.equal(parseOddID("-home-game-ou-over"), null);
});
