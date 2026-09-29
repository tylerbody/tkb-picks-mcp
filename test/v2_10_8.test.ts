import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OU_PROP_MARKETS } from "../src/services/marketCatalog.js";
import { PERIOD_CODES } from "../src/services/oddIdBuilder.js";

/**
 * v2.10.8: the catalog gaps the v2.10.7 coverage block found, period access, and the
 * blind spot on the empty-board path.
 *
 * Everything added here came from MEASUREMENT, not from reading a docs page. The sweep
 * across 13 boards on 2026-09-28 and 2026-09-29 concentrated the drift in football.
 *
 * CORRECTED IN v2.10.9. This comment used to say the sweep found MLB and WNBA "perfectly
 * aligned with zero missing statIDs". That overstated what the sweep can prove. An empty
 * `statIDsNotInCatalog` means no UNCATALOGUED market was PRICED on the events measured,
 * not that the catalog is complete. WNBA was in fact four markets short of the shared
 * basketball namespace the whole time; see test/v2_10_9.test.ts, which checks the two
 * basketball blocks structurally instead of waiting for a book to post the market.
 */

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

describe("v2.10.8 catalog additions", () => {
  const labelsOf = (sport: keyof typeof OU_PROP_MARKETS) =>
    OU_PROP_MARKETS[sport].map((m) => m.label);
  const statIDsOf = (sport: keyof typeof OU_PROP_MARKETS) =>
    OU_PROP_MARKETS[sport].map((m) => m.statID);

  test("the five measured football statIDs are now in NFL", () => {
    for (const id of [
      "receiving_targets",
      "passing_interceptions",
      "punting_numPunts",
      "punting_puntsInside20",
      "fieldGoals_longestMade",
    ]) {
      assert.ok(statIDsOf("nfl").includes(id), `nfl missing ${id}`);
    }
  });

  test("CFB gets the same football entries, shared stat namespace", () => {
    for (const id of [
      "receiving_targets",
      "passing_interceptions",
      "punting_numPunts",
      "punting_puntsInside20",
      "fieldGoals_longestMade",
    ]) {
      assert.ok(statIDsOf("cfb").includes(id), `cfb missing ${id}`);
    }
  });

  test("NHL gets minutesPlayed as Time On Ice", () => {
    assert.ok(statIDsOf("nhl").includes("minutesPlayed"));
    assert.ok(labelsOf("nhl").includes("Time On Ice"));
  });

  test("THE LABEL COLLISION IS AVOIDED: passing_interceptions is NOT called Interceptions", () => {
    // defense_interceptions already owns "Interceptions" in the same block. Two statIDs
    // sharing a label would make the markets filter ambiguous and the grader wrong,
    // which is the exact failure documented in claude/market-label-contract.md.
    const nfl = OU_PROP_MARKETS.nfl;
    const thrown = nfl.find((m) => m.statID === "passing_interceptions")!;
    const defensive = nfl.find((m) => m.statID === "defense_interceptions")!;
    assert.equal(thrown.label, "Interceptions Thrown");
    assert.equal(defensive.label, "Interceptions");
    assert.notEqual(thrown.label, defensive.label);
  });

  test("NO sport has duplicate labels, which is what makes the markets filter safe", () => {
    for (const sport of Object.keys(OU_PROP_MARKETS) as (keyof typeof OU_PROP_MARKETS)[]) {
      const labels = labelsOf(sport);
      const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
      assert.deepEqual(dupes, [], `${sport} has duplicate labels: ${dupes.join(", ")}`);
    }
  });

  test("NO sport has duplicate statIDs either", () => {
    for (const sport of Object.keys(OU_PROP_MARKETS) as (keyof typeof OU_PROP_MARKETS)[]) {
      const ids = statIDsOf(sport);
      const dupes = ids.filter((l, i) => ids.indexOf(l) !== i);
      assert.deepEqual(dupes, [], `${sport} has duplicate statIDs: ${dupes.join(", ")}`);
    }
  });

  test("the four DELIBERATELY EXCLUDED statIDs stay out, in every sport", () => {
    // yards: ambiguous, could be a team total. largestLead: a team market, and this
    // catalog is player props only. rushing_yardsPerAttempt: a rate needing a
    // denominator. cornerKicks: entity unresolved. Each is documented in the source.
    for (const sport of Object.keys(OU_PROP_MARKETS) as (keyof typeof OU_PROP_MARKETS)[]) {
      for (const id of ["yards", "largestLead", "rushing_yardsPerAttempt", "cornerKicks"]) {
        assert.ok(!statIDsOf(sport).includes(id), `${sport} should not carry ${id}`);
      }
    }
  });

  test("REGRESSION: MLB is untouched by the football work", () => {
    assert.equal(OU_PROP_MARKETS.mlb.length, 20);
  });

  /* WNBA MOVED 16 -> 20 IN v2.10.9, and the count now lives in that release's test
   * alongside the parity check that justifies it. The assertion is not restated here,
   * because a count pinned in two files drifts in one of them. */
});

describe("v2.10.8 period access", () => {
  const EVENT = {
    eventID: "E",
    type: "match",
    status: { started: false, startsAt: "2026-10-04T17:00:00.000Z" },
    teams: {
      home: { teamID: "H", names: { long: "Home" } },
      away: { teamID: "A", names: { long: "Away" } },
    },
    players: { P1: { playerID: "P1", name: "Player One", teamID: "H" } },
    odds: {
      "passing_yards-P1-game-ou-over": {
        byBookmaker: { draftkings: { odds: "-110", overUnder: "245.5", available: true } },
      },
      "passing_yards-P1-1h-ou-over": {
        byBookmaker: { draftkings: { odds: "-105", overUnder: "120.5", available: true } },
      },
      "passing_yards-P1-1q-ou-over": {
        byBookmaker: { draftkings: { odds: "+100", overUnder: "55.5", available: true } },
      },
    },
  };

  const call = async (extra: Record<string, unknown> = {}) => {
    const sgo = { leagueIDFor: () => "NFL", getAllEvents: async () => [EVENT] } as never;
    const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
    const { server, handlers } = captureServer();
    registerPropBoardTool(server as never, sgo);
    return (await handlers["tkb_get_prop_board"]({
      sport: "nfl",
      eventID: "E",
      preferredBookmakers: "draftkings",
      ...extra,
    } as never)) as {
      isError?: boolean;
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    };
  };

  test("the default is still the full game, so nothing silently changed", async () => {
    const res = await call();
    assert.equal(res.structuredContent?.period, "full_game");
    assert.equal(res.structuredContent?.periodCode, "game");
    const rows = res.structuredContent!.rows as { over: { line: number } }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.over.line, 245.5);
  });

  test("THE NEW CAPABILITY: a first-half board is reachable", async () => {
    const res = await call({ period: "1st_half" });
    assert.equal(res.structuredContent?.periodCode, "1h");
    const rows = res.structuredContent!.rows as { over: { line: number } }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.over.line, 120.5);
  });

  test("a first-quarter board is reachable too", async () => {
    const res = await call({ period: "1st_quarter" });
    assert.equal(res.structuredContent?.periodCode, "1q");
    const rows = res.structuredContent!.rows as { over: { line: number } }[];
    assert.equal(rows[0]!.over.line, 55.5);
  });

  test("an unknown period is REFUSED by name, not silently empty", async () => {
    // A silent empty board would be indistinguishable from "this period has no markets".
    const res = await call({ period: "2nd_overtime" });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /not a recognized period/);
    assert.match(res.content[0]!.text, /full_game/);
  });

  test("one period vocabulary: every key the board accepts is a PERIOD_CODES key", async () => {
    for (const key of ["full_game", "1st_half", "1st_period", "1st_5_innings", "regulation"]) {
      assert.ok(PERIOD_CODES[key], `${key} missing from PERIOD_CODES`);
      const res = await call({ period: key });
      assert.notEqual(res.isError, true, `${key} was refused`);
    }
  });

  test("odds on other periods are counted, not silently discarded", async () => {
    const res = await call({ period: "1st_half" });
    // Nested under `overUnder` as of v2.11.0; the assertion is unchanged.
    const cov = res.structuredContent!.coverage as {
      overUnder: {
        dropped: Record<string, number>;
        nonGamePeriodsSeen: Record<string, number>;
      };
    };
    // game and 1q are both "other" when 1h is requested.
    assert.equal(cov.overUnder.dropped.nonGamePeriod, 2);
    assert.equal(cov.overUnder.nonGamePeriodsSeen["game"], 1);
    assert.equal(cov.overUnder.nonGamePeriodsSeen["1q"], 1);
  });
});

describe("v2.10.8 the empty board now says WHY", () => {
  const mk = (odds: Record<string, unknown>) => ({
    eventID: "E",
    type: "match",
    status: { started: false },
    teams: { home: { teamID: "H", names: { long: "Home" } }, away: { teamID: "A", names: { long: "Away" } } },
    players: {},
    odds,
  });

  const call = async (ev: unknown) => {
    const sgo = { leagueIDFor: () => "UCL", getAllEvents: async () => [ev] } as never;
    const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
    const { server, handlers } = captureServer();
    registerPropBoardTool(server as never, sgo);
    return (await handlers["tkb_get_prop_board"]({
      sport: "ucl",
      eventID: "E",
      preferredBookmakers: "draftkings",
    } as never)) as { content: { text: string }[]; structuredContent?: Record<string, unknown> };
  };

  test("THE UCL CASE: zero odds is reported as a coverage question, not a timing one", async () => {
    const res = await call(mk({}));
    const cov = res.structuredContent!.coverage as { oddsOnEvent: number; diagnosis: string };
    assert.equal(cov.oddsOnEvent, 0);
    assert.match(cov.diagnosis, /NO odds of any kind/);
    assert.match(cov.diagnosis, /league coverage or mapping question/);
    assert.match(res.content[0]!.text, /ZERO odds/);
  });

  test("odds present but none player-keyed is the tennis and UFC shape", async () => {
    const res = await call(
      mk({
        "points-home-game-ml-home": { byBookmaker: { draftkings: { odds: "-110", available: true } } },
        "points-away-game-ml-away": { byBookmaker: { draftkings: { odds: "-110", available: true } } },
      })
    );
    const cov = res.structuredContent!.coverage as {
      oddsOnEvent: number;
      playerKeyedOdds: number;
      diagnosis: string;
    };
    assert.equal(cov.oddsOnEvent, 2);
    assert.equal(cov.playerKeyedOdds, 0);
    assert.match(cov.diagnosis, /NONE are keyed to a playerID/);
  });

  test("player-keyed odds with an empty players object is a retry, not a gap", async () => {
    const res = await call(
      mk({
        "assists-SOME_PLAYER-game-ou-over": {
          byBookmaker: { draftkings: { odds: "-110", overUnder: "0.5", available: true } },
        },
      })
    );
    const cov = res.structuredContent!.coverage as { playerKeyedOdds: number; diagnosis: string };
    assert.equal(cov.playerKeyedOdds, 1);
    assert.match(cov.diagnosis, /Retry closer to game time/);
  });
});
