import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getEspnPlayerHitRate,
  EspnRefusal,
  PRESEASON_CAPABLE_SPORTS,
} from "../src/services/espnHitRateAggregator.js";

/**
 * v2.18.0: preseason games become ACCESSIBLE, explicitly, and never by accident.
 *
 * ESPN already returned NBA preseason games in the same payload, labelled
 * "2026-27 Preseason", and the aggregator discarded them with a hardcoded
 * `includePreseason: false`. Measured live 2026-10-06: Luka Doncic's first 2026-27
 * preseason game, 16 MINUTES, 21 points, 5-12 FG.
 *
 * The 16 minutes is why this is an opt-in with tagging rather than a default flip.
 * A preseason total is not evidence for a regular-season line, and counting one
 * silently is the NFL contamination bug from preseason-discriminator-measured-2026-10-01.md.
 */

const NBA = [
  "minutes", "fieldGoalsMade-fieldGoalsAttempted", "fieldGoalPct",
  "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "threePointPct",
  "freeThrowsMade-freeThrowsAttempted", "freeThrowPct", "totalRebounds", "assists",
  "blocks", "steals", "fouls", "turnovers", "points",
];
/* Luka's real preseason row, verbatim from the live probe. */
const PRE_ROW = ["16","5-12","41.7","3-9","33.3","8-9","88.9","2","3","0","2","1","5","21"];
const REG_ROW = (pts: string, min = "36") =>
  [min,"10-20","50.0","3-8","37.5","5-6","83.3","8","9","0","1","2","3",pts];

const TEAMS = {
  sports: [{ leagues: [{ teams: [
    { team: { id: "13", displayName: "Los Angeles Lakers", abbreviation: "LAL" } },
  ] }] }],
};
const ROSTER = { athletes: [{ id: "3945274", displayName: "Luka Doncic", firstName: "Luka" }] };

/* One payload carrying BOTH phases, exactly as ESPN returns them. */
const mixedLog = {
  names: NBA,
  labels: NBA,
  seasonTypes: [
    {
      displayName: "2026-27 Preseason",
      categories: [{ displayName: "Preseason", events: [
        { eventId: "P1", stats: PRE_ROW },
        { eventId: "P2", stats: ["18","4-10","40.0","1-5","20.0","2-2","100","3","4","0","1","2","2","11"] },
      ] }],
    },
    {
      displayName: "2025-26 Regular Season",
      categories: [{ displayName: "april", events: [
        { eventId: "R1", stats: REG_ROW("42") },
        { eventId: "R2", stats: REG_ROW("30") },
        { eventId: "R3", stats: REG_ROW("12", "26") },
      ] }],
    },
  ],
  events: {
    P1: { gameDate: "2026-10-04T02:00:00.000+00:00", atVs: "vs", opponent: { abbreviation: "GS" } },
    P2: { gameDate: "2026-10-02T02:00:00.000+00:00", atVs: "@", opponent: { abbreviation: "PHX" } },
    R1: { gameDate: "2026-04-01T02:30:00.000+00:00", atVs: "vs", opponent: { abbreviation: "CLE" } },
    R2: { gameDate: "2026-03-28T02:30:00.000+00:00", atVs: "vs", opponent: { abbreviation: "BKN" } },
    R3: { gameDate: "2026-03-25T23:00:00.000+00:00", atVs: "@", opponent: { abbreviation: "IND" } },
  },
};

const fakeEspn = (log: unknown, counter = { teams: 0, gamelog: 0 }) =>
  ({
    fetchTeams: async () => { counter.teams++; return { ok: true, data: TEAMS, elapsedMs: 1, url: "t" }; },
    fetchRoster: async () => ({ ok: true, data: ROSTER, elapsedMs: 1, url: "r" }),
    fetchGamelog: async () => { counter.gamelog++; return { ok: true, data: log, elapsedMs: 1, url: "g" }; },
  }) as never;

const base = {
  sport: "nba" as never,
  playerName: "Luka Doncic",
  teamName: "Los Angeles Lakers",
  statID: "points",
  line: 20.5,
  direction: "over" as const,
  asOf: new Date("2026-10-06T12:00:00Z"),
};

describe("v2.18.0 default is UNCHANGED: preseason excluded", () => {
  test("no preseason row is counted, and every row says regular", async () => {
    const r = await getEspnPlayerHitRate(fakeEspn(mixedLog), base);
    assert.equal(r.preseasonAppearances, 0);
    assert.equal(r.preseasonExcluded, true);
    assert.equal(r.seasonPhase, "regular");
    assert.equal(r.gamesConsidered, 3, "only R1, R2, R3");
    for (const row of r.log) assert.equal(row.seasonPhase, "regular");
    assert.ok(!r.log.some((l) => l.eventID.startsWith("P")), "a preseason game leaked into the default");
  });
});

describe('v2.18.0 seasonPhase "preseason": only preseason, tagged, with minutes', () => {
  test("counts ONLY the preseason games", async () => {
    const r = await getEspnPlayerHitRate(fakeEspn(mixedLog), { ...base, seasonPhase: "preseason" });
    assert.equal(r.gamesConsidered, 2);
    assert.equal(r.preseasonAppearances, 2);
    assert.deepEqual(r.log.map((l) => l.eventID), ["P1", "P2"], "newest first, preseason only");
    for (const row of r.log) assert.equal(row.seasonPhase, "preseason");
    assert.equal(r.gamesHit, 1, "21 clears 20.5, 11 does not");
  });

  /* THE POINT OF THE WHOLE FEATURE. 21 points in 16 minutes is not the same player as
   * 21 points in 34, and the minutes have to travel with the number. */
  test("minutes travel with every row", async () => {
    const r = await getEspnPlayerHitRate(fakeEspn(mixedLog), { ...base, seasonPhase: "preseason" });
    assert.equal(r.log[0].minutes, 16);
    assert.equal(r.log[1].minutes, 18);
  });

  test("the warning names it PRESEASON, lists the minutes, and says it is not form", async () => {
    const r = await getEspnPlayerHitRate(fakeEspn(mixedLog), { ...base, seasonPhase: "preseason" });
    assert.match(r.sampleWarning!, /PRESEASON GAMES COUNTED: 2 of 2/);
    assert.match(r.sampleWarning!, /16, 18 minute/);
    assert.match(r.sampleWarning!, /NOT evidence for a regular-season line/);
  });

  /* Last October's preseason is a year old and a different roster. Preseason mode must
   * read the current season only, which is one gamelog fetch, not two. */
  test("reads only the CURRENT season - one gamelog fetch", async () => {
    const counter = { teams: 0, gamelog: 0 };
    const r = await getEspnPlayerHitRate(fakeEspn(mixedLog, counter), { ...base, seasonPhase: "preseason" });
    assert.equal(counter.gamelog, 1, "preseason mode reached back into a prior season");
    assert.deepEqual(r.seasonsFetched, [2027]);
  });

  test("preseasonExcluded is false, so a caller cannot misread which games were used", async () => {
    const r = await getEspnPlayerHitRate(fakeEspn(mixedLog), { ...base, seasonPhase: "preseason" });
    assert.equal(r.preseasonExcluded, false);
    assert.equal(r.seasonPhase, "preseason");
  });
});

describe('v2.18.0 seasonPhase "both": blended, tagged, and the blend is stated', () => {
  test("both phases counted, each tagged correctly", async () => {
    const r = await getEspnPlayerHitRate(fakeEspn(mixedLog), { ...base, seasonPhase: "both" });
    assert.equal(r.gamesConsidered, 5);
    assert.equal(r.preseasonAppearances, 2);
    const byId = Object.fromEntries(r.log.map((l) => [l.eventID, l.seasonPhase]));
    assert.equal(byId.P1, "preseason");
    assert.equal(byId.R1, "regular");
  });

  test("the warning says the sample BLENDS phases and must be reported separately", async () => {
    const r = await getEspnPlayerHitRate(fakeEspn(mixedLog), { ...base, seasonPhase: "both" });
    assert.match(r.sampleWarning!, /BLENDS 2 preseason and 3 regular-season/);
    assert.match(r.sampleWarning!, /never as one rate/);
  });
});

describe("v2.18.0 sports without a preseason refuse BEFORE any HTTP", () => {
  test("soccer preseason refuses, and spends no request", async () => {
    const counter = { teams: 0, gamelog: 0 };
    await assert.rejects(
      () => getEspnPlayerHitRate(fakeEspn(mixedLog, counter), {
        ...base, sport: "epl" as never, statID: "shots_onGoal", line: 1.5, seasonPhase: "preseason",
      }),
      (err: unknown) => {
        assert.ok(err instanceof EspnRefusal);
        assert.match((err as Error).message, /friendlies/);
        return true;
      }
    );
    assert.equal(counter.teams, 0, "a code-level refusal must not spend a request");
  });

  test("the capable list is exactly nba, nfl, wnba", () => {
    assert.deepEqual([...PRESEASON_CAPABLE_SPORTS].sort(), ["nba", "nfl", "wnba"]);
  });
});

describe("v2.18.0 minutes are ABSENT, not zero, where there is no minutes column", () => {
  test("an NFL log carries no minutes field at all", async () => {
    const NFL_QB = [
      "completions","passingAttempts","passingYards","completionPct","yardsPerPassAttempt",
      "passingTouchdowns","interceptions","longPassing","sacks","QBRating","adjQBR",
      "rushingAttempts","rushingYards","yardsPerRushAttempt","rushingTouchdowns","longRushing",
    ];
    const row = ["25","39","283","64.1","7.3","3","2","46","3","90.0","47.6","12","66","5.5","0","26"];
    const log = {
      names: NFL_QB, labels: NFL_QB,
      seasonTypes: [{ displayName: "2026 Preseason", categories: [{ displayName: "Preseason", events: [{ eventId: "Q1", stats: row }] }] }],
      events: { Q1: { gameDate: "2026-08-15T17:00:00.000+00:00", atVs: "vs", opponent: { abbreviation: "CAR" } } },
    };
    const teams = { sports: [{ leagues: [{ teams: [{ team: { id: "2", displayName: "Buffalo Bills", abbreviation: "BUF" } }] }] }] };
    const roster = { athletes: [{ id: "3918298", displayName: "Josh Allen", firstName: "Josh" }] };
    const espn = {
      fetchTeams: async () => ({ ok: true, data: teams, elapsedMs: 1, url: "t" }),
      fetchRoster: async () => ({ ok: true, data: roster, elapsedMs: 1, url: "r" }),
      fetchGamelog: async () => ({ ok: true, data: log, elapsedMs: 1, url: "g" }),
    } as never;
    const r = await getEspnPlayerHitRate(espn, {
      sport: "nfl" as never, playerName: "Josh Allen", teamName: "Buffalo Bills",
      statID: "passing_yards", line: 100.5, direction: "over", seasonPhase: "preseason",
      asOf: new Date("2026-08-20T00:00:00Z"),
    });
    assert.equal(r.log[0].seasonPhase, "preseason");
    assert.equal("minutes" in r.log[0] ? r.log[0].minutes : undefined, undefined, "minutes must be absent, not 0");
    assert.doesNotMatch(r.sampleWarning!, /minute\(s\)/, "no minutes list where there is no minutes column");
  });
});

describe("v2.18.0 the tool refuses seasonPhase anywhere it would be silently ignored", () => {
  const captureServer = () => {
    const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>> = {};
    return { server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } }, handlers };
  };
  /* Every client explodes if touched. The refusal must happen before ANY of them. */
  const bomb = (name: string) =>
    new Proxy({}, { get: () => () => { throw new Error(`${name} must not be reached`); } }) as never;

  const call = async (args: Record<string, unknown>) => {
    const { registerHitRateTool } = await import("../src/tools/hitRate.js");
    const { server, handlers } = captureServer();
    registerHitRateTool(server as never, bomb("sgo"), bomb("bdl"), bomb("cfbd"), bomb("cbbd"), bomb("nhl"), bomb("espn"));
    return handlers["tkb_get_player_hit_rate"]({
      teamID: "X", playerID: "X", playerName: "X", statID: "points", line: 0.5, direction: "over",
      dataSource: "auto", ...args,
    } as never);
  };

  /* PLACEMENT IS THE TEST. The NHL branch returns early; if the gate sat after it, an
   * NHL preseason request would come back as a regular-season rate with the flag
   * dropped, and the bomb would never go off because the NHL client is a bomb too -
   * so this specifically asserts the structured refusal, not merely "no crash". */
  test("NHL preseason refuses before the NHL branch can answer it", async () => {
    const r = await call({ sport: "nhl", seasonPhase: "preseason" });
    assert.equal(r.structuredContent?.reason, "season_phase_unsupported");
  });

  test("soccer preseason refuses", async () => {
    const r = await call({ sport: "epl", statID: "shots_onGoal", seasonPhase: "preseason" });
    assert.equal(r.structuredContent?.reason, "season_phase_unsupported");
  });

  test("NBA preseason forced onto SGO refuses - SGO carries no NBA preseason", async () => {
    const r = await call({ sport: "nba", seasonPhase: "preseason", dataSource: "sgo" });
    assert.equal(r.structuredContent?.reason, "season_phase_unsupported");
    assert.match(r.content[0].text, /dataSource "sgo"/);
  });

  test("MLB preseason refuses", async () => {
    const r = await call({ sport: "mlb", statID: "batting_hits", seasonPhase: "both" });
    assert.equal(r.structuredContent?.reason, "season_phase_unsupported");
  });

  test("regular, the default, is never gated", async () => {
    // Reaches the ESPN branch and explodes on the bomb, which proves it was NOT refused.
    const r = await call({ sport: "nba" });
    assert.notEqual(r.structuredContent?.reason, "season_phase_unsupported");
  });
});

describe("v2.18.0 wiring", () => {
  const src = readFileSync(new URL("../src/tools/hitRate.ts", import.meta.url), "utf8");
  test("seasonPhase is in the tool schema with regular as the default", () => {
    assert.match(src, /seasonPhase: z\s*\.enum\(\["regular", "preseason", "both"\]\)\s*\.default\("regular"\)/);
  });
  /* THIS WAS A REGEX AND IT PASSED FOR THE WRONG REASON. `seasonPhase:
   * params.seasonPhase,` appears TWICE in hitRate.ts - in the pass-through to the
   * aggregator and in the refusal's structuredContent - so the regex matched the
   * refusal payload even with the pass-through deleted. Caught when the mutation
   * harness refused to apply an ambiguous anchor. Replaced with behaviour: drive the
   * real tool end to end and check the aggregator actually received the flag. */
  test("seasonPhase actually reaches the aggregator through the tool", async () => {
    const { registerHitRateTool } = await import("../src/tools/hitRate.js");
    const handlers: Record<string, (p: never) => Promise<{ structuredContent?: Record<string, unknown> }>> = {};
    const server = { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } };
    const bomb = new Proxy({}, { get: () => () => { throw new Error("must not be reached"); } }) as never;
    registerHitRateTool(server as never, bomb, bomb, bomb, bomb, bomb, fakeEspn(mixedLog));
    const r = await handlers["tkb_get_player_hit_rate"]({
      sport: "nba", teamID: "LOS_ANGELES_LAKERS_NBA", teamName: "Los Angeles Lakers",
      playerID: "LUKA_DONCIC_1_NBA", playerName: "Luka Doncic",
      statID: "points", line: 20.5, direction: "over",
      dataSource: "auto", seasonPhase: "preseason",
    } as never);
    assert.equal(r.structuredContent?.statSourceUsed, "espn");
    assert.equal(r.structuredContent?.seasonPhase, "preseason", "the flag never reached the aggregator");
    assert.equal(r.structuredContent?.preseasonAppearances, 2);
  });
  test("package.json agrees with SERVER_VERSION", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const idx = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.equal(pkg.version, idx.match(/const SERVER_VERSION = "([^"]+)";/)![1]);
  });
});
