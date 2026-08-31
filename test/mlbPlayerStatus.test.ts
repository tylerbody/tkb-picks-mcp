import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePlayerLineupStatus,
  normaliseName,
  type MlbGameMatchup,
  type MlbPlayerRef,
} from "../src/services/mlbStatsClient.js";

/**
 * THE TWO BUGS THESE PIN, found in live verification of v2.8.0.
 *
 * 1. OFF-DAY FALSE POSITIVE. Asking for Mookie Betts on 2026-08-31 returned
 *    "LINEUP NOT POSTED YET" for a date the Dodgers were not playing at all. A job
 *    polling for that lineup would wait forever for a game that does not exist.
 *
 * 2. NO NAME VALIDATION. "Zzzz Notaplayer" returned the identical reassuring
 *    message, verbatim, with the name echoed back unchecked.
 *
 * Both are the same root cause: v2.8.0 validated the LINEUP STATE and never the
 * PREMISE that the player exists and is scheduled. And both are the failure class
 * this connector exists to prevent - calm, plausible, wrong.
 *
 * The asymmetry was the tell. Once a lineup IS posted the tool hedged carefully on
 * spelling, because it had a roster to check against. Before one was posted it had
 * nothing to check against, and absence of a way to verify became absence of doubt.
 */

const game = (away: string, home: string, awayLineup: string[] = [], homeLineup: string[] = []): MlbGameMatchup => ({
  gamePk: 1,
  gameDate: "2026-08-31T22:05:00Z",
  detailedState: "Scheduled",
  awayTeam: away,
  homeTeam: home,
  awayProbablePitcher: null,
  homeProbablePitcher: null,
  awayLineup: awayLineup.map((n, i) => ({
    battingOrder: i + 1,
    playerId: 100 + i,
    fullName: n,
    position: "OF",
  })),
  homeLineup: homeLineup.map((n, i) => ({
    battingOrder: i + 1,
    playerId: 200 + i,
    fullName: n,
    position: "OF",
  })),
});

const ref = (fullName: string, teamName: string | null): MlbPlayerRef => ({
  id: 1,
  fullName,
  teamId: teamName ? 1 : null,
  teamName,
});

/** Tonight's slate. The Dodgers are deliberately NOT on it. */
const slate: MlbGameMatchup[] = [
  game("San Francisco Giants", "Atlanta Braves"),
  game("New York Mets", "Tampa Bay Rays"),
];

describe("the premise is checked before the lineup state", () => {
  test("REGRESSION 1: a player whose team is not playing does NOT read as 'lineup pending'", () => {
    const s = resolvePlayerLineupStatus(slate, [ref("Mookie Betts", "Los Angeles Dodgers")], "Mookie Betts");
    assert.equal(s.kind, "team_not_scheduled");
    // This is the whole bug: v2.8.0 returned the lineup_pending branch here, which
    // a polling job would wait on forever.
    assert.notEqual(s.kind, "lineup_pending");
  });

  test("REGRESSION 2: an unknown name does NOT read as 'lineup pending'", () => {
    const s = resolvePlayerLineupStatus(slate, undefined, "Zzzz Notaplayer");
    assert.equal(s.kind, "player_unknown");
    assert.notEqual(s.kind, "lineup_pending");
  });

  test("an empty candidate list is also unknown, not pending", () => {
    const s = resolvePlayerLineupStatus(slate, [], "Nobody At All");
    assert.equal(s.kind, "player_unknown");
  });

  test("two players sharing a name refuse rather than resolving to the first", () => {
    const s = resolvePlayerLineupStatus(
      slate,
      [ref("Will Smith", "Atlanta Braves"), ref("Will Smith", "New York Mets")],
      "Will Smith"
    );
    assert.equal(s.kind, "ambiguous");
    if (s.kind === "ambiguous") assert.equal(s.candidates.length, 2);
  });
});

describe("the correct pending case still works", () => {
  test("team IS playing and lineup is empty: pending, with the opponent named", () => {
    const s = resolvePlayerLineupStatus(slate, [ref("Matt Olson", "Atlanta Braves")], "Matt Olson");
    assert.equal(s.kind, "lineup_pending");
    if (s.kind === "lineup_pending") {
      assert.equal(s.teamName, "Atlanta Braves");
      assert.equal(s.opponent, "San Francisco Giants");
    }
  });
});

describe("posted lineups", () => {
  const posted: MlbGameMatchup[] = [
    game("San Francisco Giants", "Atlanta Braves", [], ["Ronald Acuna Jr.", "Matt Olson", "Marcell Ozuna"]),
  ];

  test("a player in the posted lineup returns his slot", () => {
    const s = resolvePlayerLineupStatus(posted, [ref("Matt Olson", "Atlanta Braves")], "Matt Olson");
    assert.equal(s.kind, "in_lineup");
    if (s.kind === "in_lineup") {
      assert.equal(s.slot.battingOrder, 2);
      assert.equal(s.opponent, "San Francisco Giants");
    }
  });

  test("a rostered player absent from a POSTED lineup is a real scratch", () => {
    const s = resolvePlayerLineupStatus(posted, [ref("Michael Harris II", "Atlanta Braves")], "Michael Harris II");
    assert.equal(s.kind, "not_in_posted_lineup");
    // Critically NOT pending: the lineup is out, so absence means something.
    assert.notEqual(s.kind, "lineup_pending");
  });

  test("accents and case do not break the lineup match", () => {
    const s = resolvePlayerLineupStatus(posted, [ref("Ronald Acuña Jr.", "Atlanta Braves")], "Ronald Acuña Jr.");
    assert.equal(s.kind, "in_lineup");
    if (s.kind === "in_lineup") assert.equal(s.slot.battingOrder, 1);
  });

  test("a player with no known team cannot be placed, and says so rather than guessing", () => {
    const s = resolvePlayerLineupStatus(posted, [ref("Free Agent", null)], "Free Agent");
    assert.equal(s.kind, "team_not_scheduled");
  });
});

describe("normaliseName", () => {
  test("strips accents, case and punctuation consistently", () => {
    assert.equal(normaliseName("Ronald Acuña Jr."), normaliseName("ronald acuna jr"));
    assert.equal(normaliseName("  Jazz  Chisholm Jr. "), "jazz chisholm jr");
  });
});
