import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normaliseGame, teamNamesMatch } from "../src/services/mlbStatsClient.js";

/**
 * Shapes taken from real statsapi.mlb.com responses, verified 2026-08-31.
 *
 * THE DISTINCTION THESE TESTS EXIST TO PROTECT: an empty lineup means NOT POSTED
 * YET, never "this player is out". Probable pitchers are available days ahead;
 * lineups appear 3 to 4 hours before first pitch. A caller that reads an empty
 * lineup as a scratch would produce a false all-clear that is worse than the manual
 * web search this replaces.
 */

/** A scheduled game ten hours out: starters named, lineups object present but empty. */
const scheduledGame = {
  gamePk: 824876,
  gameDate: "2026-08-31T22:05:00Z",
  status: { detailedState: "Scheduled", abstractGameState: "Preview" },
  teams: {
    away: {
      team: { name: "San Francisco Giants" },
      probablePitcher: { id: 683627, fullName: "Anthony Molina" },
    },
    home: {
      team: { name: "Atlanta Braves" },
      probablePitcher: { id: 693821, fullName: "Bryce Elder" },
    },
  },
  lineups: {},
};

/** A game with the lineup posted. MLB returns nine, in batting order. */
const postedGame = {
  gamePk: 775300,
  gameDate: "2024-10-25T00:08:00Z",
  status: { detailedState: "Final" },
  teams: {
    away: { team: { name: "New York Yankees" }, probablePitcher: { id: 1, fullName: "Gerrit Cole" } },
    home: { team: { name: "Los Angeles Dodgers" }, probablePitcher: { id: 2, fullName: "Jack Flaherty" } },
  },
  lineups: {
    awayPlayers: [
      { id: 11, fullName: "Gleyber Torres", primaryPosition: { abbreviation: "2B" } },
      { id: 12, fullName: "Juan Soto", primaryPosition: { abbreviation: "RF" } },
      { id: 13, fullName: "Aaron Judge", primaryPosition: { abbreviation: "CF" } },
      { id: 14, fullName: "Jazz Chisholm Jr.", primaryPosition: { abbreviation: "3B" } },
      { id: 15, fullName: "Giancarlo Stanton", primaryPosition: { abbreviation: "DH" } },
      { id: 16, fullName: "Anthony Rizzo", primaryPosition: { abbreviation: "1B" } },
      { id: 17, fullName: "Anthony Volpe", primaryPosition: { abbreviation: "SS" } },
      { id: 18, fullName: "Austin Wells", primaryPosition: { abbreviation: "C" } },
      { id: 19, fullName: "Alex Verdugo", primaryPosition: { abbreviation: "LF" } },
    ],
    homePlayers: [
      { id: 21, fullName: "Shohei Ohtani", primaryPosition: { abbreviation: "DH" } },
      { id: 22, fullName: "Mookie Betts", primaryPosition: { abbreviation: "SS" } },
    ],
  },
};

describe("probable pitchers and lineups have different availability windows", () => {
  test("a scheduled game still names both starters", () => {
    const g = normaliseGame(scheduledGame);
    assert.equal(g.awayProbablePitcher?.fullName, "Anthony Molina");
    assert.equal(g.homeProbablePitcher?.fullName, "Bryce Elder");
  });

  test("THE CRITICAL CASE: an unposted lineup is empty, and that is not a scratch report", () => {
    const g = normaliseGame(scheduledGame);
    assert.deepEqual(g.homeLineup, []);
    assert.deepEqual(g.awayLineup, []);
    // The tool layer must render this as "not posted yet". Anything that reads an
    // empty array as absence produces a false all-clear.
  });

  test("a TBD starter resolves to null rather than a placeholder name", () => {
    const g = normaliseGame({
      ...scheduledGame,
      teams: {
        away: { team: { name: "San Francisco Giants" } },
        home: { team: { name: "Atlanta Braves" }, probablePitcher: { id: 693821, fullName: "Bryce Elder" } },
      },
    });
    assert.equal(g.awayProbablePitcher, null);
    assert.equal(g.homeProbablePitcher?.fullName, "Bryce Elder");
  });
});

describe("batting order comes from array position", () => {
  test("index 0 is the leadoff hitter, numbered from 1", () => {
    const g = normaliseGame(postedGame);
    assert.equal(g.awayLineup.length, 9);
    assert.equal(g.awayLineup[0].battingOrder, 1);
    assert.equal(g.awayLineup[0].fullName, "Gleyber Torres");
    assert.equal(g.awayLineup[8].battingOrder, 9);
    assert.equal(g.awayLineup[8].fullName, "Alex Verdugo");
  });

  test("position abbreviation is carried, and missing position is null not empty string", () => {
    const g = normaliseGame(postedGame);
    assert.equal(g.awayLineup[2].position, "CF");
    const noPos = normaliseGame({
      ...postedGame,
      lineups: { awayPlayers: [{ id: 99, fullName: "Test Player" }] },
    });
    assert.equal(noPos.awayLineup[0].position, null);
  });

  test("a partial lineup is reported at its real length, never padded to nine", () => {
    const g = normaliseGame(postedGame);
    assert.equal(g.homeLineup.length, 2);
    assert.equal(g.homeLineup[1].battingOrder, 2);
  });

  test("an entry missing an id or name is dropped rather than yielding a null slot", () => {
    const g = normaliseGame({
      ...postedGame,
      lineups: { awayPlayers: [{ id: 11, fullName: "Real Player" }, { fullName: "No Id" }, { id: 13 }] },
    });
    assert.equal(g.awayLineup.length, 1);
    assert.equal(g.awayLineup[0].fullName, "Real Player");
  });
});

describe("team name matching across providers", () => {
  test("exact and nickname forms both match", () => {
    assert.equal(teamNamesMatch("Atlanta Braves", "Atlanta Braves"), true);
    assert.equal(teamNamesMatch("Atlanta Braves", "Braves"), true);
    assert.equal(teamNamesMatch("Athletics", "Oakland Athletics"), true);
  });

  test("different teams do not match", () => {
    assert.equal(teamNamesMatch("Chicago Cubs", "Chicago White Sox"), false);
    assert.equal(teamNamesMatch("New York Yankees", "New York Mets"), false);
  });

  test("short trailing words do not create false matches", () => {
    // Guards against a two- or three-letter last token matching by accident.
    assert.equal(teamNamesMatch("Team A", "Other A"), false);
  });
});
