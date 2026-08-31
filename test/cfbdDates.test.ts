import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getCfbdPlayerHitRate } from "../src/services/cfbdHitRateAggregator.js";
import type { CFBDClient, CfbdGameBoxScore, CfbdGameMeta } from "../src/services/cfbdClient.js";

/**
 * THE BUG THIS PINS, caught by the first live run of the CFBD path on 2026-08-31.
 *
 * Dante Moore returned fifteen correct 2025 passing lines and:
 *
 *   seasonWarning: null
 *   priorSeasonGames: 0
 *   seasonsRepresented: []
 *   crossesSeasonBoundary: false
 *
 * Every value right. The single most important label missing, on a sport where every
 * opening-weeks sample is prior-season by construction.
 *
 * CAUSE: /games/players returns a bare numeric game id and nothing else identifying
 * the game, so the log was being stamped with a synthetic "2025-W7" string.
 * seasonForDate does `new Date("2025-W7")`, gets Invalid Date, and returns null - so
 * summarizeSeasons saw zero parseable dates and reported no boundary crossed.
 *
 * This is the SAME BUG as v2.0.2 on the BDL path, whose changelog records the
 * identical three consequences: no sorting, no recency, and a season guardrail that
 * "stayed silent" because it keys off dates and there were none.
 */

const boxScore = (gameId: number, yards: number): CfbdGameBoxScore => ({
  gameId,
  teams: [
    {
      team: "Oregon",
      conference: "Big Ten",
      homeAway: "home",
      points: 35,
      categories: [
        {
          name: "passing",
          types: [{ name: "YDS", athletes: [{ id: "9", name: "Dante Moore", stat: String(yards) }] }],
        },
      ],
    },
    {
      team: "Indiana",
      conference: "Big Ten",
      homeAway: "away",
      points: 21,
      categories: [],
    },
  ],
});

function fakeClient(opts: { dates: Map<number, CfbdGameMeta> | null }): CFBDClient {
  return {
    async getWeekPlayerStats({ week }: { week: number }) {
      // One game in week 7 only, so the walk terminates quickly.
      return week === 7 ? [boxScore(401752870, 300)] : [];
    },
    async getSeasonGames() {
      if (!opts.dates) throw new Error("games endpoint unavailable");
      return opts.dates;
    },
  } as unknown as CFBDClient;
}

const realDates = new Map<number, CfbdGameMeta>([
  [
    401752870,
    {
      gameId: 401752870,
      startDate: "2025-10-11T19:30:00.000Z",
      week: 7,
      seasonType: "regular",
      season: 2025,
      homeTeam: "Oregon",
      awayTeam: "Indiana",
      completed: true,
    },
  ],
]);

describe("CFBD dates are joined, not synthesised", () => {
  test("THE REGRESSION: a 2025 sample read in 2026 MUST carry the prior-season warning", async () => {
    const r = await getCfbdPlayerHitRate(fakeClient({ dates: realDates }), {
      teamName: "Oregon",
      playerName: "Dante Moore",
      statID: "passing_yards",
      line: 250.5,
      direction: "over",
      seasons: [2025],
    });

    assert.equal(r.gamesConsidered, 1);
    // The whole point: these were all null/0/false before the join.
    assert.equal(r.priorSeasonGames, 1);
    assert.deepEqual(r.seasonsRepresented, [2025]);
    assert.equal(r.crossesSeasonBoundary, true);
    assert.ok(r.seasonWarning, "seasonWarning must not be null on a prior-season sample");
    assert.match(r.seasonWarning ?? "", /PRIOR season/i);
  });

  test("the log carries a real ISO date, not a synthetic week label", async () => {
    const r = await getCfbdPlayerHitRate(fakeClient({ dates: realDates }), {
      teamName: "Oregon",
      playerName: "Dante Moore",
      statID: "passing_yards",
      line: 250.5,
      direction: "over",
      seasons: [2025],
    });
    const d = r.log[0].date;
    assert.equal(/W\d/.test(d), false, "must not be a synthetic 2025-W7 style label");
    assert.ok(!Number.isNaN(new Date(d).getTime()), "must parse as a real date");
  });

  test("HARD REFUSAL when no date resolves, rather than an unsortable rate", async () => {
    await assert.rejects(
      () =>
        getCfbdPlayerHitRate(fakeClient({ dates: null }), {
          teamName: "Oregon",
          playerName: "Dante Moore",
          statID: "passing_yards",
          line: 250.5,
          direction: "over",
          seasons: [2025],
        }),
      /DATE RESOLUTION FAILED/,
      "an unsortable sample is not a recent-form hit rate and must not be returned"
    );
  });
});
