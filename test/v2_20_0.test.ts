import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  parseEspnStandings,
  parseEspnStandingEntry,
  findEspnStandingRow,
  clearEspnStandingsCache,
  ESPN_STANDINGS_SPORTS,
} from "../src/services/espnStandings.js";
import { parseCfbdRecords, matchesConference } from "../src/services/cfbdRecords.js";
import { parseEspnApPoll } from "../src/services/espnRankings.js";
import { buildRosterIndex, checkAgainstIndex, clearEspnRosterCache } from "../src/services/espnRosterIndex.js";
import { getEspnInjuries, clearEspnInjuryCache, newestEntryDate } from "../src/services/espnInjuries.js";
import { resolveStatID } from "../src/services/statAliases.js";
import { compactRow } from "../src/tools/propBoard.js";
import { registerStandingsTool } from "../src/tools/standings.js";
import { registerRankingsTool } from "../src/tools/rankings.js";
import { registerVerifyRosterTool } from "../src/tools/verifyRoster.js";
import { registerInjuriesTool } from "../src/tools/injuries.js";
import { registerScreenSlateTool } from "../src/tools/screenSlate.js";
import { createUnavailableBDLClient } from "../src/services/bdlUnavailable.js";
import { EspnClient } from "../src/services/espnClient.js";

/**
 * v2.20.0: replace what BALLDONTLIE (cancelled) still did, plus the 2026-10-28 run
 * report: injury feed missing teams, verify_roster "rate limits", dead standings,
 * oversized prop boards, one-game-at-a-time screening, and "receptions" refused.
 * Fixtures below are built from ESPN payloads read verbatim on 2026-10-28.
 */

const capture = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; structuredContent?: any; isError?: boolean }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } } as never,
    handlers,
  };
};
const BDL_OFF = createUnavailableBDLClient();

/* ---------------- standings ---------------- */
const rec = (id: string, name: string, type: string, summary: string) => ({ id, name, type, summary, displayValue: summary });
const st = (name: string, value: number, displayValue = String(value)) => ({ name, type: name.toLowerCase(), value, displayValue });

const HEAT = {
  team: { id: "14", location: "Miami", name: "Heat", abbreviation: "MIA", displayName: "Miami Heat" },
  stats: [
    st("avgPointsAgainst", 121.75, "121.8"), st("avgPointsFor", 109.0), st("differential", -12.8),
    st("gamesBehind", 3.5), st("losses", 4), st("playoffSeed", 15), st("pointDifferential", -51),
    st("points", -2.0), st("pointsAgainst", 487), st("pointsFor", 436), st("streak", -4, "L4"),
    st("winPercent", 0), st("wins", 0),
    rec("0", "overall", "total", "0-4"), rec("33", "Home", "home", "0-3"), rec("34", "Road", "road", "0-1"),
    rec("60", "vs. Div.", "vsdiv", "0-1"), rec("61", "vs. Conf.", "vsconf", "0-2"), rec("901", "Last Ten Games", "lasttengames", "0-4"),
  ],
};
const PISTONS = {
  team: { id: "8", location: "Detroit", name: "Pistons", abbreviation: "DET", displayName: "Detroit Pistons" },
  stats: [st("wins", 3), st("losses", 0), st("streak", 3, "W3"), rec("0", "overall", "total", "3-0"), rec("33", "Home", "home", "2-0"), rec("34", "Road", "road", "1-0")],
};
const NBA_STANDINGS = {
  name: "National Basketball Association",
  children: [
    { name: "Eastern Conference", standings: { season: 2027, seasonDisplayName: "2026-27", entries: [HEAT, PISTONS] } },
    { name: "Western Conference", standings: { season: 2027, entries: [{ team: { id: "12", displayName: "LA Clippers", abbreviation: "LAC", name: "Clippers" }, stats: [rec("0", "overall", "total", "2-2")] }] } },
  ],
};
const HURRICANES = {
  team: { id: "7", location: "Carolina", name: "Hurricanes", abbreviation: "CAR", displayName: "Carolina Hurricanes" },
  stats: [st("otLosses", 2), st("losses", 2), st("wins", 9), st("points", 20), st("gamesPlayed", 13), st("pointDifferential", 18, "+18"),
    rec("0", "overall", "total", "9-2-2"), rec("2", "Home", "home", "2-1-1"), rec("3", "Road", "road", "7-1-1"), rec("5", "Last Ten Games", "lasttengames", "8-1-1")],
};

describe("ESPN standings parser", () => {
  test("reads records by TYPE and numbers by NAME (Miami Heat, verbatim shape)", () => {
    const { rows, seasonLabel } = parseEspnStandings(NBA_STANDINGS, "nba");
    const heat = rows.find((r) => r.abbreviation === "MIA")!;
    assert.equal(heat.overallRecord, "0-4");
    assert.equal(heat.homeRecord, "0-3");
    assert.equal(heat.roadRecord, "0-1");
    assert.equal(heat.homeLosses, 3);
    assert.equal(heat.lastTen, "0-4");
    assert.equal(heat.streak, -4);
    assert.equal(heat.streakDisplay, "L4");
    assert.equal(heat.pointDifferential, -51);
    assert.equal(heat.conference, "Eastern Conference");
    assert.equal(seasonLabel, "2026-27");
    assert.equal(rows.length, 3);
  });

  test("NBA 'points' (-2.0) is NEVER read as standings points; NHL points are", () => {
    const heat = parseEspnStandingEntry(HEAT, null, 2027, "nba")!;
    assert.equal(heat.standingsPoints, null);
    const car = parseEspnStandingEntry(HURRICANES, null, 2027, "nhl")!;
    assert.equal(car.standingsPoints, 20);
    assert.equal(car.overtimeLosses, 2);
    assert.equal(car.overallRecord, "9-2-2");
    assert.equal(car.homeWins, 2);
  });

  test("college record types (homerecord/awayrecord) are read too", () => {
    const row = parseEspnStandingEntry(
      { team: { id: "1", displayName: "X U" }, stats: [rec("0", "overall", "total", "5-1"), rec("2", "Home", "homerecord", "3-0"), rec("3", "Away", "awayrecord", "2-1")] },
      null, 2026
    )!;
    assert.equal(row.homeRecord, "3-0");
    assert.equal(row.roadRecord, "2-1");
  });

  test("an unknown shape refuses instead of returning an empty table", () => {
    assert.throws(() => parseEspnStandings({ teams: [] }), /children/);
    assert.throws(() => parseEspnStandings({ children: [{ name: "x" }] }), /zero team rows/);
  });

  test("team lookup: exact, nickname, 'Los Angeles Clippers' -> 'LA Clippers', ambiguity refuses", () => {
    const { rows } = parseEspnStandings(NBA_STANDINGS, "nba");
    assert.equal(findEspnStandingRow(rows, "Detroit Pistons")?.abbreviation, "DET");
    assert.equal(findEspnStandingRow(rows, "Heat")?.abbreviation, "MIA");
    assert.equal(findEspnStandingRow(rows, "Clippers")?.abbreviation, "LAC");
    assert.equal(findEspnStandingRow(rows, "Nowhere FC"), undefined);
  });

  test("pro leagues covered", () => {
    assert.deepEqual([...ESPN_STANDINGS_SPORTS].sort(), ["mlb", "nba", "nfl", "nhl", "wnba"]);
  });
});

const rawFake = (byUrlPart: Record<string, unknown>, calls: string[] = []) => {
  const c = Object.create(EspnClient.prototype) as EspnClient;
  c.fetchRawEspn = async (url: string) => {
    calls.push(url);
    const key = Object.keys(byUrlPart).find((k) => url.includes(k));
    return key
      ? { ok: true, status: 200, elapsedMs: 1, url, data: byUrlPart[key] }
      : { ok: false, status: 404, elapsedMs: 1, url, reason: "ESPN returned HTTP 404." };
  };
  return c;
};

describe("tkb_get_standings is BDL-free", () => {
  beforeEach(() => clearEspnStandingsCache());

  test("NBA comes from ESPN and names its source", async () => {
    const { server, handlers } = capture();
    registerStandingsTool(server, BDL_OFF, rawFake({ "basketball/nba/standings": NBA_STANDINGS }), null);
    const r = await handlers["tkb_get_standings"]({ sport: "nba", teamName: "Pistons" } as never);
    assert.match(r.content[0]!.text, /Source: ESPN standings/);
    assert.equal(r.structuredContent.count, 1);
    assert.equal(r.structuredContent.standings[0].overallRecord, "3-0");
  });

  test("CFB comes from CollegeFootballData, filtered by conference, FBS only, unreadable rows dropped", async () => {
    const cfbd = {
      getTeamRecords: async () => [
        { year: 2026, team: "Indiana", conference: "Big Ten", classification: "fbs", total: { games: 8, wins: 7, losses: 1, ties: 0 }, homeGames: { wins: 4, losses: 0 }, awayGames: { wins: 3, losses: 1 }, conferenceGames: { wins: 5, losses: 1 } },
        { year: 2026, team: "Miami", conference: "ACC", classification: "fbs", total: { games: 7, wins: 7, losses: 0 } },
        { year: 2026, team: "Garbage", conference: "Big Ten" },
        // An FCS row tagged with the same conference string must not leak in.
        { year: 2026, team: "Some FCS", conference: "Big Ten", classification: "fcs", total: { wins: 1, losses: 6 } },
      ],
    } as never;
    const { server, handlers } = capture();
    registerStandingsTool(server, BDL_OFF, null, cfbd);
    const r = await handlers["tkb_get_standings"]({ sport: "cfb", conference: "Big Ten" } as never);
    assert.equal(r.structuredContent.count, 1);
    const iu = r.structuredContent.standings[0];
    assert.equal(iu.overallRecord, "7-1");
    assert.equal(iu.homeRecord, "4-0");
    assert.equal(iu.conferenceRecord, "5-1");
    assert.match(r.content[0]!.text, /CollegeFootballData/);
    assert.match(r.content[0]!.text, /1 CFBD row\(s\) had no readable record/);
  });

  test("CFB with neither conference nor team lists the conferences instead of a 130-team dump", async () => {
    const cfbd = { getTeamRecords: async () => [{ team: "A", conference: "SEC", total: { wins: 1, losses: 0 } }] } as never;
    const { server, handlers } = capture();
    registerStandingsTool(server, BDL_OFF, null, cfbd);
    const r = await handlers["tkb_get_standings"]({ sport: "cfb" } as never);
    assert.match(r.content[0]!.text, /Conferences in the data: SEC/);
  });

  test("conference matcher", () => {
    assert.ok(matchesConference("Big Ten", "big ten"));
    assert.ok(matchesConference("Big 12", "big12"));
    assert.ok(!matchesConference("SEC", "ACC"));
    assert.equal(parseCfbdRecords([{ team: "X", total: { wins: 2, losses: 1, ties: 1 } }], 2026).rows[0]!.overallRecord, "2-1-1");
  });
});

/* ---------------- rankings ---------------- */
const AP = {
  rankings: [
    { name: "Coaches Poll", type: "usa", ranks: [] },
    {
      name: "AP Top 25", type: "ap", occurrence: { value: "9" }, season: { year: 2026 }, lastUpdated: "2026-10-25T21:14Z",
      ranks: [
        { current: 2, previous: 3, points: 1681, firstPlaceVotes: 10, trend: "+1", recordSummary: "6-1", team: { location: "Ohio State", name: "Buckeyes", abbreviation: "OSU" } },
        { current: 1, previous: 1, points: 1735, firstPlaceVotes: 59, trend: "-", recordSummary: "7-0", team: { location: "Miami", name: "Hurricanes", abbreviation: "MIA" } },
        { current: 25, previous: 0, points: 40, firstPlaceVotes: 0, trend: "-", recordSummary: "6-2", team: { location: "Miami (OH)", name: "RedHawks" } },
      ],
    },
  ],
};

describe("tkb_get_rankings is BDL-free", () => {
  test("parser: AP found by type not position, school = location, previous 0 = NR", () => {
    const p = parseEspnApPoll(AP);
    assert.equal(p.week, 9);
    assert.equal(p.rows[0]!.team, "Miami");
    assert.equal(p.rows[0]!.record, "7-0");
    assert.equal(p.rows[2]!.team, "Miami (OH)");
    assert.equal(p.rows[2]!.trend, "NR");
    assert.throws(() => parseEspnApPoll({ rankings: [{ name: "Coaches", type: "usa", ranks: [] }] }), /No AP Top 25/);
  });

  test("tool: rankedTeams string comes from ESPN, with the source named", async () => {
    const { server, handlers } = capture();
    registerRankingsTool(server, BDL_OFF, rawFake({ "college-football/rankings": AP }));
    const r = await handlers["tkb_get_rankings"]({ sport: "cfb", top: 25 } as never);
    assert.equal(r.structuredContent.rankedTeams, "Miami,Ohio State,Miami (OH)");
    assert.match(r.content[0]!.text, /Source: ESPN AP Top 25/);
  });

  test("an older week asked for is answered with the current one AND says so", async () => {
    const { server, handlers } = capture();
    registerRankingsTool(server, BDL_OFF, rawFake({ "college-football/rankings": AP }));
    const r = await handlers["tkb_get_rankings"]({ sport: "cfb", top: 25, week: 6 } as never);
    assert.match(r.content[0]!.text, /week 6 was asked for, but ESPN serves only the CURRENT poll \(week 9\)/);
  });
});

/* ---------------- roster index ---------------- */
const rosterFake = (opts: { failTeam?: string } = {}, counts = { teams: 0, roster: 0 }) => {
  const c = Object.create(EspnClient.prototype) as EspnClient;
  c.fetchTeams = async () => {
    counts.teams++;
    return { ok: true, elapsedMs: 1, url: "t", data: { sports: [{ leagues: [{ teams: [
      { team: { id: "15", displayName: "Milwaukee Bucks", abbreviation: "MIL" } },
      { team: { id: "10", displayName: "Houston Rockets", abbreviation: "HOU" } },
      { team: { id: "12", displayName: "LA Clippers", abbreviation: "LAC" } },
    ] }] }] } };
  };
  c.fetchRoster = async (_p, id: string) => {
    counts.roster++;
    if (id === opts.failTeam) return { ok: false, status: 500, elapsedMs: 1, url: "r", reason: "ESPN returned HTTP 500." };
    const athletes: Record<string, { id: string; displayName: string; firstName: string }[]> = {
      "15": [{ id: "1", displayName: "Giannis Antetokounmpo", firstName: "Giannis" }],
      "10": [{ id: "2", displayName: "Kevin Durant", firstName: "Kevin" }],
      "12": [{ id: "3", displayName: "Kawhi Leonard", firstName: "Kawhi" }],
    };
    return { ok: true, elapsedMs: 1, url: "r", data: { athletes: athletes[id] ?? [] } };
  };
  return c;
};

describe("roster verification is BDL-free (ESPN league index)", () => {
  beforeEach(() => clearEspnRosterCache());

  test("CONFIRMED / MISMATCH / NAME_NOT_FOUND / TEAM_NOT_RESOLVED", async () => {
    const idx = await buildRosterIndex(rosterFake(), "nba");
    assert.equal(checkAgainstIndex(idx, "Kevin Durant", "Houston Rockets").verdict, "CONFIRMED");
    const mm = checkAgainstIndex(idx, "Kevin Durant", "Milwaukee Bucks");
    assert.equal(mm.verdict, "MISMATCH");
    assert.deepEqual(mm.foundOn.map((f) => f.team), ["Houston Rockets"]);
    assert.equal(checkAgainstIndex(idx, "Kawhi Leonard", "Los Angeles Clippers").verdict, "CONFIRMED");
    assert.equal(checkAgainstIndex(idx, "Nobody Atall", "Milwaukee Bucks").verdict, "NAME_NOT_FOUND");
    assert.equal(checkAgainstIndex(idx, "Kevin Durant", "Seattle SuperSonics").verdict, "TEAM_NOT_RESOLVED");
  });

  test("a failed roster makes absence INCONCLUSIVE, never NAME_NOT_FOUND", async () => {
    const idx = await buildRosterIndex(rosterFake({ failTeam: "10" }), "nba");
    const r = checkAgainstIndex(idx, "Kevin Durant", "Milwaukee Bucks");
    assert.equal(r.verdict, "INCONCLUSIVE");
    assert.match(r.note, /Houston Rockets/);
  });

  test("BATCH: 4 players, the index is built ONCE (the old 'rate limit' was BDL)", async () => {
    const counts = { teams: 0, roster: 0 };
    const { server, handlers } = capture();
    registerVerifyRosterTool(server, BDL_OFF, rosterFake({}, counts), null);
    const r = await handlers["tkb_verify_roster"]({
      sport: "nba",
      players: [
        { playerName: "Giannis Antetokounmpo", expectedTeam: "Milwaukee Bucks" },
        { playerName: "Kevin Durant", expectedTeam: "Milwaukee Bucks" },
        { playerName: "Kawhi Leonard", expectedTeam: "LA Clippers" },
        { playerName: "Kevin Durant", expectedTeam: "Houston Rockets" },
      ],
    } as never);
    assert.equal(counts.teams, 1);
    assert.equal(counts.roster, 3);
    assert.equal(r.structuredContent.verdictCounts.CONFIRMED, 3);
    assert.equal(r.structuredContent.verdictCounts.MISMATCH, 1);
    assert.match(r.content[0]!.text, /NEEDS ATTENTION:\n- MISMATCH/);
  });

  test("single-player calls keep the old shape (verdict at the top level)", async () => {
    const { server, handlers } = capture();
    registerVerifyRosterTool(server, BDL_OFF, rosterFake(), null);
    const r = await handlers["tkb_verify_roster"]({ sport: "nba", playerName: "Giannis Antetokounmpo", expectedTeam: "Milwaukee Bucks" } as never);
    assert.equal(r.structuredContent.verdict, "CONFIRMED");
    assert.match(r.structuredContent.source, /ESPN rosters/);
  });

  test("CFB uses CollegeFootballData player search", async () => {
    const cfbd = { searchPlayers: async () => [{ id: "9", name: "Bryson Washington", team: "Auburn" }] } as never;
    const { server, handlers } = capture();
    registerVerifyRosterTool(server, BDL_OFF, null, cfbd);
    const ok = await handlers["tkb_verify_roster"]({ sport: "cfb", playerName: "Bryson Washington", expectedTeam: "Auburn" } as never);
    assert.equal(ok.structuredContent.verdict, "CONFIRMED");
    const bad = await handlers["tkb_verify_roster"]({ sport: "cfb", playerName: "Bryson Washington", expectedTeam: "Baylor" } as never);
    assert.equal(bad.structuredContent.verdict, "MISMATCH");
  });
});

/* ---------------- injury coverage ---------------- */
const ENTRY = (name: string, teamId: string, team: string, date: string) => ({
  id: "1", status: "Out", date, shortComment: "x",
  athlete: { displayName: name, links: [{ href: `https://www.espn.com/nba/player/_/id/9${teamId}/x` }], team: { id: teamId, displayName: team, abbreviation: "X" } },
  type: { abbreviation: "O" },
});
const injuryClient = (perTeamCounts: Record<string, number | "fail">, entryDate: string) => {
  const c = rosterFake();
  c.fetchRawEspn = async (url: string) => {
    if (url.includes("/injuries?limit=")) {
      const id = /teams\/(\d+)\/injuries/.exec(url)![1]!;
      const n = perTeamCounts[id];
      return n === "fail" || n === undefined
        ? { ok: false, status: 500, elapsedMs: 1, url, reason: "ESPN returned HTTP 500." }
        : { ok: true, status: 200, elapsedMs: 1, url, data: { count: n, items: [] } };
    }
    return {
      ok: true, status: 200, elapsedMs: 1, url,
      data: { timestamp: new Date().toISOString(), injuries: [{ id: "10", displayName: "Houston Rockets", injuries: [ENTRY("Fred VanVleet", "10", "Houston Rockets", entryDate)] }] },
    };
  };
  return c;
};

describe("injury feed reports TEAM COVERAGE (the missing-Bucks problem)", () => {
  beforeEach(() => clearEspnInjuryCache());
  const recent = () => new Date(Date.now() - 2 * 3600_000).toISOString().slice(0, 16) + "Z";

  test("absent teams are checked per team: zero, missing-from-feed, unconfirmed", async () => {
    const f = await getEspnInjuries(injuryClient({ "15": 0, "12": 3 }, recent()), "nba");
    assert.equal(f.coverage!.leagueTeams, 3);
    assert.deepEqual(f.coverage!.teamsInFeed, ["Houston Rockets"]);
    const byTeam = Object.fromEntries(f.coverage!.notListed.map((n) => [n.team, n.status]));
    assert.equal(byTeam["Milwaukee Bucks"], "ESPN_LISTS_ZERO");
    assert.equal(byTeam["LA Clippers"], "MISSING_FROM_FEED");
  });

  test("tkb_get_injuries teamName=Bucks says ESPN CONFIRMS zero, not just 'nothing found'", async () => {
    const { server, handlers } = capture();
    registerInjuriesTool(server, BDL_OFF, injuryClient({ "15": 0, "12": 3 }, recent()));
    const r = await handlers["tkb_get_injuries"]({ sport: "nba", teamName: "Bucks" } as never);
    assert.match(r.content[0]!.text, /CONFIRMS Milwaukee Bucks has zero/);
    const c = await handlers["tkb_get_injuries"]({ sport: "nba", teamName: "Clippers" } as never);
    assert.match(c.content[0]!.text, /LEFT THIS TEAM OUT/);
  });

  test("an unconfirmed absent team is UNVERIFIED, never healthy", async () => {
    const { server, handlers } = capture();
    registerInjuriesTool(server, BDL_OFF, injuryClient({ "15": "fail", "12": 0 }, recent()));
    const r = await handlers["tkb_get_injuries"]({ sport: "nba", teamName: "Bucks" } as never);
    assert.match(r.content[0]!.text, /UNVERIFIED, not healthy/);
  });

  test("freshness comes from the newest ENTRY, so a fresh build timestamp cannot hide a dead feed", async () => {
    const f = await getEspnInjuries(injuryClient({}, "2026-09-01T00:00Z"), "nba");
    assert.equal(f.stale, true);
    assert.equal(newestEntryDate([]), null);
  });

  test("MLB injuries come from ESPN now", async () => {
    const { server, handlers } = capture();
    registerInjuriesTool(server, BDL_OFF, injuryClient({}, recent()));
    const r = await handlers["tkb_get_injuries"]({ sport: "mlb" } as never);
    assert.equal(r.structuredContent.source, "espn");
  });
});

/* ---------------- stat aliases ---------------- */
describe("statID aliases ('receptions' was refused)", () => {
  test("label, short form and camelCase resolve to the catalogued statID", () => {
    assert.equal(resolveStatID("nfl", "receptions").statID, "receiving_receptions");
    assert.equal(resolveStatID("nfl", "Receptions").statID, "receiving_receptions");
    assert.equal(resolveStatID("nfl", "receivingYards").statID, "receiving_yards");
    assert.equal(resolveStatID("nfl", "Rushing Yards").statID, "rushing_yards");
    assert.equal(resolveStatID("nfl", "receiving_receptions").aliasedFrom, null);
    assert.equal(resolveStatID("nfl", "receptions").aliasedFrom, "receptions");
    // LABEL-only match: the label has "RBIs", the statID tail has "rbi".
    assert.equal(resolveStatID("mlb", "Hits + Runs + RBIs").statID, "batting_hits+runs+rbi");
  });

  test("an ambiguous short form resolves NOTHING (never a silent wrong stat)", () => {
    const r = resolveStatID("nfl", "yards");
    assert.equal(r.statID, "yards");
    assert.equal(r.aliasedFrom, null);
    assert.ok(r.suggestions.length >= 2);
  });
});

/* ---------------- compact prop board ---------------- */
describe("compact prop board", () => {
  test("one line per market with best price and book count", () => {
    const c = compactRow({
      playerID: "P", playerName: "Cade Cunningham", team: "Detroit Pistons", market: "Points", statID: "points",
      line: 24.5, splitLine: false, splitLineNote: null, sidesPriced: 2,
      over: { line: 24.5, americanOdds: "-115", roundedOdds: "-120", bookmaker: "draftkings", bestPrice: { bookmaker: "fanduel", americanOdds: "-105" }, betterPriceAvailable: true, bookCount: 6 },
      under: { line: 24.5, americanOdds: "-105", roundedOdds: "-110", bookmaker: "draftkings", bookCount: 5 },
    });
    assert.equal(c.line, "Cade Cunningham (Detroit Pistons) | Points | 24.5 | O -115 draftkings (best -105 fanduel) | U -105 draftkings | 6 book(s)");
    assert.deepEqual(c.row.bestOver, { price: "-105", book: "fanduel" });
    assert.equal(c.row.bestUnder, null);
    assert.equal(c.row.bookCount, 6);
  });
});

/* ---------------- slate screen ---------------- */
describe("tkb_screen_slate", () => {
  beforeEach(() => clearEspnInjuryCache());

  test("screens every not-started game on a date, skips started ones, ranks one board", async () => {
    const mkEvent = (id: string, started: boolean) => ({
      eventID: id,
      status: { started, completed: false, startsAt: "2026-10-29T00:00:00.000Z" },
      teams: { home: { teamID: "DETROIT_PISTONS_NBA", names: { long: "Detroit Pistons" } }, away: { teamID: "BOSTON_CELTICS_NBA", names: { long: "Boston Celtics" } } },
      players: {},
      odds: {},
    });
    const calls: any[] = [];
    const sgo = {
      leagueIDFor: () => "NBA",
      getAllEvents: async (q: any) => {
        calls.push(q);
        if (q.eventIDs) return [mkEvent(q.eventIDs, false)];
        return [mkEvent("G1", false), mkEvent("G2", true), mkEvent("G3", false)];
      },
    } as never;
    const { server, handlers } = capture();
    registerScreenSlateTool(server, sgo, BDL_OFF, null, null, null);
    const r = await handlers["tkb_screen_slate"]({ sport: "nba", date: "2026-10-28", limit: 20, perGameLimit: 6, rankBy: "edge" } as never);
    const sc = r.structuredContent;
    assert.equal(sc.gamesFound, 3);
    assert.deepEqual(sc.skippedStarted, ["G2"]);
    assert.equal(sc.perGame.length, 2);
    // Empty rosters -> "no props posted", reported per game rather than silently.
    assert.ok(sc.perGame.every((g: any) => g.status === "no_props_posted"));
    assert.match(r.content[0]!.text, /NO PROPS POSTED YET/);
    assert.equal(calls[0].startsAfter, "2026-10-28T07:00:00.000Z", "date is the Pacific day");
  });
});
