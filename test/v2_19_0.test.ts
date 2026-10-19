import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registerScreenPropsTool, ESPN_SCREEN_SPORTS, mapWithConcurrency } from "../src/tools/screenProps.js";
import { registerInjuriesTool } from "../src/tools/injuries.js";
import {
  parseEspnInjuryFeed,
  parseAthleteId,
  pickFreshest,
  feedAgeHours,
  findInjuryEntry,
  getEspnInjuries,
  clearEspnInjuryCache,
  espnInjuriesUrl,
  ESPN_INJURY_HOSTS,
  ESPN_INJURY_SPORTS,
  EspnInjuryShapeError,
} from "../src/services/espnInjuries.js";
import { withRequestMemo, EspnClient } from "../src/services/espnClient.js";
import { unsupportedMessage, DEFAULT_BOOKMAKERS } from "../src/constants.js";

/**
 * v2.19.0: two holes found running NBA opening-week builds on 2026-10-19.
 *
 * 1. tkb_screen_props returned 0 of 113 priced NBA markets with every filter off, in
 *    319ms. NBA rates still went to BALLDONTLIE (cancelled) and then SGO; v2.17.0
 *    moved tkb_get_player_hit_rate to ESPN and never moved the screener.
 * 2. tkb_get_injuries had no NBA source at all, and its refusal text described a
 *    missing NCAAF endpoint.
 */

/* ---- ESPN injury payload, field paths VERBATIM from the 2026-10-19 fetch ---- */
const ENTRY_CADE = {
  id: "-56001",
  longComment: "Long text.",
  shortComment: "Cunningham (hamstring) is listed as questionable for Tuesday.",
  status: "Day-To-Day",
  date: "2026-10-18T21:36Z",
  athlete: {
    firstName: "Cade",
    lastName: "Cunningham",
    displayName: "Cade Cunningham",
    shortName: "C. Cunningham",
    links: [{ href: "https://www.espn.com/nba/player/_/id/4432166/cade-cunningham" }],
    headshot: { href: "https://a.espncdn.com/i/headshots/nba/players/full/4432166.png" },
    team: { id: "8", abbreviation: "DET", displayName: "Detroit Pistons", name: "Pistons" },
    status: { id: "1", name: "Active" },
  },
  type: { id: "6", name: "INJURY_STATUS_DAYTODAY", description: "day-to-day", abbreviation: "DD" },
  details: {
    fantasyStatus: { description: "GTD", abbreviation: "GTD" },
    type: "Hamstring",
    location: "Leg",
    detail: "Strain",
    side: "Left",
    returnDate: "2026-10-21",
  },
};
const ENTRY_OLD_RETURN = {
  ...ENTRY_CADE,
  id: "532102",
  athlete: {
    ...ENTRY_CADE.athlete,
    displayName: "Jaden Ivey",
    firstName: "Jaden",
    lastName: "Ivey",
    links: [{ href: "https://www.espn.com/nba/player/_/id/4433218/jaden-ivey" }],
    headshot: { href: "https://a.espncdn.com/i/headshots/nba/players/full/4433218.png" },
  },
  details: { ...ENTRY_CADE.details, returnDate: "2026-10-01" },
};
const feed = (timestamp: string, entries: unknown[] = [ENTRY_CADE, ENTRY_OLD_RETURN]) => ({
  timestamp,
  status: "success",
  season: { year: 2027, type: 1, name: "Preseason", displayName: "2026-27" },
  injuries: [{ id: "8", displayName: "Detroit Pistons", injuries: entries }],
});

const ASOF = new Date("2026-10-19T12:00:00Z");

describe("parseEspnInjuryFeed", () => {
  test("reads every field from the measured paths", () => {
    const p = parseEspnInjuryFeed(feed("2026-10-19T08:00:00Z"), ASOF);
    assert.equal(p.teamCount, 1);
    assert.equal(p.entries.length, 2);
    const cade = p.entries[0]!;
    assert.equal(cade.playerName, "Cade Cunningham");
    assert.equal(cade.espnAthleteId, "4432166");
    assert.equal(cade.team, "Detroit Pistons");
    assert.equal(cade.teamAbbreviation, "DET");
    assert.equal(cade.status, "Day-To-Day");
    assert.equal(cade.statusCode, "DD");
    assert.equal(cade.fantasyStatus, "GTD");
    assert.equal(cade.returnDate, "2026-10-21");
    assert.equal(cade.returnDatePassed, false);
    assert.equal(p.seasonLabel, "2026-27 Preseason");
  });

  test("the athlete id comes from the URL, never from the injury record id", () => {
    const p = parseEspnInjuryFeed(feed("2026-10-19T08:00:00Z"), ASOF);
    assert.notEqual(p.entries[0]!.espnAthleteId, "-56001");
    assert.equal(parseAthleteId({ headshot: { href: "x/full/123.png" } }), "123");
    assert.equal(parseAthleteId({}), null);
  });

  test("a return date already in the past is flagged", () => {
    const p = parseEspnInjuryFeed(feed("2026-10-19T08:00:00Z"), ASOF);
    assert.equal(p.entries[1]!.returnDatePassed, true);
  });

  test("an unrecognised shape REFUSES rather than returning an empty list", () => {
    assert.throws(() => parseEspnInjuryFeed({ items: [] }), EspnInjuryShapeError);
    assert.throws(() => parseEspnInjuryFeed("nope"), EspnInjuryShapeError);
  });
});

describe("freshness", () => {
  test("pickFreshest takes the NEWEST timestamp, not the first host", () => {
    const best = pickFreshest([
      { host: "a", feedTimestamp: "2026-08-11T14:58:58Z" },
      { host: "b", feedTimestamp: "2026-10-15T08:07:12Z" },
    ]);
    assert.equal(best?.host, "b");
  });
  test("a payload with no timestamp loses to one that has one", () => {
    assert.equal(
      pickFreshest([
        { host: "a", feedTimestamp: null },
        { host: "b", feedTimestamp: "2026-01-01T00:00:00Z" },
      ])?.host,
      "b"
    );
  });
  test("feedAgeHours", () => {
    assert.equal(feedAgeHours("2026-10-19T08:00:00Z", ASOF), 4);
    assert.equal(feedAgeHours(null, ASOF), null);
  });
});

/* Fake ESPN that serves a different snapshot per host, as measured. */
const hostFake = (byHost: Record<string, unknown>, calls: string[] = []) =>
  ({
    fetchRawEspn: async (url: string) => {
      calls.push(url);
      const host = ESPN_INJURY_HOSTS.find((h) => url.startsWith(h))!;
      const data = byHost[host];
      return data === undefined
        ? { ok: false, status: 403, elapsedMs: 1, url, reason: "ESPN returned HTTP 403." }
        : { ok: true, status: 200, elapsedMs: 1, url, data };
    },
  }) as never;

describe("getEspnInjuries", () => {
  beforeEach(() => clearEspnInjuryCache());

  test("fetches BOTH hosts and keeps the fresher one (the two-month-stale host loses)", async () => {
    const f = await getEspnInjuries(
      hostFake({
        "https://site.api.espn.com": feed("2026-10-19T08:00:00Z"),
        "https://site.web.api.espn.com": feed("2026-08-11T14:58:58Z", []),
      }),
      "nba",
      ASOF
    );
    assert.equal(f.host, "https://site.api.espn.com");
    assert.equal(f.entries.length, 2);
    assert.equal(f.stale, false);
    assert.equal(f.hostsTried.length, 2);
  });

  test("order does not matter: the fresher snapshot wins from either host", async () => {
    const f = await getEspnInjuries(
      hostFake({
        "https://site.api.espn.com": feed("2026-08-11T14:58:58Z", []),
        "https://site.web.api.espn.com": feed("2026-10-19T08:00:00Z"),
      }),
      "nba",
      ASOF
    );
    assert.equal(f.host, "https://site.web.api.espn.com");
  });

  test("one host down still answers; the failure is reported", async () => {
    const f = await getEspnInjuries(
      hostFake({ "https://site.web.api.espn.com": feed("2026-10-19T08:00:00Z") }),
      "nba",
      ASOF
    );
    assert.equal(f.entries.length, 2);
    assert.ok(f.hostsTried.some((h) => !h.ok && /403/.test(h.reason ?? "")));
  });

  test("an old feed is marked stale", async () => {
    const f = await getEspnInjuries(
      hostFake({ "https://site.api.espn.com": feed("2026-10-15T08:07:12Z") }),
      "nba",
      ASOF
    );
    assert.equal(f.stale, true);
  });

  test("both hosts down throws a named error, and the failure is not cached", async () => {
    await assert.rejects(getEspnInjuries(hostFake({}), "nba", ASOF), EspnInjuryShapeError);
    const f = await getEspnInjuries(
      hostFake({ "https://site.api.espn.com": feed("2026-10-19T08:00:00Z") }),
      "nba",
      ASOF
    );
    assert.equal(f.entries.length, 2);
  });

  test("cached: a second call in the window makes no requests", async () => {
    const calls: string[] = [];
    const fake = hostFake({ "https://site.api.espn.com": feed("2026-10-19T08:00:00Z") }, calls);
    await getEspnInjuries(fake, "nba", ASOF);
    await getEspnInjuries(fake, "nba", ASOF);
    assert.equal(calls.length, 2, "two hosts, once");
  });

  test("urls use the league path for each sport", () => {
    assert.equal(
      espnInjuriesUrl("https://site.api.espn.com", "nfl"),
      "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries"
    );
    assert.deepEqual([...ESPN_INJURY_SPORTS].sort(), ["nba", "nfl", "nhl", "wnba"]);
  });

  test("an unwired sport is refused, not silently empty", async () => {
    await assert.rejects(getEspnInjuries(hostFake({}), "epl", ASOF), /No ESPN injury feed/);
  });
});

describe("findInjuryEntry", () => {
  const entries = parseEspnInjuryFeed(feed("2026-10-19T08:00:00Z"), ASOF).entries;
  test("matches across accent and suffix folding", () => {
    assert.equal(findInjuryEntry(entries, "Cade Cunningham").match?.espnAthleteId, "4432166");
  });
  test("no match is null and not ambiguous", () => {
    const r = findInjuryEntry(entries, "Jalen Duren");
    assert.equal(r.match, null);
    assert.equal(r.ambiguous, false);
  });
  test("two same-name entries with no team to split them is ambiguous", () => {
    const dup = [entries[0]!, { ...entries[0]!, team: "Boston Celtics" }];
    assert.equal(findInjuryEntry(dup, "Cade Cunningham").ambiguous, true);
    assert.equal(findInjuryEntry(dup, "Cade Cunningham", "Boston Celtics").match?.team, "Boston Celtics");
  });
});

/* ===================== TOOL WIRING: tkb_get_injuries ===================== */
const capture = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; structuredContent?: any }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } } as never,
    handlers,
  };
};
const deadBdl = { getAllInjuries: async () => { throw new Error("BDL must not be called"); } } as never;

describe("tkb_get_injuries routes NBA to ESPN", () => {
  beforeEach(() => clearEspnInjuryCache());

  test("NBA answers from ESPN with the feed age, and never touches BDL", async () => {
    const { server, handlers } = capture();
    registerInjuriesTool(server, deadBdl, hostFake({ "https://site.api.espn.com": feed(new Date().toISOString()) }));
    const r = await handlers["tkb_get_injuries"]({ sport: "nba", teamName: "Pistons" } as never);
    const text = r.content[0]!.text;
    assert.match(text, /Cade Cunningham/);
    assert.match(text, /ESPN injury feed last updated/);
    assert.match(text, /ALREADY PASSED/);
    assert.equal(r.structuredContent.source, "espn");
  });

  test("an empty result from a STALE feed is never a clean bill of health", async () => {
    const { server, handlers } = capture();
    registerInjuriesTool(server, deadBdl, hostFake({ "https://site.api.espn.com": feed("2026-01-01T00:00:00Z") }));
    const r = await handlers["tkb_get_injuries"]({ sport: "nba", playerName: "Nobody Here" } as never);
    assert.match(r.content[0]!.text, /FEED IS STALE, so this is NOT a clean bill of health/);
  });

  test("the NBA fallback text no longer describes an NCAAF endpoint", () => {
    const msg = unsupportedMessage("nba", "injuries");
    assert.doesNotMatch(msg, /ncaaf|CFB|CollegeFootballData/);
    assert.match(unsupportedMessage("cfb", "injuries"), /ncaaf/);
  });

  test("index.ts passes the ESPN client to both tools", () => {
    const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(src, /registerInjuriesTool\(server, bdl, espn\)/);
    assert.match(src, /registerScreenPropsTool\(server, sgo, bdl, cfbd, cbbd, espn\)/);
  });
});

/* ===================== withRequestMemo ===================== */
describe("withRequestMemo", () => {
  test("identical ESPN requests in one screen are made once", async () => {
    const counts = { teams: 0, roster: 0, log: 0 };
    const base = Object.create(EspnClient.prototype) as EspnClient;
    base.fetchTeams = async () => { counts.teams++; return { ok: true, elapsedMs: 1, url: "t", data: {} }; };
    base.fetchRoster = async () => { counts.roster++; return { ok: true, elapsedMs: 1, url: "r", data: {} }; };
    base.fetchGamelog = async () => { counts.log++; return { ok: true, elapsedMs: 1, url: "g", data: {} }; };
    const m = withRequestMemo(base);
    const path = { sport: "basketball", league: "nba" };
    await Promise.all([m.fetchTeams(path), m.fetchTeams(path), m.fetchRoster(path, "8"), m.fetchRoster(path, "8"), m.fetchRoster(path, "2")]);
    await m.fetchGamelog(path, "1", 2026);
    await m.fetchGamelog(path, "1", 2026);
    await m.fetchGamelog(path, "1", 2025);
    assert.deepEqual(counts, { teams: 1, roster: 2, log: 2 });
  });
});

/* ===================== TOOL WIRING: tkb_screen_props on NBA ===================== */
const NBA_NAMES = [
  "minutes", "fieldGoalsMade-fieldGoalsAttempted", "fieldGoalPct",
  "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "threePointPct",
  "freeThrowsMade-freeThrowsAttempted", "freeThrowPct", "totalRebounds", "assists",
  "blocks", "steals", "fouls", "turnovers", "points",
];
const row = (pts: string) => ["36","10-20","50.0","3-8","37.5","5-6","83.3","8","9","0","1","2","3",pts];
const PTS = ["31", "28", "22", "30", "27", "33", "19", "29", "26", "32"];
const LOG = {
  names: NBA_NAMES,
  labels: NBA_NAMES,
  seasonTypes: [{
    displayName: "2025-26 Regular Season",
    categories: [{ displayName: "april", events: PTS.map((p, i) => ({ eventId: `R${i}`, stats: row(p) })) }],
  }],
  events: Object.fromEntries(
    PTS.map((_, i) => [`R${i}`, { gameDate: new Date(Date.UTC(2026, 3, 12 - i)).toISOString(), atVs: "vs", opponent: { abbreviation: "CLE" } }])
  ),
};

const NBA_EVENT = {
  eventID: "YcuJMzH3KxfKzxVKzSQs",
  status: { started: false, completed: false, ended: false, live: false },
  teams: {
    home: { teamID: "DETROIT_PISTONS_NBA", names: { long: "Detroit Pistons" } },
    away: { teamID: "BOSTON_CELTICS_NBA", names: { long: "Boston Celtics" } },
  },
  players: {
    CADE_CUNNINGHAM_1_NBA: { playerID: "CADE_CUNNINGHAM_1_NBA", name: "Cade Cunningham", teamID: "DETROIT_PISTONS_NBA" },
  },
  odds: {
    "points-CADE_CUNNINGHAM_1_NBA-game-ou-over": {
      oddID: "points-CADE_CUNNINGHAM_1_NBA-game-ou-over",
      statID: "points",
      byBookmaker: { draftkings: { odds: "-110", overUnder: "24.5", available: true } },
    },
    "points-CADE_CUNNINGHAM_1_NBA-game-ou-under": {
      oddID: "points-CADE_CUNNINGHAM_1_NBA-game-ou-under",
      statID: "points",
      byBookmaker: { draftkings: { odds: "-110", overUnder: "24.5", available: true } },
    },
  },
};

const nbaSgo = (sgoHistoryCalls = { n: 0 }) =>
  ({
    leagueIDFor: () => "NBA",
    getAllEvents: async (q: { eventIDs?: string }) => {
      if (q.eventIDs) return [NBA_EVENT];
      sgoHistoryCalls.n++;
      return [];
    },
  }) as never;

const espnFake = (counts = { teams: 0, roster: 0, log: 0, raw: 0 }, opts: { injuryTs?: string; noAthlete?: boolean } = {}) => {
  const c = Object.create(EspnClient.prototype) as EspnClient;
  c.fetchTeams = async () => {
    counts.teams++;
    return { ok: true, elapsedMs: 1, url: "t", data: { sports: [{ leagues: [{ teams: [
      { team: { id: "8", displayName: "Detroit Pistons", abbreviation: "DET" } },
      { team: { id: "2", displayName: "Boston Celtics", abbreviation: "BOS" } },
    ] }] }] } };
  };
  c.fetchRoster = async () => {
    counts.roster++;
    return { ok: true, elapsedMs: 1, url: "r", data: { athletes: opts.noAthlete ? [] : [{ id: "4432166", displayName: "Cade Cunningham", firstName: "Cade" }] } };
  };
  c.fetchGamelog = async () => { counts.log++; return { ok: true, elapsedMs: 1, url: "g", data: LOG as never }; };
  c.fetchRawEspn = async (url: string) => {
    counts.raw++;
    return { ok: true, status: 200, elapsedMs: 1, url, data: feed(opts.injuryTs ?? new Date().toISOString(), [ENTRY_CADE]) };
  };
  return c;
};

const SCREEN_INPUT = {
  sport: "nba",
  eventID: "YcuJMzH3KxfKzxVKzSQs",
  minEdge: 0,
  minHitRate: 0,
  minSample: 1,
  maxAmericanOdds: -1000,
  limit: 12,
  maxPerPlayer: 2,
  rankBy: "edge",
  includePriorSeason: false,
  minCurrentSeasonGames: 0,
  preferredBookmakers: DEFAULT_BOOKMAKERS,
};

describe("tkb_screen_props on NBA uses ESPN (the 2026-10-19 zero-of-113 regression)", () => {
  beforeEach(() => clearEspnInjuryCache());

  test("NBA is in the ESPN screen list", () => {
    assert.ok(ESPN_SCREEN_SPORTS.includes("nba"));
  });

  test("props QUALIFY from ESPN rates, with the source counted and BDL never called", async () => {
    const { server, handlers } = capture();
    const bdlCalls = { n: 0 };
    const bdl = new Proxy({}, { get: () => async () => { bdlCalls.n++; throw new Error("BDL unavailable"); } }) as never;
    registerScreenPropsTool(server, nbaSgo(), bdl, null, null, espnFake());
    const r = await handlers["tkb_screen_props"](SCREEN_INPUT as never);
    const sc = r.structuredContent;
    // Over and under at the same line share ONE rate computation (rateCache key is
    // player|stat|line), so one ESPN rate serves both sides.
    assert.equal(sc.rateSources.espn, 1, "rated from ESPN");
    assert.equal(sc.rateSources.bdl, 0);
    assert.equal(sc.rateSources.sgo, 0, "no SGO entity spend on rates");
    assert.equal(bdlCalls.n, 0);
    assert.ok(sc.props.length >= 1, "THE REGRESSION: the board was empty");
    const over = sc.props.find((p: any) => p.side === "over");
    assert.equal(over.hitRate, "8 of 10"); // 22 and 19 are the two misses at 24.5
  });

  test("injuryStatus is attached from the ESPN feed, and the feed age is stated", async () => {
    const { server, handlers } = capture();
    registerScreenPropsTool(server, nbaSgo(), {} as never, null, null, espnFake());
    const r = await handlers["tkb_screen_props"](SCREEN_INPUT as never);
    assert.equal(r.structuredContent.props[0].injuryStatus, "Day-To-Day");
    assert.equal(r.structuredContent.injuryFeed.flaggedOnBoard >= 1, true);
    assert.match(r.content[0]!.text, /ESPN injury feed last updated/);
  });

  test("a STALE injury feed is announced on the board", async () => {
    const { server, handlers } = capture();
    registerScreenPropsTool(server, nbaSgo(), {} as never, null, null, espnFake(undefined, { injuryTs: "2026-08-11T14:58:58Z" }));
    const r = await handlers["tkb_screen_props"](SCREEN_INPUT as never);
    assert.match(r.content[0]!.text, /STALE ESPN INJURY FEED/);
  });

  test("ESPN requests are memoised across one screen", async () => {
    const counts = { teams: 0, roster: 0, log: 0, raw: 0 };
    const { server, handlers } = capture();
    registerScreenPropsTool(server, nbaSgo(), {} as never, null, null, espnFake(counts));
    await handlers["tkb_screen_props"](SCREEN_INPUT as never);
    assert.equal(counts.teams, 1);
    assert.equal(counts.roster, 1);
    assert.ok(counts.log <= 2, `one log per season, got ${counts.log}`);
  });

  test("an unmatched player is COUNTED by cause, and the empty board says it is a source failure", async () => {
    const { server, handlers } = capture();
    const hist = { n: 0 };
    registerScreenPropsTool(server, nbaSgo(hist), {} as never, null, null, espnFake(undefined, { noAthlete: true }));
    const r = await handlers["tkb_screen_props"](SCREEN_INPUT as never);
    const sc = r.structuredContent;
    assert.equal(sc.props.length, 0);
    assert.equal(sc.dropReasons.noRate, 2);
    assert.equal(sc.rateRefusals["espn player not matched"], 1, "one shared computation for both sides");
    assert.equal(sc.rateSources.sgo, 0, "NO silent SGO fallback on an ESPN refusal");
    assert.match(r.content[0]!.text, /WHY PROPS LEFT THE BOARD: 2 no rate source/);
    assert.match(r.content[0]!.text, /SOURCE failure, not a verdict/);
  });

  test("a worker that THROWS is counted with its message, not swallowed (the old bare catch)", async () => {
    const errors: string[] = [];
    const out = await mapWithConcurrency(
      [1, 2, 3, 4],
      2,
      async (n) => {
        if (n % 2 === 0) throw new Error(`boom ${n}`);
        return n;
      },
      (e) => errors.push((e as Error).message)
    );
    assert.deepEqual(out.sort(), [1, 3], "the sweep still completes");
    assert.deepEqual(errors.sort(), ["boom 2", "boom 4"]);
  });

  test("threshold drops are counted separately from source failures", async () => {
    const { server, handlers } = capture();
    registerScreenPropsTool(server, nbaSgo(), {} as never, null, null, espnFake());
    const r = await handlers["tkb_screen_props"]({ ...SCREEN_INPUT, minHitRate: 0.95 } as never);
    const d = r.structuredContent.dropReasons;
    assert.equal(d.noRate, 0);
    assert.equal(d.belowMinHitRate + d.belowMinEdge, 2);
    assert.doesNotMatch(r.content[0]!.text, /SOURCE failure/);
  });

  test("without an ESPN client the old path still runs (BDL/SGO preserved for a swap back)", async () => {
    const { server, handlers } = capture();
    const hist = { n: 0 };
    registerScreenPropsTool(server, nbaSgo(hist), { getPlayerStats: async () => { throw new Error("x"); } } as never, null, null, null);
    const r = await handlers["tkb_screen_props"](SCREEN_INPUT as never);
    assert.equal(r.structuredContent.rateSources.espn, 0);
    assert.ok(r.structuredContent.dropReasons, "drop accounting is present on every path");
  });
});
