import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  OU_PROP_MARKETS,
  YES_NO_MARKETS,
  SUPPORTED_PERIODS,
  yesNoGradingFor,
} from "../src/services/marketCatalog.js";
import {
  SPORT_CONFIG,
  SUPPORTED_SPORTS,
  PARTICIPANT_MODEL,
  GAME_TOTAL_STAT,
} from "../src/constants.js";
import { duplicateLabelIndexes, namesAreUnique } from "../src/services/espnClient.js";

/**
 * v2.14.0: NBA enabled, soccer gaps closed, hit rates inverted to SGO-first, and the
 * ESPN NFL label collision recorded.
 *
 * Every number here came from a live measurement on 2026-09-29 to 2026-10-01, not from
 * reading a docs page.
 */

const key = (a: { statID: string; label: string }[]) =>
  a.map((m) => `${m.statID}|${m.label}`).sort().join("\n");

describe("v2.14.0 NBA is reachable", () => {
  test("nba is in the sport enum, which is what used to reject every call", () => {
    assert.ok(SUPPORTED_SPORTS.includes("nba"));
    assert.equal(SPORT_CONFIG.nba.sgoLeagueID, "NBA");
  });

  test("it claims player props, hit rates and team splits, and no injuries or weather", () => {
    assert.deepEqual(SPORT_CONFIG.nba.supports, {
      playerProps: true,
      hitRates: true,
      injuries: false,
      weather: false,
      teamSplits: true,
    });
  });

  /* THE ONE-NAMESPACE RULE, NOW THREE-WAY. SGO lists basketball statIDs once, not per
   * league. v2.10.9 pinned wnba against cbb after they silently drifted by four
   * markets; NBA joins the same check rather than being a fourth hand-written guess. */
  test("the three basketball blocks are identical in statIDs AND labels", () => {
    assert.equal(key(OU_PROP_MARKETS.nba), key(OU_PROP_MARKETS.cbb), "nba vs cbb over/under");
    assert.equal(key(YES_NO_MARKETS.nba), key(YES_NO_MARKETS.cbb), "nba vs cbb yes/no");
    assert.equal(
      key(OU_PROP_MARKETS.nba),
      key(OU_PROP_MARKETS.wnba),
      "nba vs wnba over/under"
    );
  });

  test("no duplicate rows crept in while copying the block", () => {
    for (const sport of ["nba", "cbb", "wnba"] as const) {
      for (const cat of [OU_PROP_MARKETS[sport], YES_NO_MARKETS[sport]]) {
        const ids = cat.map((m) => m.statID);
        assert.equal(new Set(ids).size, ids.length, `${sport} has a duplicate statID`);
        const labels = cat.map((m) => m.label);
        assert.equal(new Set(labels).size, labels.length, `${sport} has a duplicate label`);
      }
    }
  });

  test("points is labelled Score, never a bare Points, across all three", () => {
    for (const sport of ["nba", "cbb", "wnba"] as const) {
      assert.equal(
        OU_PROP_MARKETS[sport].find((m) => m.statID === "points")?.label,
        "Score"
      );
      assert.ok(!OU_PROP_MARKETS[sport].some((m) => m.label === "Points"));
    }
  });

  test("the per-sport tables all carry an nba entry", () => {
    assert.equal(PARTICIPANT_MODEL.nba, "roster");
    assert.equal(GAME_TOTAL_STAT.nba, "points");
    assert.deepEqual(SUPPORTED_PERIODS.nba, SUPPORTED_PERIODS.wnba);
  });

  test("NBA gradeability derives the same way as the other basketball leagues", () => {
    // Countable markets grade; the ordering and composite ones refuse.
    assert.equal(yesNoGradingFor("nba", "points").gradeable, true);
    assert.equal(yesNoGradingFor("nba", "rebounds").gradeable, true);
    for (const statID of ["doubleDouble", "tripleDouble", "firstBasket"]) {
      assert.equal(yesNoGradingFor("nba", statID).gradeable, false, statID);
    }
  });
});

describe("v2.14.0 the soccer gaps found by measurement", () => {
  /* 72 ODDS ON ONE MATCH. Liverpool v Manchester City, 2026-10-01, reported
   * yesNo.statIDsNotInCatalog { "goals+assists": 72 } - the largest single catalog gap
   * measured anywhere in this connector. */
  test("goals+assists is now a soccer yes/no market", () => {
    for (const sport of ["epl", "ucl"] as const) {
      const m = YES_NO_MARKETS[sport].find((x) => x.statID === "goals+assists");
      assert.ok(m, `${sport} still missing goals+assists`);
      assert.equal(m!.label, "Any Goal Or Assist");
    }
  });

  /* THREE STATIDS, THREE LABELS, NO AMBIGUITY. Hockey calls goals+assists "Any Point";
   * soccer does not use the word point at all, so reusing that label would make one
   * phrase mean two stats across the connector. */
  test("the three soccer milestone labels cannot be confused with each other", () => {
    const epl = YES_NO_MARKETS.epl;
    assert.equal(epl.find((m) => m.statID === "points")?.label, "Anytime Goalscorer");
    assert.equal(epl.find((m) => m.statID === "assists")?.label, "Any Assist");
    assert.equal(epl.find((m) => m.statID === "goals+assists")?.label, "Any Goal Or Assist");
    const labels = epl.map((m) => m.label);
    assert.equal(new Set(labels).size, labels.length);
    // And hockey keeps its own name for the same statID, which is correct.
    assert.equal(
      YES_NO_MARKETS.nhl.find((m) => m.statID === "goals+assists")?.label,
      "Any Point"
    );
  });

  test("it is gradeable, because soccer has a goals+assists over/under too", () => {
    assert.equal(yesNoGradingFor("epl", "goals+assists").gradeable, true);
    assert.equal(yesNoGradingFor("ucl", "goals+assists").gradeable, true);
  });

  /* `reg` APPEARED IN nonGamePeriodsSeen ON A LIVE BOARD: 6 over/under and 16 yes/no
   * odds, priced and unreachable, because tkb_get_period_odds validates against this
   * list. Soccer already settles match lines on `reg` elsewhere in the connector. */
  test("regulation is a reachable soccer period now", () => {
    for (const sport of ["epl", "ucl"] as const) {
      assert.ok(
        SUPPORTED_PERIODS[sport].includes("regulation"),
        `${sport} cannot reach regulation`
      );
      // The halves are untouched.
      assert.ok(SUPPORTED_PERIODS[sport].includes("1st_half"));
      assert.ok(SUPPORTED_PERIODS[sport].includes("2nd_half"));
    }
  });

  test("soccer hit rates are enabled, now that SGO carries the box scores", () => {
    assert.equal(SPORT_CONFIG.epl.supports.hitRates, true);
    assert.equal(SPORT_CONFIG.ucl.supports.hitRates, true);
  });
});

describe("v2.14.0 ESPN labels are not a safe mapping key", () => {
  // Verbatim from the live NFL gamelog, Jalen Hurts, espnId 4040715.
  const NFL_LABELS = ["CMP","ATT","YDS","CMP%","AVG","TD","INT","LNG","SACK","RTG","QBR","CAR","YDS","AVG","TD","LNG"];
  const NFL_NAMES = ["completions","passingAttempts","passingYards","completionPct","yardsPerPassAttempt","passingTouchdowns","interceptions","longPassing","sacks","QBRating","adjQBR","rushingAttempts","rushingYards","yardsPerRushAttempt","rushingTouchdowns","longRushing"];
  const WNBA_LABELS = ["MIN","PTS","REB","AST","STL","BLK","TO","FG","FG%","3PT","3P%","FT","FT%","PF"];

  /* THE TRAP. A mapping keyed on "YDS" for a quarterback picks up passing or rushing
   * yards depending on iteration order. Hurts went 153 passing and 25 rushing in one
   * game, and both are plausible numbers, which is the worst kind of wrong. */
  test("NFL repeats four labels across the passing and rushing halves", () => {
    const dup = duplicateLabelIndexes(NFL_LABELS);
    assert.deepEqual(dup, {
      YDS: [2, 12],
      AVG: [4, 13],
      TD: [5, 14],
      LNG: [7, 15],
    });
  });

  test("WNBA labels are unique, which is why this looked safe at first", () => {
    assert.deepEqual(duplicateLabelIndexes(WNBA_LABELS), {});
  });

  test("names ARE unique on NFL, so names or index is the safe key", () => {
    assert.equal(namesAreUnique(NFL_NAMES), true);
    assert.equal(namesAreUnique(WNBA_LABELS), true);
    // The duplicated labels map to genuinely different names.
    assert.equal(NFL_NAMES[2], "passingYards");
    assert.equal(NFL_NAMES[12], "rushingYards");
  });

  test("a league whose names collide is detectable rather than silent", () => {
    assert.equal(namesAreUnique(["a", "b", "a"]), false);
  });
});

// ---------------------------------------------------------------------------
// THE ROUTING INVERSION AND THE SILENT NO-OP. Wiring, not pure logic.
// ---------------------------------------------------------------------------

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

/** One finalized NFL game with a real box score, enough for the SGO rate path. */
const PID = "JALEN_HURTS_1_NFL";
const sgoStub = () => ({
  leagueIDFor: () => "NFL",
  getAllEvents: async () => [
    {
      eventID: "E1",
      type: "match",
      status: { completed: true, finalized: true, startsAt: "2026-09-20T17:00:00.000Z", displayShort: "Final" },
      teams: {
        home: { teamID: "PHILADELPHIA_EAGLES_NFL", names: { long: "Philadelphia Eagles" }, score: 24 },
        away: { teamID: "TENNESSEE_TITANS_NFL", names: { long: "Tennessee Titans" }, score: 17 },
      },
      players: { [PID]: { playerID: PID, name: "Jalen Hurts", teamID: "PHILADELPHIA_EAGLES_NFL" } },
      results: { game: { [PID]: { passing_yards: 264 } } },
      odds: {},
    },
  ],
} as never);

const callRate = async (extra: Record<string, unknown> = {}) => {
  const { registerHitRateTool } = await import("../src/tools/hitRate.js");
  const { server, handlers } = captureServer();
  registerHitRateTool(server as never, sgoStub(), { } as never, undefined, undefined, undefined);
  return handlers["tkb_get_player_hit_rate"]({
    sport: "nfl",
    teamID: "PHILADELPHIA_EAGLES_NFL",
    playerID: PID,
    playerName: "Jalen Hurts",
    statID: "passing_yards",
    line: 225.5,
    direction: "over",
    ...extra,
  } as never);
};

describe("v2.14.0 dataSource no longer lies", () => {
  /* THE BUG. `dataSource: "bdl"` on NFL used to fall straight through to SGO and return
   * SGO data with no provenance. Measured: two calls, one "sgo" and one "bdl", came
   * back byte-identical including SGO event IDs inside the supposed BDL log. */
  test("an explicit bdl request on a sport BDL cannot serve is REFUSED, not substituted", async () => {
    const res = await callRate({ dataSource: "bdl" });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent!.reason, "bdl_cannot_serve");
    assert.match(res.content[0].text, /CANNOT SERVE NFL/);
    assert.match(res.content[0].text, /silently returned SportsGameOdds data/);
    // It names where BDL does work, so the refusal is actionable.
    assert.deepEqual(res.structuredContent!.bdlSupportedSports, ["mlb", "wnba"]);
  });

  test("the refusal names the real coverage, including the WNBA tier gate", async () => {
    const res = await callRate({ dataSource: "bdl" });
    assert.match(res.content[0].text, /MLB and WNBA only/);
    assert.match(res.content[0].text, /gated behind GOAT/);
  });

  test("every SGO answer says which provider produced it", async () => {
    const res = await callRate();
    assert.equal(res.structuredContent!.statSourceUsed, "sgo");
    assert.match(res.content[0].text, /Source: SPORTSGAMEODDS/);
  });

  test("and explains WHY SGO is the default now, so the choice is auditable", async () => {
    const res = await callRate();
    assert.match(res.content[0].text, /3,000,000\/day/);
    assert.match(res.content[0].text, /verified against ESPN/);
  });

  test("an explicit sgo request behaves the same as the default", async () => {
    const auto = await callRate();
    const forced = await callRate({ dataSource: "sgo" });
    assert.equal(forced.structuredContent!.statSourceUsed, auto.structuredContent!.statSourceUsed);
  });
});

/* ---------------------------------------------------------------------------
 * THE INVERSION ITSELF, ON A SPORT WHERE BOTH PROVIDERS CAN SERVE.
 *
 * The NFL tests above cannot prove the default changed: BDL has no NFL resolvers, so
 * `canUseBdl` is false under the old rule AND the new one. A mutation run restoring
 * BDL-first passed every one of them. MLB is the only sport where the two rules
 * disagree, so this is where the default has to be pinned.
 *
 * The BDL client here COUNTS CALLS and throws if used. Under SGO-first it is never
 * touched; under the old BDL-first default it would be called first.
 * --------------------------------------------------------------------------- */

const MLB_PID = "AUSTIN_RILEY_1_MLB";
const mlbSgoStub = () => ({
  leagueIDFor: () => "MLB",
  getAllEvents: async () => [
    {
      eventID: "M1",
      type: "match",
      status: { completed: true, finalized: true, startsAt: "2026-09-28T18:00:00.000Z", displayShort: "Final" },
      teams: {
        home: { teamID: "ATLANTA_BRAVES_MLB", names: { long: "Atlanta Braves" }, score: 5 },
        away: { teamID: "PHILADELPHIA_PHILLIES_MLB", names: { long: "Philadelphia Phillies" }, score: 3 },
      },
      players: { [MLB_PID]: { playerID: MLB_PID, name: "Austin Riley", teamID: "ATLANTA_BRAVES_MLB" } },
      results: { game: { [MLB_PID]: { batting_hits: 2 } } },
      odds: {},
    },
  ],
} as never);

const callMlbRate = async (extra: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const bdlSpy = new Proxy({}, {
    get: (_t, prop) => {
      calls.push(String(prop));
      return () => {
        throw new Error("BDL must not be reached under the SGO-first default");
      };
    },
  });
  const { registerHitRateTool } = await import("../src/tools/hitRate.js");
  const { server, handlers } = captureServer();
  registerHitRateTool(server as never, mlbSgoStub(), bdlSpy as never, undefined, undefined, undefined);
  const res = await handlers["tkb_get_player_hit_rate"]({
    sport: "mlb",
    teamID: "ATLANTA_BRAVES_MLB",
    playerID: MLB_PID,
    playerName: "Austin Riley",
    statID: "batting_hits",
    line: 0.5,
    direction: "over",
    ...extra,
  } as never);
  return { res, calls };
};

describe("v2.14.0 SGO-first is the real default, proven on MLB", () => {
  test("BDL supports this stat, so the two routing rules genuinely disagree here", async () => {
    const { isStatSupported } = await import("../src/services/bdlStatMap.js");
    assert.equal(isStatSupported("mlb", "batting_hits"), true);
    assert.equal(isStatSupported("nfl", "passing_yards"), false);
  });

  /* THE MUTATION THIS EXISTS FOR: reverting canUseBdl to `dataSource !== "sgo"` must
   * fail here, because BDL would then be reached on an MLB default call. */
  test("the default does NOT touch BDL even though BDL could serve", async () => {
    const { res, calls } = await callMlbRate();
    assert.deepEqual(calls, [], `BDL was called: ${calls.join(", ")}`);
    assert.equal(res.structuredContent!.statSourceUsed, "sgo");
  });

  test("dataSource sgo is explicit about the same thing", async () => {
    const { res, calls } = await callMlbRate({ dataSource: "sgo" });
    assert.deepEqual(calls, []);
    assert.equal(res.structuredContent!.statSourceUsed, "sgo");
  });

  /* AND BDL IS STILL REACHABLE, which is the preservation half of the ask. Asking for
   * it on MLB must actually route there - here that surfaces as the spy throwing,
   * which the tool reports as a fallback rather than crashing. */
  test("an explicit bdl request on MLB really does reach BDL", async () => {
    const { res, calls } = await callMlbRate({ dataSource: "bdl" });
    assert.ok(calls.length > 0, "BDL was never reached on an explicit bdl request");
    // The spy throws, so the tool falls back to SGO and SAYS it fell back.
    assert.match(res.content[0].text, /FELL BACK TO SPORTSGAMEODDS/);
    assert.equal(res.structuredContent!.statSourceRequested, "bdl");
    assert.equal(res.structuredContent!.statSourceUsed, "sgo");
  });
});
