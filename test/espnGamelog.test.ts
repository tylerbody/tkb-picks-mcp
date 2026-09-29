import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  flattenGamelog,
  parseStatValue,
  detectPairedColumns,
  extractRoster,
  ESPN_LEAGUE_PATHS,
  ESPN_STATS_PATH,
  EspnClient,
  type EspnGamelog,
} from "../src/services/espnClient.js";

/**
 * ESPN game log, v2.12.0 probe.
 *
 * EVERY FIXTURE HERE IS REAL. The rows are A'ja Wilson's 2025 log, espnId 3149391, read
 * from the raw JSON on 2026-09-29. Hand-built fixtures are what let the v2.10.5 bug ship,
 * so the shapes below are copied rather than invented.
 */

const LABELS = ["MIN","PTS","REB","AST","STL","BLK","TO","FG","FG%","3PT","3P%","FT","FT%","PF"];
const NAMES = [
  "minutes","points","totalRebounds","assists","steals","blocks","turnovers",
  "fieldGoalsMade-fieldGoalsAttempted","fieldGoalPct",
  "threePointFieldGoalsMade-threePointFieldGoalsAttempted","threePointPct",
  "freeThrowsMade-freeThrowsAttempted","freeThrowPct","fouls",
];

// Verbatim from the live response.
const POST_GAME = { eventId: "401820329", stats: ["36","31","9","4","2","3","2","7-21","33.3","0-2","0.0","17-19","89.5","3"] };
const REG_SEPT  = { eventId: "401736397", stats: ["33","23","19","4","2","4","1","9-17","52.9","3-3","100.0","2-2","100.0","1"] };
const REG_AUG   = { eventId: "401736390", stats: ["25","11","5","4","1","3","1","3-7","42.9","1-1","100.0","4-4","100.0","0"] };

/** The real structure: regular season split into one category PER MONTH. */
const LOG: EspnGamelog = {
  labels: LABELS,
  names: NAMES,
  seasonTypes: [
    { displayName: "2025 Postseason", categories: [{ displayName: "Postseason", type: "event", events: [POST_GAME] }] },
    {
      displayName: "2025 Regular Season",
      categories: [
        { displayName: "september", type: "event", events: [REG_SEPT] },
        { displayName: "august", type: "event", events: [REG_AUG] },
      ],
    },
    { displayName: "2025 Preseason", categories: [{ displayName: "Preseason", type: "event", events: [
      { eventId: "401700001", stats: ["12","4","3","1","0","0","1","2-5","40.0","0-1","0.0","0-0","0.0","2"] },
    ] }] },
  ],
  events: { "401820329": {}, "401736397": {}, "401736390": {}, "401700001": {} },
};

describe("v2.12.0 the stats path is the one that was measured", () => {
  test("the documented path constant matches where the parser actually looks", () => {
    assert.equal(ESPN_STATS_PATH, "seasonTypes[].categories[].events[].stats");
    assert.ok(flattenGamelog(LOG).games.length > 0);
  });

  /* THE MONTH TRAP. `categories[0].events` on the regular season is ONE MONTH. A rate
   * computed that way looks like a season and is not. */
  test("EVERY month category is walked, not just the first", () => {
    const flat = flattenGamelog(LOG);
    const reg = flat.games.filter((g) => /Regular/i.test(g.seasonType));
    assert.equal(reg.length, 2, "both month categories must be flattened");
    assert.deepEqual(reg.map((g) => g.category).sort(), ["august", "september"]);
  });

  test("the month split is REPORTED, so it cannot be silently misread", () => {
    const flat = flattenGamelog(LOG);
    assert.deepEqual(flat.structure["2025 Regular Season"], { september: 1, august: 1 });
  });

  test("preseason is excluded by default and included only on request", () => {
    assert.equal(flattenGamelog(LOG).games.length, 3);
    assert.equal(flattenGamelog(LOG, { includePreseason: true }).games.length, 4);
    // And it is still reported in the structure either way, so it is never invisible.
    assert.deepEqual(flattenGamelog(LOG).structure["2025 Preseason"], { Preseason: 1 });
  });

  test("a row whose length disagrees with labels is dropped AND named", () => {
    const broken: EspnGamelog = {
      ...LOG,
      seasonTypes: [
        { displayName: "2025 Regular Season", categories: [{ displayName: "may", events: [
          REG_SEPT,
          { eventId: "SHORT", stats: ["20", "10"] },
        ] }] },
      ],
    };
    const flat = flattenGamelog(broken);
    assert.equal(flat.games.length, 1);
    assert.deepEqual(flat.lengthMismatches, [{ eventId: "SHORT", length: 2, expected: 14 }]);
  });

  test("a malformed row is skipped without throwing", () => {
    const junk: EspnGamelog = {
      labels: LABELS,
      seasonTypes: [{ displayName: "x", categories: [{ displayName: "y", events: [
        { eventId: 5 as unknown as string, stats: [] },
        { eventId: "ok", stats: "nope" as unknown as string[] },
      ] }] }],
    };
    assert.equal(flattenGamelog(junk).games.length, 0);
  });

  test("an empty log yields no games rather than an exception", () => {
    assert.deepEqual(flattenGamelog({}).games, []);
    assert.deepEqual(flattenGamelog({ seasonTypes: [] }).structure, {});
  });
});

describe("v2.12.0 made-attempted is one string, and that is the trap", () => {
  /* Index 9 is "0-2", not 0. Read as a number it is NaN; read as a made total without
   * splitting it is wrong. The percentages beside it ARE bare numbers, which makes them
   * the tempting shortcut, and they are rates rather than counts. */
  test("a made-attempted pair splits, and the COUNT is the made side", () => {
    const p = parseStatValue("7-21");
    assert.equal(p.form, "made-attempted");
    assert.equal(p.value, 7);
    assert.equal(p.made, 7);
    assert.equal(p.attempted, 21);
  });

  test("three pointers made on a real row is 0, not NaN and not 2", () => {
    const p = parseStatValue(POST_GAME.stats[9]);
    assert.equal(POST_GAME.stats[9], "0-2");
    assert.equal(p.value, 0);
    assert.equal(p.attempted, 2);
  });

  test("a plain number still parses as a number", () => {
    assert.deepEqual(parseStatValue("36"), { value: 36, form: "number" });
    assert.equal(parseStatValue("89.5").value, 89.5);
  });

  test("absent and unparsable are DIFFERENT outcomes, never both zero", () => {
    assert.equal(parseStatValue(undefined).form, "absent");
    assert.equal(parseStatValue("").form, "absent");
    assert.equal(parseStatValue("--").form, "absent");
    assert.equal(parseStatValue("DNP").form, "unparsable");
    // Crucially neither invents a 0.
    assert.equal(parseStatValue("--").value, null);
    assert.equal(parseStatValue("DNP").value, null);
  });

  test("the paired columns are detected from real rows, not assumed", () => {
    const flat = flattenGamelog(LOG);
    const paired = detectPairedColumns(LABELS, flat.games);
    assert.deepEqual(paired, [7, 9, 11]);
    assert.deepEqual(paired.map((i) => LABELS[i]), ["FG", "3PT", "FT"]);
  });

  test("a 0-0 free throw line is a real pair, not an absence", () => {
    const p = parseStatValue("0-0");
    assert.equal(p.form, "made-attempted");
    assert.equal(p.value, 0);
    assert.equal(p.attempted, 0);
  });
});

describe("v2.12.0 league paths and URLs", () => {
  const espn = new EspnClient();
  test("wnba and nhl are the two verified paths and they differ in sport", () => {
    assert.deepEqual(ESPN_LEAGUE_PATHS.wnba, { sport: "basketball", league: "wnba" });
    assert.deepEqual(ESPN_LEAGUE_PATHS.nhl, { sport: "hockey", league: "nhl" });
  });

  test("the gamelog URL matches the one verified by hand", () => {
    assert.equal(
      espn.gamelogUrl(ESPN_LEAGUE_PATHS.wnba, "3149391", 2025),
      "https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/3149391/gamelog?season=2025"
    );
    assert.equal(
      espn.gamelogUrl(ESPN_LEAGUE_PATHS.wnba, "3149391"),
      "https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes/3149391/gamelog"
    );
  });

  test("roster and teams URLs use the OTHER host, which is easy to get wrong", () => {
    assert.match(espn.teamsUrl(ESPN_LEAGUE_PATHS.wnba), /^https:\/\/site\.api\.espn\.com\//);
    assert.equal(
      espn.rosterUrl(ESPN_LEAGUE_PATHS.wnba, "17"),
      "https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams/17/roster"
    );
    // The gamelog host is site.web.api, the roster host is site.api. Not the same.
    assert.match(espn.gamelogUrl(ESPN_LEAGUE_PATHS.wnba, "1"), /^https:\/\/site\.web\.api\.espn\.com\//);
  });

  test("an id with unsafe characters is encoded, not interpolated raw", () => {
    assert.match(espn.gamelogUrl(ESPN_LEAGUE_PATHS.wnba, "a b/c"), /a%20b%2Fc/);
  });
});

describe("v2.12.0 roster extraction, the ID-mapping half", () => {
  // Shaped like ESPN's real roster response: athletes nested under groups.
  const ROSTER = {
    athletes: [
      { position: "guard", items: [
        { id: "3149391", displayName: "A'ja Wilson", firstName: "A'ja", jersey: "22" },
        { id: "4065870", displayName: "Jackie Young", firstName: "Jackie", jersey: "0" },
      ] },
    ],
    team: { id: "17", displayName: "Las Vegas Aces", abbreviation: "LV" },
  };

  test("athlete ids and names come out", () => {
    const r = extractRoster(ROSTER);
    assert.equal(r.length, 2);
    assert.deepEqual(r.find((a) => a.id === "3149391"), { id: "3149391", displayName: "A'ja Wilson" });
  });

  test("the TEAM is not mistaken for an athlete", () => {
    const r = extractRoster(ROSTER);
    assert.ok(!r.some((a) => a.displayName === "Las Vegas Aces"), "team leaked into the roster");
  });

  test("duplicates collapse by id", () => {
    const r = extractRoster({ a: ROSTER.athletes, b: ROSTER.athletes });
    assert.equal(r.length, 2);
  });

  test("junk input returns empty rather than throwing", () => {
    assert.deepEqual(extractRoster(null), []);
    assert.deepEqual(extractRoster("nope"), []);
    assert.deepEqual(extractRoster({}), []);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING. Pure parsers passing is not the tool working; that distinction is what
// toolWiring.test.ts documents and what v2.10.5 shipped a bug through.
// ---------------------------------------------------------------------------

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

const stubClient = (over: Partial<Record<string, unknown>> = {}) => ({
  gamelogUrl: () => "https://gamelog.test",
  teamsUrl: () => "https://teams.test",
  rosterUrl: () => "https://roster.test",
  fetchGamelog: async () => ({ ok: true, status: 200, elapsedMs: 42, url: "https://gamelog.test", data: LOG }),
  fetchTeams: async () => ({ ok: true, status: 200, elapsedMs: 9, url: "https://teams.test", data: {} }),
  fetchRoster: async () => ({ ok: true, status: 200, elapsedMs: 11, url: "https://roster.test", data: {
    athletes: [{ items: [{ id: "3149391", displayName: "A'ja Wilson", firstName: "A'ja", jersey: "22" }] }],
  } }),
  ...over,
} as never);

const callProbe = async (input: Record<string, unknown>, client = stubClient()) => {
  const { registerEspnProbeTool } = await import("../src/tools/espnProbe.js");
  const { server, handlers } = captureServer();
  registerEspnProbeTool(server as never, client);
  return handlers["tkb_probe_espn_gamelog"](input as never);
};

describe("v2.12.0 the probe reports the shape it found", () => {
  test("a healthy gamelog reports the path holding, with counts", async () => {
    const res = await callProbe({ league: "wnba", espnId: "3149391" });
    const sc = res.structuredContent!;
    assert.equal(sc.reachable, true);
    assert.equal(sc.statsPathHolds, true);
    assert.equal(sc.gameRowsUsable, 3);
    assert.equal(sc.gameRowsIncludingPreseason, 4);
    assert.equal(sc.columnCount, 14);
    assert.match(String(sc.verdict), /SHAPE HOLDS/);
  });

  test("the month split reaches the caller", async () => {
    const res = await callProbe({ league: "wnba", espnId: "3149391" });
    const struct = res.structuredContent!.seasonStructure as Record<string, Record<string, number>>;
    assert.deepEqual(struct["2025 Regular Season"], { september: 1, august: 1 });
    assert.match(res.content[0].text, /split BY MONTH/);
  });

  test("paired columns are named in the payload, not just counted", async () => {
    const res = await callProbe({ league: "wnba", espnId: "3149391" });
    assert.deepEqual(res.structuredContent!.pairedColumnIndexes, [7, 9, 11]);
    assert.deepEqual(res.structuredContent!.pairedColumnLabels, ["FG", "3PT", "FT"]);
  });

  test("sample rows are label-mapped with the parsed value beside the raw", async () => {
    const res = await callProbe({ league: "wnba", espnId: "3149391", sampleRows: 1 });
    const rows = res.structuredContent!.sampleRows as {
      mapped: { index: number; label: string; raw: string; value: number | null; form: string; made?: number }[];
    }[];
    assert.equal(rows.length, 1);
    const threes = rows[0].mapped[9];
    assert.equal(threes.label, "3PT");
    assert.equal(threes.raw, "0-2");
    assert.equal(threes.value, 0);
    assert.equal(threes.form, "made-attempted");
    assert.equal(threes.made, 0);
  });

  /* THE VERDICT MUST FLIP. A 200 with no usable rows is the shape having changed, and
   * that must NOT read as success just because the HTTP call worked. */
  test("HTTP 200 with an empty log says SHAPE CHANGED, not success", async () => {
    const res = await callProbe({ league: "wnba", espnId: "1" }, stubClient({
      fetchGamelog: async () => ({ ok: true, status: 200, elapsedMs: 5, url: "u", data: { labels: LABELS, seasonTypes: [] } }),
    }));
    assert.equal(res.structuredContent!.reachable, true);
    assert.equal(res.structuredContent!.statsPathHolds, false);
    assert.match(String(res.structuredContent!.verdict), /SHAPE CHANGED OR EMPTY/);
    assert.match(res.content[0].text, /Do NOT build against this/);
  });

  /* EGRESS IS THE POINT OF THE PROBE. A network failure must be named as a network
   * failure, because "no data" would send someone looking at ESPN instead of at Render. */
  test("an egress failure is named as one and blames the network, not the data", async () => {
    const res = await callProbe({ league: "wnba", espnId: "1" }, stubClient({
      fetchGamelog: async () => ({ ok: false, elapsedMs: 3, url: "u", reason: "Could not reach ESPN from this server: getaddrinfo ENOTFOUND site.web.api.espn.com. This is a NETWORK/EGRESS failure, not a data problem. The host may be blocked outbound from Render." }),
    }));
    assert.equal(res.structuredContent!.reachable, false);
    assert.match(res.content[0].text, /EGRESS/);
    assert.match(res.content[0].text, /blocked on Render's outbound network/);
    // And it must refuse to say anything about the shape.
    assert.equal(res.structuredContent!.statsPathHolds, undefined);
  });

  test("an HTTP error carries the status rather than swallowing it", async () => {
    const res = await callProbe({ league: "wnba", espnId: "404" }, stubClient({
      fetchGamelog: async () => ({ ok: false, status: 404, elapsedMs: 7, url: "u", reason: "ESPN returned HTTP 404." }),
    }));
    assert.equal(res.structuredContent!.status, 404);
    assert.equal(res.structuredContent!.reachable, false);
  });

  test("roster mode returns athlete ids and says name matching is the real work", async () => {
    const res = await callProbe({ league: "wnba", teamEspnId: "17" });
    assert.equal(res.structuredContent!.mode, "roster");
    assert.equal(res.structuredContent!.athleteCount, 1);
    assert.match(res.content[0].text, /refuse an uncertain match/);
  });

  test("no ids at all falls back to the teams listing", async () => {
    const res = await callProbe({ league: "wnba" });
    assert.equal(res.structuredContent!.mode, "teams");
    assert.equal(res.structuredContent!.reachable, true);
  });

  /* v2.11.1 lesson, applied on the first release of a new tool rather than after a live
   * failure: a stale client schema sends strings, and a direct handler call skips zod. */
  test("string-spelled params work through the handler", async () => {
    const res = await callProbe({
      league: "wnba",
      espnId: "3149391",
      season: "2025",
      includePreseason: "true",
      sampleRows: "1",
    });
    assert.equal(res.structuredContent!.gameRowsUsable, 4, "includePreseason=\"true\" must be honoured");
    assert.equal(res.structuredContent!.preseasonIncluded, true);
    assert.equal((res.structuredContent!.sampleRows as unknown[]).length, 1);
  });

  test("and \"false\" is not read as truthy", async () => {
    const res = await callProbe({ league: "wnba", espnId: "3149391", includePreseason: "false" });
    assert.equal(res.structuredContent!.preseasonIncluded, false);
    assert.equal(res.structuredContent!.gameRowsUsable, 3);
  });

  test("the payload says out loud that it is diagnostic only", async () => {
    const res = await callProbe({ league: "wnba", espnId: "3149391" });
    assert.match(res.content[0].text, /DIAGNOSTIC ONLY/);
    assert.match(String(res.structuredContent!.caveat), /Undocumented endpoint/);
  });

  test("events metadata and stat rows are reconciled", async () => {
    const res = await callProbe({ league: "wnba", espnId: "3149391" });
    assert.equal(res.structuredContent!.eventsMetaCount, 4);
    assert.equal(res.structuredContent!.gameRowsIncludingPreseason, 4);
    assert.equal(res.structuredContent!.reconciles, true);
  });
});

// ---------------------------------------------------------------------------
// v2.12.1: what the FIRST LIVE PROBE found.
//
// 1. Render gets 200 from site.web.api.espn.com and 403 from site.api.espn.com, which is
//    where teams and rosters live. A browser gets 200 from both. The id-mapping path is
//    blocked at the host level from the server, which is exactly what the probe was for.
// 2. Hockey TOI/G is "20:14" and PROD is "0:00". Correctly refused by the first cut, and
//    now parsed, because a Time On Ice prop is quoted in minutes.
// ---------------------------------------------------------------------------

describe("v2.12.1 mm:ss durations", () => {
  test("hockey TOI parses to minutes as a decimal, keeping the seconds", async () => {
    const { parseStatValue } = await import("../src/services/espnClient.js");
    const p = parseStatValue("20:14");
    assert.equal(p.form, "duration");
    assert.equal(p.minutes, 20);
    assert.equal(p.seconds, 1214);
    assert.ok(Math.abs(p.value! - 20.2333) < 0.001, `got ${p.value}`);
  });

  /* THE UNIT MATTERS. A Time On Ice line of 19.5 means 19:30, so 19:45 is OVER and 19:20
   * is UNDER. Truncating to whole minutes would grade both as 19. */
  test("a line of 19.5 separates 19:45 from 19:20, which whole minutes would not", async () => {
    const { parseStatValue } = await import("../src/services/espnClient.js");
    assert.ok(parseStatValue("19:45").value! > 19.5);
    assert.ok(parseStatValue("19:20").value! < 19.5);
    assert.equal(parseStatValue("19:45").minutes, parseStatValue("19:20").minutes);
  });

  test("zero duration is a real zero, not an absence", async () => {
    const { parseStatValue } = await import("../src/services/espnClient.js");
    const p = parseStatValue("0:00");
    assert.equal(p.form, "duration");
    assert.equal(p.value, 0);
    assert.equal(p.seconds, 0);
  });

  /* A COLON IS NOT A DASH. "20:14" must never be read as made-attempted, and a dash pair
   * must never be read as a duration. */
  test("durations and made-attempted pairs do not collide", async () => {
    const { parseStatValue } = await import("../src/services/espnClient.js");
    assert.equal(parseStatValue("20:14").form, "duration");
    assert.equal(parseStatValue("7-21").form, "made-attempted");
    // Nonsense minute/second values are refused rather than coerced.
    assert.equal(parseStatValue("20:99").form, "unparsable");
    assert.equal(parseStatValue("20:1").form, "unparsable");
  });

  test("duration columns are detected and reported apart from paired ones", async () => {
    const { detectDurationColumns, detectPairedColumns, detectUnparsableColumns } =
      await import("../src/services/espnClient.js");
    const NHL_LABELS = ["G","A","PTS","+/-","PIM","S","SPCT","PPG","PPA","SHG","SHA","GWG","TOI/G","PROD"];
    // Verbatim from the live NHL probe, eventId 401874176.
    const rows = [{ eventId: "401874176", seasonType: "r", category: "c",
      stats: ["0","0","0","1","0","1","0.0","0","0","0","0","0","20:14","0:00"] }];
    assert.deepEqual(detectDurationColumns(NHL_LABELS, rows), [12, 13]);
    assert.deepEqual(detectPairedColumns(NHL_LABELS, rows), []);
    assert.deepEqual(detectUnparsableColumns(NHL_LABELS, rows), []);
  });
});

describe("v2.12.1 the raw host probe is restricted", () => {
  const client = new EspnClient();

  test("a non-espn host is refused, and says why", async () => {
    const r = await client.fetchRawEspn("https://example.com/whatever");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /only fetches espn\.com hosts/);
  });

  /* A hostname that merely ENDS in the string is not a subdomain. notespn.com and
   * espn.com.evil.test must both be refused. */
  test("a lookalike hostname does not pass", async () => {
    for (const url of [
      "https://notespn.com/x",
      "https://espn.com.evil.test/x",
      "https://myespn.com/x",
    ]) {
      const r = await client.fetchRawEspn(url);
      assert.equal(r.ok, false, url);
      assert.match(r.reason!, /only fetches espn\.com hosts/, url);
    }
  });

  test("http is refused even on an espn host", async () => {
    const r = await client.fetchRawEspn("http://site.api.espn.com/x");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /only https/);
  });

  test("garbage is refused without throwing", async () => {
    const r = await client.fetchRawEspn("not a url");
    assert.equal(r.ok, false);
    assert.match(r.reason!, /Not a valid URL/);
  });

  test("the raw mode is reported as its own mode through the handler", async () => {
    const res = await callProbe({ league: "wnba", rawUrl: "https://site.api.espn.com/x" }, stubClient({
      fetchRawEspn: async () => ({ ok: false, status: 403, elapsedMs: 40, url: "https://site.api.espn.com/x", reason: "ESPN returned HTTP 403." }),
    }));
    assert.equal(res.structuredContent!.mode, "rawUrl");
    assert.equal(res.structuredContent!.status, 403);
    assert.equal(res.structuredContent!.reachable, false);
    assert.match(res.content[0].text, /NOT REACHABLE/);
  });

  test("rawUrl takes precedence over the other modes, so it is unambiguous", async () => {
    const res = await callProbe({ league: "wnba", espnId: "3149391", rawUrl: "https://site.web.api.espn.com/ok" }, stubClient({
      fetchRawEspn: async () => ({ ok: true, status: 200, elapsedMs: 12, url: "https://site.web.api.espn.com/ok", data: { a: 1, b: 2 } }),
    }));
    assert.equal(res.structuredContent!.mode, "rawUrl");
    assert.deepEqual(res.structuredContent!.topLevelKeys, ["a", "b"]);
  });
});
