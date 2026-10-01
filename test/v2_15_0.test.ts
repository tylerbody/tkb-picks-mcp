import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import { registerDebugEventTool } from "../src/tools/debugEvent.js";

/**
 * v2.15.0: tkb_debug_raw_event goes from written-but-unreachable to registered.
 *
 * WHY THIS FILE EXISTS RATHER THAN "it's just one line in index.ts".
 *
 * The tool was turned on to answer ONE question: the value of an event's top-level
 * `type` field, which blocks both the preseason hit-rate filter and tools/futures.ts.
 *
 * It could not have answered it. MEASURED 2026-10-01 before the fix: a realistic NFL
 * event (79 players, six result periods) serialized to 12,015 characters against a
 * 12,000-character cap, and SGO emits `type` as the LAST top-level key. The one field
 * the registration was for was the first thing truncation removed, and a truncated
 * dump still reads like a successful answer.
 *
 * That is this repo's recorded failure in a new costume: v2.8.9's unreachable
 * else-branch, and v2.14.0's mutation harness that forwarded no arguments and passed
 * six for six. Wiring something correct into a place where it cannot work produces
 * exactly the bug it was meant to prevent. So the assertion here is not "is the tool
 * registered" - it is "does the registered tool surface the field it was registered
 * for, on a payload the size of a real one".
 */

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; isError?: boolean }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

/* Shaped on the live preseason event ygBw5sEmEBR0sBPv7C4g (Panthers at Bills,
 * 15 Aug 2026), which tkb_probe_event_fields measured at 79 players and six result
 * periods, with top-level keys in this order - `type` last. That ORDER is the whole
 * point of the fixture; do not alphabetize it. */
const buildEvent = (overrides: Record<string, unknown> = {}) => {
  const players: Record<string, unknown> = {};
  for (let i = 0; i < 79; i++) {
    players[`PLAYER_${i}_NFL`] = {
      playerID: `PLAYER_${i}_NFL`,
      name: `Player Number ${i}`,
      teamID: i % 2 ? "BUFFALO_BILLS_NFL" : "CAROLINA_PANTHERS_NFL",
      firstName: "Player", lastName: `Number${i}`, nickname: null, position: "WR",
    };
  }
  const results: Record<string, unknown> = {};
  for (const period of ["game", "1q", "2q", "3q", "4q", "reg"]) {
    results[period] = { home: { points: 29, firstDowns: 20 }, away: { points: 14, firstDowns: 12 } };
  }
  return {
    eventID: "ygBw5sEmEBR0sBPv7C4g",
    info: { venue: { name: "Highmark Stadium", city: "Buffalo" }, seasonWeek: "Week 1" },
    leagueID: "NFL",
    links: { bookmakers: {} },
    odds: { "points-home-game-ml-home": { oddID: "points-home-game-ml-home" } },
    players,
    results,
    sportID: "FOOTBALL",
    status: { started: true, completed: true, ended: true, live: false, displayShort: "F", startsAt: "2026-08-15T17:00:00.000Z" },
    teams: { home: { teamID: "BUFFALO_BILLS_NFL" }, away: { teamID: "CAROLINA_PANTHERS_NFL" } },
    type: "match",
    ...overrides,
  };
};

const fakeSgoReturning = (event: unknown) =>
  ({ leagueIDFor: () => "NFL", getEvents: async () => ({ data: [event] }) }) as never;

const callTool = async (event: unknown) => {
  const { server, handlers } = captureServer();
  registerDebugEventTool(server as never, fakeSgoReturning(event));
  assert.ok(handlers["tkb_debug_raw_event"], "tkb_debug_raw_event was not registered");
  return handlers["tkb_debug_raw_event"]({ sport: "nfl", eventID: "x" } as never);
};

describe("v2.15.0 DEFECT: `type` was truncated off the raw dump", () => {
  test("the `type` VALUE survives a 79-player event", async () => {
    const text = (await callTool(buildEvent())).content[0].text;
    assert.ok(/"type":\s*"match"/.test(text), "the `type` value is absent from the output");
  });

  test("seasonWeek survives too - it is the field that FAILED to discriminate preseason", async () => {
    const text = (await callTool(buildEvent())).content[0].text;
    assert.ok(/"info\.seasonWeek":\s*"Week 1"/.test(text), "info.seasonWeek is absent");
  });

  test("a non-match `type` is reported verbatim, which is what futures.ts needs", async () => {
    const text = (await callTool(buildEvent({ type: "tournament" }))).content[0].text;
    assert.ok(/"type":\s*"tournament"/.test(text), "a non-match type is not surfaced");
    assert.ok(!/"type":\s*"match"/.test(text), "a stale 'match' value leaked in");
  });

  test("the roster is CAPPED, not dropped - the count is still reported honestly", async () => {
    const text = (await callTool(buildEvent())).content[0].text;
    assert.ok(text.includes('"totalPlayerCount": 79'), "the true player count is not reported");
    assert.ok(text.includes("PLAYER_0_NFL"), "no sample player survived, so shape info is lost");
    assert.ok(!text.includes("PLAYER_70_NFL"), "the roster was not actually capped");
  });

  test("an event with NO players still dumps, rather than throwing", async () => {
    const e = buildEvent();
    delete (e as Record<string, unknown>).players;
    const res = await callTool(e);
    assert.ok(!res.isError, "a player-less event produced an error");
    assert.ok(/"type":\s*"match"/.test(res.content[0].text), "`type` lost on a player-less event");
  });

  test("the scalars are a COPY, so the real nested objects are still printed below", async () => {
    const text = (await callTool(buildEvent())).content[0].text;
    assert.ok(text.includes("SCALARS_FIRST"), "the scalar header is missing");
    assert.ok(text.includes("Highmark Stadium"), "the real info object was replaced rather than copied");
  });
});

describe("v2.15.0 wiring: index.ts actually reaches the tool", () => {
  const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  test("registerDebugEventTool is imported AND called", () => {
    assert.match(indexSrc, /import \{ registerDebugEventTool \} from "\.\/tools\/debugEvent\.js";/);
    assert.match(indexSrc, /^\s*registerDebugEventTool\(server, sgo\);/m);
  });

  /* THIS TEST USED TO PIN THE EXACT STRING "2.15.0", WHICH WAS A MISTAKE.
   * It failed the moment v2.16.0 bumped the version, flagging a correct release as a
   * regression. A test that must be edited on every release is not testing anything;
   * it is a second copy of the version number. The durable invariants are that the
   * version is real semver and is NOT BELOW the release this file was written for. */
  test("SERVER_VERSION is valid semver and has not regressed below 2.15.0", () => {
    const m = indexSrc.match(/const SERVER_VERSION = "(\d+)\.(\d+)\.(\d+)";/);
    assert.ok(m, "SERVER_VERSION is missing or is not plain semver");
    const [major, minor, patch] = m!.slice(1, 4).map(Number);
    assert.ok(
      major > 2 || (major === 2 && minor >= 15),
      `SERVER_VERSION ${major}.${minor}.${patch} is below the 2.15.0 this file covers`
    );
  });

  /* package.json does not feed /health - SERVER_VERSION does - but the repo has
   * recorded SERVER_VERSION drifting out of step with /health three separate times
   * (constants.ts:17). Two copies of a number that must agree is that same drift
   * waiting in a new place, so they are pinned together here. */
  test("package.json agrees with SERVER_VERSION", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const m = indexSrc.match(/const SERVER_VERSION = "([^"]+)";/);
    assert.ok(m, "SERVER_VERSION not found in index.ts");
    assert.equal(pkg.version, m![1], `package.json ${pkg.version} != SERVER_VERSION ${m![1]}`);
  });
});

describe("v2.15.0 removal: debugInjuries is gone and nothing reaches for it", () => {
  test("the file is deleted", () => {
    assert.equal(existsSync(new URL("../src/tools/debugInjuries.ts", import.meta.url)), false);
  });

  test("index.ts never referenced it, so nothing is left dangling", () => {
    const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.ok(!indexSrc.includes("debugInjuries"), "index.ts still references the deleted file");
    assert.ok(!indexSrc.includes("registerDebugInjuriesTool"), "a dangling registration remains");
  });
});
