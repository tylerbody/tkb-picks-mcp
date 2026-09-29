import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * v2.10.7: THE BOARD WAS NEVER "EVERY PROP IN THIS GAME".
 *
 * Five separate things removed props before anyone saw them, and the board reported
 * exactly one of them (`truncated`). A thread builder reading it had no way to know
 * the difference between "the books do not offer that" and "we filtered it out".
 *
 *   1. maxRows default 80. MEASURED on Philadelphia at Chicago, eventID
 *      iVXqTw1LGEj0TGVxDgTs: 142 rows built, 70 returned, and every returned row was
 *      a Bears player, because the cut follows SGO's response order. Half a game,
 *      presented as the game.
 *   2. betType must be `ou`, so every yes/no milestone market is gone: anytime
 *      scorer, first scorer, double-double.
 *   3. period must be `game`, so halves, quarters, hockey periods and
 *      first-N-innings props are gone.
 *   4. statID must be in the hand-maintained OU_PROP_MARKETS, so a market the books
 *      price but the catalog does not list is invisible. That is catalog drift and it
 *      is the same class of failure as the label crisis.
 *   5. includeAltLines was never passed, so only each market's MAIN line was ever
 *      visible and the whole alt ladder was permanently invisible.
 *
 * This release does not change ELIGIBILITY. It raises the cap, makes it sport-aware,
 * makes alt lines reachable, and makes every drop visible and attributable.
 */

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

// One NFL player with a realistic mix: two eligible full-game O/U markets, one yes/no,
// one first-half market, one market whose statID is not in the catalog, and one team
// level entity. Only the first two may become rows.
const PID = "CALEB_WILLIAMS_1_NFL";
const priced = (odds: string, ou: string) => ({
  byBookmaker: { draftkings: { odds, overUnder: ou, available: true } },
});

const EVENT = {
  eventID: "iVXqTw1LGEj0TGVxDgTs",
  type: "match",
  status: { started: false, startsAt: "2026-09-29T00:15:00.000Z" },
  teams: {
    home: { teamID: "CHICAGO_BEARS_NFL", names: { long: "Chicago Bears" } },
    away: { teamID: "PHILADELPHIA_EAGLES_NFL", names: { long: "Philadelphia Eagles" } },
  },
  players: {
    [PID]: { playerID: PID, name: "Caleb Williams", teamID: "CHICAGO_BEARS_NFL" },
  },
  odds: {
    // Eligible.
    [`passing_yards-${PID}-game-ou-over`]: priced("-110", "245.5"),
    [`passing_yards-${PID}-game-ou-under`]: priced("-110", "245.5"),
    [`passing_attempts-${PID}-game-ou-over`]: priced("-115", "33.5"),
    // Dropped: yes/no milestone market.
    [`passing_touchdowns-${PID}-game-yn-yes`]: priced("+120", ""),
    // Dropped: not the full-game period.
    [`passing_yards-${PID}-1h-ou-over`]: priced("-105", "120.5"),
    [`passing_yards-${PID}-2h-ou-over`]: priced("-105", "115.5"),
    // Dropped: statID absent from OU_PROP_MARKETS.
    [`passing_interceptions_thrown-${PID}-game-ou-over`]: priced("+140", "0.5"),
    // Dropped: team entity, not a rostered player.
    ["points-home-game-ou-over"]: priced("-110", "24.5"),
  },
};

const callBoard = async (extra: Record<string, unknown> = {}) => {
  const captured: Record<string, unknown>[] = [];
  const sgo = {
    leagueIDFor: () => "NFL",
    getAllEvents: async (params: Record<string, unknown>) => {
      captured.push(params);
      return [EVENT];
    },
  } as never;
  const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
  const { server, handlers } = captureServer();
  registerPropBoardTool(server as never, sgo);
  const res = (await handlers["tkb_get_prop_board"]({
    sport: "nfl",
    eventID: "iVXqTw1LGEj0TGVxDgTs",
    preferredBookmakers: "draftkings",
    includeUnpriced: false,
    includeAllBooks: false,
    includeAltLines: false,
    ...extra,
  } as never)) as { structuredContent?: Record<string, unknown> };
  return { res, captured };
};

describe("v2.10.7 the row cap is sport-aware and much higher", () => {
  test("NFL resolves to 400 when maxRows is omitted, not 80", async () => {
    const { res } = await callBoard();
    assert.equal(res.structuredContent?.maxRowsApplied, 400);
  });

  test("an explicit maxRows still wins", async () => {
    const { res } = await callBoard({ maxRows: 25 });
    assert.equal(res.structuredContent?.maxRowsApplied, 25);
  });

  test("the sport table is applied, not one flat number", async () => {
    const { defaultMaxRowsFor } = await import("../src/tools/propBoard.js");
    assert.equal(defaultMaxRowsFor("nfl"), 400);
    assert.equal(defaultMaxRowsFor("mlb"), 400);
    assert.equal(defaultMaxRowsFor("cfb"), 300);
    assert.equal(defaultMaxRowsFor("nhl"), 300);
    assert.equal(defaultMaxRowsFor("wnba"), 150);
    assert.equal(defaultMaxRowsFor("epl"), 150);
  });

  test("every sport's default clears the largest board measured for it", async () => {
    const { defaultMaxRowsFor } = await import("../src/tools/propBoard.js");
    // Measured built-row counts: MLB 254, NFL 142 for ONE team, NHL 102.
    assert.ok(defaultMaxRowsFor("mlb") > 254);
    assert.ok(defaultMaxRowsFor("nfl") > 142 * 2);
    assert.ok(defaultMaxRowsFor("nhl") > 102);
  });
});

describe("v2.10.7 alt lines are reachable", () => {
  test("THE BUG: the flag was never sent, so the alt ladder was invisible", async () => {
    const { captured } = await callBoard({ includeAltLines: true });
    assert.equal(captured[0]!.includeAltLines, true);
  });

  test("it stays off unless asked, for payload size", async () => {
    const { captured, res } = await callBoard();
    assert.equal(captured[0]!.includeAltLines, false);
    assert.equal(res.structuredContent?.altLinesIncluded, false);
  });

  test("the coverage note says which way it went, so it is never ambiguous", async () => {
    const off = await callBoard();
    const cov = off.res.structuredContent!.coverage as { note: string };
    assert.match(cov.note, /Alt lines were NOT requested/);

    const on = await callBoard({ includeAltLines: true });
    const cov2 = on.res.structuredContent!.coverage as { note: string };
    assert.match(cov2.note, /Alt lines WERE requested/);
  });
});

describe("v2.10.7 every dropped odd is counted and attributed", () => {
  test("the denominator is reported, so a slice cannot pass as the whole", async () => {
    const { res } = await callBoard();
    const cov = res.structuredContent!.coverage as Record<string, never>;
    // 8 odds in the fixture.
    assert.equal(cov.seenOdds as unknown as number, 8);
  });

  /* RESHAPED FOR v2.11.0, and the assertion got STRONGER rather than being relaxed.
   * In v2.10.7 this fixture's yes/no odd was counted under `dropped.notOverUnder` and
   * discarded. It is now COLLECTED into the yes/no section, so the check is that it
   * reached that section rather than that it was thrown away. The old bucket is gone
   * on purpose: it mixed yes/no markets with moneylines and spreads. */
  test("the yes/no odd is now collected, not dropped as notOverUnder", async () => {
    const { res } = await callBoard();
    const cov = res.structuredContent!.coverage as {
      yesNo: { seenOdds: number; sidesAccepted: number; rowsBuilt: number };
      otherBetTypes: { count: number };
    };
    assert.equal(cov.yesNo.seenOdds, 1);
    assert.equal(cov.yesNo.sidesAccepted, 1);
    assert.equal(cov.yesNo.rowsBuilt, 1);
    // And it is NOT lumped in with moneylines and spreads any more.
    assert.equal(cov.otherBetTypes.count, 0);
  });

  test("period props are counted AND the periods are named", async () => {
    const { res } = await callBoard();
    const cov = res.structuredContent!.coverage as {
      overUnder: {
        dropped: Record<string, number>;
        nonGamePeriodsSeen: Record<string, number>;
      };
    };
    assert.equal(cov.overUnder.dropped.nonGamePeriod, 2);
    assert.equal(cov.overUnder.nonGamePeriodsSeen["1h"], 1);
    assert.equal(cov.overUnder.nonGamePeriodsSeen["2h"], 1);
  });

  test("CATALOG DRIFT is visible: an unlisted statID is named, not just tallied", async () => {
    const { res } = await callBoard();
    const cov = res.structuredContent!.coverage as {
      overUnder: {
        dropped: Record<string, number>;
        statIDsNotInCatalog: Record<string, number>;
      };
    };
    assert.equal(cov.overUnder.dropped.notInCatalog, 1);
    assert.equal(cov.overUnder.statIDsNotInCatalog["passing_interceptions_thrown"], 1);
  });

  test("team-level entities are separated from player props", async () => {
    const { res } = await callBoard();
    const cov = res.structuredContent!.coverage as {
      overUnder: { dropped: Record<string, number> };
    };
    assert.equal(cov.overUnder.dropped.teamOrUnknownEntity, 1);
  });

  test("the eligible markets still become rows, so nothing was over-filtered", async () => {
    const { res } = await callBoard();
    assert.equal(res.structuredContent?.totalRowsBuilt, 2);
    const rows = res.structuredContent!.rows as { market: string }[];
    assert.deepEqual(rows.map((r) => r.market).sort(), ["Passing Attempts", "Passing Yards"]);
  });

  test("the buckets plus the accepted sides account for every odd seen", async () => {
    const { res } = await callBoard();
    const cov = res.structuredContent!.coverage as {
      seenOdds: number;
      unparsableOddID: number;
      unaccounted: number;
      otherBetTypes: { count: number };
      overUnder: { sidesAccepted: number; dropped: Record<string, number> };
      yesNo: { sidesAccepted: number; dropped: Record<string, number> };
    };
    const sum =
      cov.overUnder.sidesAccepted +
      cov.yesNo.sidesAccepted +
      cov.unparsableOddID +
      cov.otherBetTypes.count +
      Object.values(cov.overUnder.dropped).reduce((a, b) => a + b, 0) +
      Object.values(cov.yesNo.dropped).reduce((a, b) => a + b, 0);
    assert.equal(sum, cov.seenOdds);
    assert.equal(cov.unaccounted, 0);
  });
});
