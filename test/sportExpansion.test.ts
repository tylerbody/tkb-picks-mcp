import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SUPPORTED_SPORTS,
  SPORT_CONFIG,
  PARTICIPANT_MODEL,
  participantModel,
  isIndividualSport,
  supportsCapability,
  unsupportedMessage,
  matchLinePeriodFor,
  type SportKey,
} from "../src/constants.js";
import { OU_PROP_MARKETS, YES_NO_MARKETS, SUPPORTED_PERIODS } from "../src/services/marketCatalog.js";
import { PERIOD_CODES } from "../src/services/oddIdBuilder.js";
import { seasonForDate } from "../src/services/seasonBoundary.js";

/**
 * ADDING A SPORT SHOULD BE A ROW PLUS A COMPILER ERROR, NEVER AN AUDIT.
 *
 * TypeScript enforces that every Record<SportKey, ...> table is filled. It does NOT
 * enforce that what was put in those rows is coherent - an empty array, a period
 * this sport does not play, or a capability flag that contradicts the catalog all
 * compile perfectly. That gap is what these tests cover.
 */

const NEW_IN_2_9_0: SportKey[] = ["cbb", "epl", "ucl", "ufc"];

describe("the four new sports are wired end to end", () => {
  test("each has a SPORT_CONFIG row with a real SGO leagueID", () => {
    const expected: Record<string, string> = {
      cbb: "NCAAB",
      epl: "EPL",
      ucl: "UEFA_CHAMPIONS_LEAGUE",
      ufc: "UFC",
    };
    for (const s of NEW_IN_2_9_0) {
      assert.equal(SPORT_CONFIG[s].sgoLeagueID, expected[s], `${s} leagueID`);
    }
  });

  test("each is in SUPPORTED_SPORTS, so every tool enum accepts it", () => {
    for (const s of NEW_IN_2_9_0) assert.ok(SUPPORTED_SPORTS.includes(s), `${s} missing`);
  });

  test("every sport has a participant model", () => {
    for (const s of SUPPORTED_SPORTS) assert.ok(PARTICIPANT_MODEL[s], `${s} has no model`);
  });
});

describe("the participant model - UFC is why this stopped being a boolean", () => {
  test("a fighter occupies a slot AND has props, which no boolean can express", () => {
    assert.equal(participantModel("ufc"), "fighters");
    assert.equal(isIndividualSport("ufc"), true, "a fighter is not on a roster");
    assert.equal(
      supportsCapability("ufc", "playerProps"),
      true,
      "and yet fighter props exist - this is the case the old boolean got wrong"
    );
  });

  test("tennis still means slots AND no props", () => {
    for (const s of ["atp", "wta"] as const) {
      assert.equal(participantModel(s), "participant_slots");
      assert.equal(supportsCapability(s, "playerProps"), false);
    }
  });

  test("the roster sports are unchanged", () => {
    for (const s of ["mlb", "nfl", "cfb", "wnba", "cbb", "epl", "ucl"] as const) {
      assert.equal(participantModel(s), "roster");
      assert.equal(isIndividualSport(s), false);
    }
  });
});

describe("catalogs are coherent with the capability flags", () => {
  test("a sport claiming playerProps has an actual prop catalog", () => {
    for (const s of SUPPORTED_SPORTS) {
      if (!supportsCapability(s, "playerProps")) continue;
      assert.ok(
        OU_PROP_MARKETS[s].length > 0,
        `${s} claims playerProps but its OU catalog is empty`
      );
    }
  });

  test("a sport with NO playerProps has an empty catalog, so nothing screens garbage", () => {
    for (const s of SUPPORTED_SPORTS) {
      if (supportsCapability(s, "playerProps")) continue;
      assert.equal(OU_PROP_MARKETS[s].length, 0, `${s} should have no prop catalog`);
      assert.equal(YES_NO_MARKETS[s].length, 0, `${s} should have no yes/no catalog`);
    }
  });

  test("no catalog entry has a blank statID or label", () => {
    for (const s of SUPPORTED_SPORTS) {
      for (const m of [...OU_PROP_MARKETS[s], ...YES_NO_MARKETS[s]]) {
        assert.ok(m.statID.trim().length, `${s} has an entry with no statID`);
        assert.ok(m.label.trim().length, `${s} has an entry with no label`);
      }
    }
  });

  test("labels are unique within a sport, since callers match on the label", () => {
    for (const s of SUPPORTED_SPORTS) {
      const labels = OU_PROP_MARKETS[s].map((m) => m.label.toLowerCase());
      assert.equal(new Set(labels).size, labels.length, `${s} has duplicate OU labels`);
    }
  });

  test("EVERY declared period resolves to a real SGO period code", () => {
    // A period with no code throws at buildOddID time, inside a tool, at night.
    for (const s of SUPPORTED_SPORTS) {
      for (const period of SUPPORTED_PERIODS[s]) {
        assert.ok(PERIOD_CODES[period], `${s} declares period "${period}" with no code`);
      }
    }
  });
});

describe("sport-specific facts that would be expensive to get wrong", () => {
  test("college basketball plays HALVES, not quarters", () => {
    assert.deepEqual(SUPPORTED_PERIODS.cbb, ["1st_half", "2nd_half"]);
  });

  test("UFC offers rounds, capped at five", () => {
    assert.equal(SUPPORTED_PERIODS.ufc.length, 5);
    assert.ok(SUPPORTED_PERIODS.ufc.includes("5th_round"));
  });

  test("SOCCER GOALS ARE `points`. There is no `goals` statID.", () => {
    for (const s of ["epl", "ucl"] as const) {
      const goals = OU_PROP_MARKETS[s].find((m) => m.label === "Goals");
      assert.equal(goals?.statID, "points", `${s} must price goals on the points statID`);
      assert.ok(
        !OU_PROP_MARKETS[s].some((m) => m.statID === "goals"),
        `${s} must not reference a "goals" statID - SGO has none`
      );
    }
  });

  test("UFC statIDs keep SGO's singular/plural split, which is the easy bug", () => {
    const ids = OU_PROP_MARKETS.ufc.map((m) => m.statID);
    // Landed is plural, attempts is singular. Quoted from SGO's MMA stat list.
    assert.ok(ids.includes("significant_strikes"));
    assert.ok(ids.includes("significant_strike_attempts"));
    assert.ok(ids.includes("takedowns_landed"));
    assert.ok(ids.includes("takedown_attempts"));
    assert.ok(!ids.includes("significant_strikes_landed"), "that string does not exist");
    assert.ok(!ids.includes("takedowns_attempted"), "that string does not exist");
  });

  test("CBB shares the NBA/WNBA basketball statID spellings exactly", () => {
    const wnba = new Set(OU_PROP_MARKETS.wnba.map((m) => m.statID));
    const shared = OU_PROP_MARKETS.cbb.filter((m) => wnba.has(m.statID));
    assert.ok(shared.length >= 14, "CBB should reuse the basketball namespace, not invent one");
  });
});

describe("season boundaries - the sports that span a year", () => {
  test("a February college basketball game belongs to the season that tipped in November", () => {
    assert.equal(seasonForDate("cbb", "2027-02-14T00:00:00Z")?.seasonYear, 2026);
    assert.equal(seasonForDate("cbb", "2026-11-14T00:00:00Z")?.seasonYear, 2026);
  });

  test("the NCAA tournament in March belongs to the previous calendar year's season", () => {
    assert.equal(seasonForDate("cbb", "2027-03-20T00:00:00Z")?.seasonYear, 2026);
  });

  test("a February Premier League fixture belongs to the August season", () => {
    assert.equal(seasonForDate("epl", "2027-02-01T00:00:00Z")?.seasonYear, 2026);
    assert.equal(seasonForDate("ucl", "2026-09-17T00:00:00Z")?.seasonYear, 2026);
  });

  test("UFC runs on the calendar year, having no season at all", () => {
    assert.equal(seasonForDate("ufc", "2026-01-02T00:00:00Z")?.seasonYear, 2026);
    assert.equal(seasonForDate("ufc", "2026-12-30T00:00:00Z")?.seasonYear, 2026);
  });
});

describe("refusals explain the REASON, per sport, not just 'not supported'", () => {
  test("every unsupported capability names the sport rather than saying 'not supported'", () => {
    // Length is NOT the test, and an earlier version of this assertion got that
    // wrong: "Weather is not a factor for WNBA." is short because it is complete.
    // What matters is that the reader can tell WHICH sport and WHY, and is not
    // invited to retry something that will never work.
    for (const s of SUPPORTED_SPORTS) {
      const label = SPORT_CONFIG[s].label;
      for (const cap of ["playerProps", "hitRates", "injuries", "weather", "teamSplits"] as const) {
        if (supportsCapability(s, cap)) continue;
        const msg = unsupportedMessage(s, cap);
        assert.match(msg, new RegExp(label), `${s}/${cap} refusal does not name the sport`);
        assert.doesNotMatch(
          msg,
          /^(not supported|unsupported)\.?$/i,
          `${s}/${cap} refusal is a bare "not supported"`
        );
      }
    }
  });

  test("the UFC hit-rate refusal names the source and the price of it", () => {
    const msg = unsupportedMessage("ufc", "hitRates");
    assert.match(msg, /GOAT/);
    assert.match(msg, /ufcstats/);
    assert.match(msg, /worse than no hit rate/);
  });

  test("the soccer hit-rate refusal names the free FPL route for whoever picks it up", () => {
    assert.match(unsupportedMessage("epl", "hitRates"), /fantasy\.premierleague\.com/);
  });

  test("a soccer refusal never claims a draw can be tallied as a win or loss", () => {
    assert.match(unsupportedMessage("epl", "teamSplits"), /DRAW/);
  });
});

describe("match-line period routing is exhaustive", () => {
  test("every sport resolves to a period that exists", () => {
    for (const s of SUPPORTED_SPORTS) {
      assert.ok(PERIOD_CODES[matchLinePeriodFor(s)], `${s} match-line period has no code`);
    }
  });
});
