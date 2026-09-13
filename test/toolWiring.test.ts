import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { registerOddsTool } from "../src/tools/odds.js";
import { registerLineMovementTool } from "../src/tools/lineMovement.js";
import { registerGradePicksTool } from "../src/tools/gradePicks.js";
import { registerBatchGradeTool } from "../src/tools/gradeSlate.js";
import { DEFAULT_BOOKMAKERS } from "../src/constants.js";

/**
 * TOOL WIRING, NOT TOOL LOGIC.
 *
 * ============================================================================
 * WHY THIS FILE HAD TO EXIST
 * ============================================================================
 *
 * v2.8.9 added `diagnosePlayerIdMiss` with nine passing unit tests, wired it into
 * four tools, and shipped. Three of the four worked. In `odds.ts` the call was
 * placed as the else-branch of `unpricedReasons.length`, and that branch never
 * runs on the case it was built for: a missing market populates one unpricedReason
 * PER SIDE, so the list is always non-empty and the diagnosis was unreachable.
 *
 * It was verified dead against the live build, on the exact Caleb Williams lookup
 * the release existed to answer. Every unit test still passed, because the pure
 * function was fine. The wiring was not, and nothing in the suite could see it.
 *
 * That is the same failure the repo has recorded in a different costume: v2.6.1
 * ("a cost change that alters which data comes back is a correctness change and
 * needs a test"), v2.8.4 ("none ship here, since searchPlayers needs an HTTP
 * client"). The gap was always "logic that needs a client cannot be asserted", and
 * the answer has been to extract the pure part and leave the wiring untested.
 *
 * EXTRACTING THE PURE PART IS NOT ENOUGH. A perfect function called in an
 * unreachable branch produces exactly the bug it was written to prevent.
 *
 * ============================================================================
 * THE PATTERN
 * ============================================================================
 *
 * A tool's `register*` function takes an McpServer and a client. Both are just
 * objects. Pass a fake server that captures the handler, a fake client that
 * returns a fixed event, then call the handler and assert on what a caller would
 * actually receive. No network, no SDK, no mocking framework.
 *
 * This costs almost nothing and covers the seam every previous release left bare.
 */

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

// The real Bears @ Panthers roster, 2026-09-13. SGO carries Caleb Williams under
// CHRIS_WILLIAMS_1_NFL: right display name, wrong ID stem, line posted at 229.5.
const EVENT = {
  eventID: "Nw0i5lD1IafZ0HlX842y",
  status: { displayShort: "F", started: true, completed: true, ended: true, live: false },
  teams: {
    home: { teamID: "CAROLINA_PANTHERS_NFL", names: { long: "Carolina Panthers" }, score: 17 },
    away: { teamID: "CHICAGO_BEARS_NFL", names: { long: "Chicago Bears" }, score: 24 },
  },
  players: {
    CHRIS_WILLIAMS_1_NFL: {
      playerID: "CHRIS_WILLIAMS_1_NFL",
      name: "Caleb Williams",
      teamID: "CHICAGO_BEARS_NFL",
    },
  },
  odds: {
    "passing_yards-CHRIS_WILLIAMS_1_NFL-game-ou-over": {
      oddID: "passing_yards-CHRIS_WILLIAMS_1_NFL-game-ou-over",
      statID: "passing_yards",
      score: 241,
      byBookmaker: { draftkings: { odds: "-112", overUnder: "229.5", available: true } },
    },
  },
};

const fakeSgo = {
  leagueIDFor: () => "NFL",
  getAllEvents: async () => [EVENT],
  getEvents: async () => ({ data: [EVENT] }),
} as never;

const WRONG_ID = "CALEB_WILLIAMS_1_NFL";

/**
 * Calling a handler directly bypasses Zod, so schema defaults are NOT applied.
 * Supplying them here is deliberate rather than a workaround: it keeps the test
 * honest about which values the tool actually depends on, and a default that
 * silently disappears in this harness would be a default the tool should not be
 * relying on so deeply. preferredBookmakers is the one that bites - odds.ts and
 * lineMovement.ts both call .trim() on it unconditionally.
 */
const SCHEMA_DEFAULTS = { preferredBookmakers: DEFAULT_BOOKMAKERS };

describe("a wrong playerID is diagnosed by EVERY tool that can miss on one", () => {
  test("tkb_get_odds names the real ID - THE REGRESSION, it was unreachable in v2.8.9", () => {
    const { server, handlers } = captureServer();
    registerOddsTool(server as never, fakeSgo);
    return handlers["tkb_get_odds"]({
      sport: "nfl",
      eventID: "E",
      marketType: "player_prop",
      playerID: WRONG_ID,
      marketLabel: "Passing Yards",
      ...SCHEMA_DEFAULTS,
    } as never).then((r) => {
      const text = r.content[0].text;
      assert.match(text, /CHRIS_WILLIAMS_1_NFL/, "must name the real playerID");
      assert.match(text, /Caleb Williams/, "must name the display name");
      assert.match(text, /WRONG ID/);
    });
  });

  test("tkb_get_line_movement names the real ID", () => {
    const { server, handlers } = captureServer();
    registerLineMovementTool(server as never, fakeSgo);
    return handlers["tkb_get_line_movement"]({
      sport: "nfl",
      eventID: "E",
      marketType: "player_prop",
      playerID: WRONG_ID,
      marketLabel: "Passing Yards",
      side: "over",
      ...SCHEMA_DEFAULTS,
    } as never).then((r) => {
      assert.match(r.content[0].text, /CHRIS_WILLIAMS_1_NFL/);
    });
  });

  test("tkb_grade_pick names the real ID", () => {
    const { server, handlers } = captureServer();
    registerGradePicksTool(server as never, fakeSgo);
    return handlers["tkb_grade_pick"]({
      sport: "nfl",
      eventID: "E",
      marketType: "player_prop",
      side: "over",
      playerID: WRONG_ID,
      marketLabel: "Passing Yards",
      postedLine: 229.5,
    } as never).then((r) => {
      assert.match(r.content[0].text, /CHRIS_WILLIAMS_1_NFL/);
    });
  });

  test("tkb_grade_slate names the real ID", () => {
    const { server, handlers } = captureServer();
    registerBatchGradeTool(server as never, fakeSgo);
    return handlers["tkb_grade_slate"]({
      sport: "nfl",
      picks: [
        {
          ref: "wrong id",
          eventID: "E",
          marketType: "player_prop",
          side: "over",
          playerID: WRONG_ID,
          marketLabel: "Passing Yards",
          postedLine: 229.5,
        },
      ],
    } as never).then((r) => {
      assert.match(r.content[0].text, /CHRIS_WILLIAMS_1_NFL/);
    });
  });
});

describe("the control: a CORRECT playerID is untouched by the diagnosis path", () => {
  test("tkb_get_odds still returns the real line", () => {
    // The failure mode of an over-eager diagnosis is intercepting successful
    // lookups, which would block every prop pull rather than one.
    const { server, handlers } = captureServer();
    registerOddsTool(server as never, fakeSgo);
    return handlers["tkb_get_odds"]({
      sport: "nfl",
      eventID: "E",
      marketType: "player_prop",
      playerID: "CHRIS_WILLIAMS_1_NFL",
      marketLabel: "Passing Yards",
      ...SCHEMA_DEFAULTS,
    } as never).then((r) => {
      const text = r.content[0].text;
      assert.match(text, /229\.5/, "the real line must still come back");
      assert.doesNotMatch(text, /WRONG ID/, "a successful lookup must not be diagnosed");
      assert.doesNotMatch(text, /NO USABLE ODDS/);
    });
  });
});

// ===========================================================================
// FULL SWEEP: every registered tool, called through its own Zod schema.
// ===========================================================================
//
// The four tests above cover one behaviour across four handlers. This covers
// EVERY handler once, against the invariant that matters most and that nothing
// else in the suite checks:
//
//   NO TOOL MAY EVER SURFACE AN INTERNAL CRASH TO ITS CALLER.
//
// A handler that throws returns something like
// "Error fetching odds: Cannot read properties of undefined (reading 'trim')".
// That is not an answer, it is a stack trace wearing a sentence, and this
// connector's whole design premise is that an unanswerable question gets a
// refusal rather than a plausible-looking wrong answer. A TypeError is neither.
//
// INPUTS GO THROUGH THE REAL SCHEMA. Each tool's own inputSchema.parse() runs
// first, so Zod defaults are applied exactly as they are in production. That is
// deliberate: the v2.8.10 harness supplied defaults by hand and would not have
// caught a default that was removed or renamed. Parsing also asserts that the
// example input is one a caller could actually send.

import { z } from "zod";
import { registerScheduleTool } from "../src/tools/schedule.js";
import { registerHitRateTool } from "../src/tools/hitRate.js";
import { registerInjuriesTool } from "../src/tools/injuries.js";
import { registerSplitsTool } from "../src/tools/splits.js";
import { registerYesNoPropsTool } from "../src/tools/yesNoProps.js";
import { registerPeriodOddsTool } from "../src/tools/periodOdds.js";
import { registerWeatherTool } from "../src/tools/weather.js";
import { registerPlayersTool } from "../src/tools/players.js";
import { registerUsageTool } from "../src/tools/usage.js";
import { registerScreenPropsTool } from "../src/tools/screenProps.js";
import { registerCoverPlayerTool } from "../src/tools/coverPlayer.js";
import { registerTweetCharsTool } from "../src/tools/tweetChars.js";
import { registerBdlStatsProbeTool } from "../src/tools/bdlStatsProbe.js";
import { registerStreakScanTool } from "../src/tools/streakScan.js";
import { registerLiveMonitorTool } from "../src/tools/liveMonitor.js";
import { registerPropBoardTool } from "../src/tools/propBoard.js";
import { registerGameLinesTool } from "../src/tools/gameLines.js";
import { registerRankingsTool } from "../src/tools/rankings.js";
import { registerStandingsTool } from "../src/tools/standings.js";
import { registerEventProbeTool } from "../src/tools/eventProbe.js";
import { registerCfbdStatsProbeTool } from "../src/tools/cfbdStatsProbe.js";
import { registerMlbMatchupTool } from "../src/tools/mlbMatchup.js";
import { registerVerifyRosterTool } from "../src/tools/verifyRoster.js";

/** Signature of an internal crash leaking out as an "answer". */
const CRASH = /Cannot read propert|is not a function|undefined is not|TypeError|ReferenceError|\[object Object\]|undefined\)/;

const SGO = {
  leagueIDFor: (s: string) => s.toUpperCase(),
  getEvents: async () => ({ data: [EVENT], nextCursor: undefined }),
  getAllEvents: async () => [EVENT],
  getPlayers: async () => ({ data: Object.values(EVENT.players) }),
  getAllPlayers: async () => Object.values(EVENT.players),
  getUsage: async () => ({ rateLimits: {}, objects: {} }),
  getTeam: async () => null,
  getCacheStats: () => ({ hits: 0, misses: 0, coalesced: 0, upgrades: 0, entries: 0 }),
  lastFetchTruncated: false,
  liveEventsDropped: 0,
} as never;

const BDL = {
  getInjuries: async () => ({ data: [] }),
  getAllInjuries: async () => [],
  getStandings: async () => ({ data: [] }),
  getRankings: async () => ({ data: [] }),
  getConferences: async () => [],
  getConferenceStandings: async () => ({ data: [] }),
  getTeams: async () => ({ data: [] }),
  statsTierGated: () => false,
  getPlayerGameStats: async () => ({ data: [] }),
  getAllPlayerGameStats: async () => [],
  // Real shape: { data: [...], truncated? }. A fake that disagrees with the
  // real signature produces a false failure, which is its own kind of lie.
  searchPlayers: async () => ({ data: [], truncated: false }),
  getAllGames: async () => [],
  getGames: async () => ({ data: [] }),
  getRawPlayerGameStats: async () => ({ data: [] }),
  getRawInjuries: async () => ({ data: [] }),
} as never;

const CFBD = {
  getWeekPlayerStats: async () => ({ kind: "no_box_score", note: "test" }),
  getSeasonGames: async () => new Map(),
  getStats: () => ({ requests: 0, cachedWeeks: 0 }),
  seedWeek: () => undefined,
} as never;

const WEATHER = { getForecast: async () => [] } as never;
const MLB = {
  getScheduleForDate: async () => [],
  getPlayerIndex: async () => new Map(),
  getStats: () => ({ requests: 0, cachedDates: 0 }),
} as never;

/**
 * name -> [register call, example input]. The input is what a caller would
 * plausibly send; Zod fills the rest.
 */
const EVENT_ID = "Nw0i5lD1IafZ0HlX842y";
interface Clients { sgo: never; bdl: never; cfbd: never; weather: never; mlb: never }
const LIVE: Clients = { sgo: SGO, bdl: BDL, cfbd: CFBD, weather: WEATHER, mlb: MLB };

const SWEEP: [string, (s: never, c: Clients) => void, Record<string, unknown>][] = [
  ["tkb_get_schedule", (s, c) => registerScheduleTool(s, c.sgo), { sport: "nfl" }],
  ["tkb_get_odds", (s, c) => registerOddsTool(s, c.sgo), { sport: "nfl", eventID: EVENT_ID, marketType: "moneyline" }],
  ["tkb_get_player_hit_rate", (s, c) => registerHitRateTool(s, c.sgo, c.bdl, c.cfbd), { sport: "mlb", playerID: "X_1_MLB", playerName: "Test Player", teamID: "T_MLB", statID: "batting_hits", line: 0.5, direction: "over" }],
  ["tkb_get_injuries", (s, c) => registerInjuriesTool(s, c.bdl), { sport: "mlb" }],
  ["tkb_get_team_split", (s, c) => registerSplitsTool(s, c.sgo, c.bdl), { sport: "mlb", teamID: "T_MLB", teamName: "Baltimore Orioles", splitType: "home" }],
  ["tkb_get_yes_no_prop", (s, c) => registerYesNoPropsTool(s, c.sgo), { sport: "mlb", eventID: EVENT_ID, marketLabel: "Any Home Runs", playerID: "X_1_MLB" }],
  ["tkb_get_period_odds", (s, c) => registerPeriodOddsTool(s, c.sgo), { sport: "nfl", eventID: EVENT_ID, period: "1st_half", betType: "moneyline", side: "home" }],
  ["tkb_get_game_weather", (s, c) => registerWeatherTool(s, c.weather), { sport: "nfl", teamID: "CHICAGO_BEARS_NFL" }],
  ["tkb_get_players", (s, c) => registerPlayersTool(s, c.sgo), { sport: "nfl", eventID: EVENT_ID }],
  ["tkb_get_api_usage", (s, c) => registerUsageTool(s, c.sgo, c.cfbd), {}],
  ["tkb_screen_props", (s, c) => registerScreenPropsTool(s, c.sgo, c.bdl, c.cfbd), { sport: "nfl", eventID: EVENT_ID }],
  ["tkb_get_cover_player", (s, c) => registerCoverPlayerTool(s, c.sgo, c.bdl), { sport: "nfl", eventID: EVENT_ID }],
  ["tkb_count_tweet_chars", (s, _c) => registerTweetCharsTool(s), { posts: ["hello world"] }],
  ["tkb_debug_bdl_stats", (s, c) => registerBdlStatsProbeTool(s, c.bdl), { sport: "mlb", playerName: "Marte" }],
  ["tkb_scan_streaks", (s, c) => registerStreakScanTool(s, c.bdl), { sport: "mlb", playerNames: ["Marte"], statID: "batting_hits" }],
  ["tkb_monitor_live_picks", (s, c) => registerLiveMonitorTool(s, c.sgo), { sport: "mlb", picks: [{ ref: "r", eventID: EVENT_ID, marketType: "total", side: "over", line: 8.5 }] }],
  ["tkb_get_prop_board", (s, c) => registerPropBoardTool(s, c.sgo), { sport: "nfl", eventID: EVENT_ID }],
  ["tkb_get_game_lines", (s, c) => registerGameLinesTool(s, c.sgo), { sport: "nfl" }],
  ["tkb_get_rankings", (s, c) => registerRankingsTool(s, c.bdl), { sport: "cfb" }],
  ["tkb_get_standings", (s, c) => registerStandingsTool(s, c.bdl), { sport: "mlb" }],
  ["tkb_probe_event_fields", (s, c) => registerEventProbeTool(s, c.sgo), { sport: "nfl", eventID: EVENT_ID }],
  ["tkb_debug_cfbd_stats", (s, c) => registerCfbdStatsProbeTool(s, c.cfbd), { year: 2026, week: 2 }],
  ["tkb_get_mlb_matchup", (s, c) => registerMlbMatchupTool(s, c.mlb), { date: "2026-09-13" }],
  ["tkb_verify_roster", (s, c) => registerVerifyRosterTool(s, c.bdl), { sport: "cfb", playerName: "Cobb", expectedTeam: "Auburn" }],
  ["tkb_grade_pick", (s, c) => registerGradePicksTool(s, c.sgo), { sport: "nfl", eventID: EVENT_ID, marketType: "moneyline", side: "home" }],
  ["tkb_grade_slate", (s, c) => registerBatchGradeTool(s, c.sgo), { sport: "nfl", picks: [{ ref: "r", eventID: EVENT_ID, marketType: "moneyline", side: "home" }] }],
  ["tkb_get_line_movement", (s, c) => registerLineMovementTool(s, c.sgo), { sport: "nfl", eventID: EVENT_ID, marketType: "total", side: "over" }],
];

/**
 * Register one tool with a given client bundle, parse the example input through
 * the tool's OWN schema, run the handler, and return what a caller would see.
 */
async function runTool(
  name: string,
  reg: (s: never, c: Clients) => void,
  input: Record<string, unknown>,
  clients: Clients
): Promise<string> {
  const defs: Record<string, { inputSchema?: unknown }> = {};
  const handlers: Record<string, (p: unknown) => Promise<{ content: { text: string }[] }>> = {};
  reg(
    {
      registerTool: (n: string, d: unknown, h: unknown) => {
        defs[n] = d as { inputSchema?: unknown };
        handlers[n] = h as never;
      },
    } as never,
    clients
  );
  assert.ok(handlers[name], `${name} was not registered`);

  const raw = defs[name]?.inputSchema as { parse?: (v: unknown) => unknown } | undefined;
  const schema = raw && typeof raw.parse === "function" ? raw : z.object(raw as never);
  let parsed: unknown;
  try {
    parsed = schema.parse(input);
  } catch (e) {
    assert.fail(`${name}: example input is not valid for its own schema: ${String(e)}`);
  }

  const res = await handlers[name](parsed);
  assert.ok(res && Array.isArray(res.content) && res.content.length, `${name} returned no content`);
  const text = res.content.map((c) => c.text ?? "").join("\n");

  // A BLANK ANSWER IS ITS OWN FAILURE, and it belongs here rather than in one
  // sweep. Found by mutating a tool to return an empty string: the outage sweep
  // caught it and the other two did not, so an empty happy-path response would
  // have shipped. An empty message reads as "nothing to report" when it may mean
  // "this code path returns nothing", which is the same ambiguity the connector
  // spends its empty-result branches trying to remove.
  assert.ok(text.trim().length > 0, `${name} returned an EMPTY message`);
  return text;
}

describe("SWEEP 1 - every tool answers on the happy path", () => {
  for (const [name, reg, input] of SWEEP) {
    test(`${name} returns an answer, not a stack trace`, async () => {
      const text = await runTool(name, reg, input, LIVE);
      assert.doesNotMatch(text, CRASH, `${name} leaked an internal error:\n${text.slice(0, 400)}`);
    });
  }
});

/**
 * SWEEP 2 - EVERY UPSTREAM CALL THROWS.
 *
 * The condition that actually happens in production and that no other test in
 * this suite covers: SGO 502s, BALLDONTLIE rate-limits, CFBD times out, Render
 * cold-starts mid-request. This connector's own notes record a CFBD 502 on two
 * consecutive calls and a BDL 429 storm that pushed 217 of 235 rates onto the
 * expensive path.
 *
 * A tool that lets that propagate hands the reader a stack trace where a refusal
 * belongs. Every one of them must catch it and say something.
 */
const THROWING = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === "leagueIDFor") return (x: string) => String(x).toUpperCase();
      if (prop === "statsTierGated") return () => false;
      if (prop === "getCacheStats") return () => ({ hits: 0, misses: 0, coalesced: 0, upgrades: 0, entries: 0 });
      if (prop === "getStats") return () => ({ requests: 0, cachedWeeks: 0, cachedDates: 0 });
      if (prop === "lastFetchTruncated" || prop === "liveEventsDropped") return 0;
      if (prop === "seedWeek") return () => undefined;
      return async () => {
        throw new Error("upstream 502: simulated provider outage");
      };
    },
  }
) as never;

const ALL_THROWING: Clients = { sgo: THROWING, bdl: THROWING, cfbd: THROWING, weather: THROWING, mlb: THROWING };

describe("SWEEP 2 - every tool survives a provider outage", () => {
  for (const [name, reg, input] of SWEEP) {
    test(`${name} catches an upstream throw`, async () => {
      const text = await runTool(name, reg, input, ALL_THROWING);
      assert.doesNotMatch(text, CRASH, `${name} leaked an internal error on outage:\n${text.slice(0, 400)}`);
    });
  }
});

/**
 * SWEEP 3 - THE PROVIDER ANSWERS, WITH NOTHING IN IT.
 *
 * Distinct from an outage and far more common: an event that exists but carries
 * no odds because props are not posted yet, an empty roster, a standings call
 * that returns zero rows. This connector's stated design rule is that an empty
 * result must say WHICH KIND of empty it is rather than reading as a failure,
 * and the only way that rule holds is if the empty path runs at all.
 */
const BARE_EVENT = {
  eventID: EVENT_ID,
  status: { displayShort: "F", completed: true, ended: true, live: false },
  teams: { home: { teamID: "H" }, away: { teamID: "A" } },
  players: {},
  odds: {},
};

const EMPTY: Clients = {
  sgo: {
    ...(SGO as object),
    getAllEvents: async () => [BARE_EVENT],
    getEvents: async () => ({ data: [BARE_EVENT] }),
    getPlayers: async () => ({ data: [] }),
    getAllPlayers: async () => [],
  } as never,
  bdl: BDL,
  cfbd: CFBD,
  weather: WEATHER,
  mlb: MLB,
};

describe("SWEEP 3 - every tool survives an event with no odds and no players", () => {
  for (const [name, reg, input] of SWEEP) {
    test(`${name} handles an empty event`, async () => {
      const text = await runTool(name, reg, input, EMPTY);
      assert.doesNotMatch(text, CRASH, `${name} leaked an internal error on an empty event:\n${text.slice(0, 400)}`);
    });
  }
});
