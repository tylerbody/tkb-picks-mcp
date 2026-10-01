import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BDLClient } from "../src/services/bdlClient.js";
import {
  createUnavailableBDLClient,
  isBdlConfigured,
  BDL_UNAVAILABLE_MESSAGE,
} from "../src/services/bdlUnavailable.js";

/**
 * v2.16.0: the connector runs on SportsGameOdds alone, with BALLDONTLIE optional.
 *
 * WHAT CHANGED AND WHY IT NEEDS TESTING AT THIS DEPTH.
 *
 * `if (!BDL_API_KEY) process.exit(1)` used to take all 31 tools down over a key that
 * six of them need. Making it optional is three lines. Making it optional WITHOUT
 * quietly degrading an answer is the part that can go wrong, in two directions:
 *
 *   1. A method that escapes the stub and reaches the network with no key would 401,
 *      and a 401 that lands in a tool's generic catch reads as "provider error" rather
 *      than "not configured". So EVERY network method must reject, including ones added
 *      to BDLClient after this file was written. That is asserted by enumerating the
 *      prototype rather than by listing method names.
 *
 *   2. The predicate must not report a LIVE client as unavailable. The first cut did
 *      exactly that: it read a marker property, and test/v2_14_0.test.ts's catch-all
 *      Proxy spy answered every property with a function, so a working client was
 *      declared missing. A false positive lets a doomed call fail honestly at the
 *      network boundary; a false negative disables a provider that works and blames
 *      a configuration problem that does not exist. The spy shape is pinned below.
 */

const captureServer = () => {
  const handlers: Record<
    string,
    (p: never) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>
  > = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

/* Methods that are synchronous and perform no I/O. Must pass through, not reject.
 * If BDLClient gains another pure method, this list and the one in
 * src/services/bdlUnavailable.ts both need it, which the completeness test below
 * will force by failing. */
const PURE_METHODS = new Set(["statsTierGated", "constructor"]);

describe("v2.16.0 the unavailable client refuses every network call", () => {
  test("a representative network method rejects with the named message", async () => {
    const bdl = createUnavailableBDLClient();
    await assert.rejects(() => bdl.getAllInjuries("nfl"), /BALLDONTLIE IS NOT CONFIGURED/);
  });

  test("the message names the one capability with no substitute", () => {
    assert.match(BDL_UNAVAILABLE_MESSAGE, /injury feed/i);
    assert.match(BDL_UNAVAILABLE_MESSAGE, /official injury report|official report/i);
    assert.match(BDL_UNAVAILABLE_MESSAGE, /BDL_API_KEY/);
  });

  /* THE COMPLETENESS TEST. Enumerating the prototype is the whole reason this is a
   * Proxy: a method added to BDLClient tomorrow is covered the day it is added, and
   * this test proves it rather than trusting it. */
  test("EVERY async method on the prototype rejects - no exceptions, present or future", async () => {
    const bdl = createUnavailableBDLClient();
    const names = Object.getOwnPropertyNames(BDLClient.prototype).filter((n) => {
      if (PURE_METHODS.has(n)) return false;
      const d = Object.getOwnPropertyDescriptor(BDLClient.prototype, n);
      return typeof d?.value === "function";
    });

    assert.ok(names.length >= 10, `expected a real method list, got ${names.length}`);

    const escaped: string[] = [];
    for (const n of names) {
      try {
        await (bdl as unknown as Record<string, () => Promise<unknown>>)[n]();
        escaped.push(`${n} RESOLVED`);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("BALLDONTLIE IS NOT CONFIGURED")) {
          escaped.push(`${n} threw the wrong error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    assert.deepEqual(escaped, [], `methods escaped the stub: ${escaped.join("; ")}`);
  });

  test("statsTierGated PASSES THROUGH - it is sync and pure, and the aggregator calls it", () => {
    const bdl = createUnavailableBDLClient();
    const result = bdl.statsTierGated("mlb");
    assert.equal(typeof result, "boolean", "statsTierGated must stay synchronous");
    assert.equal(result, false, "an empty gate map means not gated");
  });

  test("non-function properties still read through rather than becoming functions", () => {
    const bdl = createUnavailableBDLClient();
    assert.equal(typeof (bdl as unknown as Record<string, unknown>).nonExistentProperty, "undefined");
  });
});

describe("v2.16.0 isBdlConfigured, and the false-negative it was rewritten to prevent", () => {
  test("the stub reports unconfigured", () => {
    assert.equal(isBdlConfigured(createUnavailableBDLClient()), false);
  });

  test("a real keyed client reports configured", () => {
    assert.equal(isBdlConfigured(new BDLClient("some-real-looking-key")), true);
  });

  /* REGRESSION. This exact shape is v2_14_0.test.ts's spy. Under the marker-property
   * predicate it reported UNAVAILABLE, because the trap answered the marker with a
   * truthy function. Identity cannot be answered by a get trap. */
  test("a CATCH-ALL PROXY spy reports configured, not unavailable", () => {
    const spy = new Proxy({}, { get: () => () => undefined });
    assert.equal(
      isBdlConfigured(spy as unknown as BDLClient),
      true,
      "a spy that answers every property was misread as an unconfigured client"
    );
  });

  test("two separate stubs are both unconfigured, and do not alias each other", () => {
    const a = createUnavailableBDLClient();
    const b = createUnavailableBDLClient();
    assert.equal(isBdlConfigured(a), false);
    assert.equal(isBdlConfigured(b), false);
    assert.notEqual(a, b);
  });
});

describe("v2.16.0 the BDL-exclusive tools refuse by name instead of crashing", () => {
  /* The six tools that have no non-BDL source. Each already caught and printed
   * err.message before this release, which is WHY the stub works without editing
   * them - but "already does" is a claim, so it is measured here. */
  const cases: Array<{ tool: string; register: string; module: string; args: Record<string, unknown> }> = [
    { tool: "tkb_get_injuries", register: "registerInjuriesTool", module: "injuries", args: { sport: "nfl" } },
    { tool: "tkb_get_standings", register: "registerStandingsTool", module: "standings", args: { sport: "nfl" } },
    { tool: "tkb_get_rankings", register: "registerRankingsTool", module: "rankings", args: { sport: "cfb" } },
    {
      tool: "tkb_verify_roster",
      register: "registerVerifyRosterTool",
      module: "verifyRoster",
      args: { sport: "nfl", playerName: "Josh Allen", expectedTeam: "Buffalo Bills" },
    },
  ];

  for (const c of cases) {
    test(`${c.tool} returns a readable refusal naming BALLDONTLIE`, async () => {
      const mod = (await import(`../src/tools/${c.module}.js`)) as Record<string, unknown>;
      const register = mod[c.register] as (s: unknown, b: BDLClient) => void;
      const { server, handlers } = captureServer();
      register(server, createUnavailableBDLClient());

      const res = await handlers[c.tool](c.args as never);
      const text = res.content.map((p) => p.text).join("\n");
      assert.match(text, /BALLDONTLIE IS NOT CONFIGURED/, `${c.tool} did not surface the reason`);
      assert.match(text, /BDL_API_KEY/, `${c.tool} did not name the env var to set`);
    });
  }

  test("tkb_scan_streaks degrades per player rather than failing the whole scan", async () => {
    const { registerStreakScanTool } = await import("../src/tools/streakScan.js");
    const { server, handlers } = captureServer();
    registerStreakScanTool(server as never, createUnavailableBDLClient());
    const res = await handlers["tkb_scan_streaks"]({
      sport: "mlb",
      playerNames: ["Austin Riley"],
      statID: "batting_hits",
      line: 0.5,
      direction: "over",
    } as never);
    const text = res.content.map((p) => p.text).join("\n");
    assert.match(text, /BALLDONTLIE IS NOT CONFIGURED/, "the skip reason was swallowed");
  });
});

describe("v2.16.0 hit rates are unaffected by a missing BDL key", () => {
  const MLB_PID = "AUSTIN_RILEY_1_MLB";
  const mlbSgoStub = () =>
    ({
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
    }) as never;

  const callRate = async (extra: Record<string, unknown> = {}) => {
    const { registerHitRateTool } = await import("../src/tools/hitRate.js");
    const { server, handlers } = captureServer();
    registerHitRateTool(server as never, mlbSgoStub(), createUnavailableBDLClient(), undefined as never, undefined as never, undefined as never);
    return handlers["tkb_get_player_hit_rate"]({
      sport: "mlb",
      teamID: "ATLANTA_BRAVES_MLB",
      playerID: MLB_PID,
      playerName: "Austin Riley",
      statID: "batting_hits",
      line: 0.5,
      direction: "over",
      ...extra,
    } as never);
  };

  /* THE POINT OF THE WHOLE RELEASE. MLB is a sport BDL *could* serve, so if the
   * default still depended on BDL this is where a missing key would surface. */
  test("the DEFAULT hit rate still answers from SGO with no BDL key at all", async () => {
    const res = await callRate();
    assert.equal(res.structuredContent!.statSourceUsed, "sgo");
    /* assert.notMatch is absent on this Node build, so this is the explicit form. */
    assert.ok(
      !/NOT CONFIGURED/.test(res.content[0].text),
      "the default path leaked a BDL configuration message into an SGO answer"
    );
  });

  test("an explicit dataSource=bdl is refused UP FRONT, naming configuration not the stat", async () => {
    const res = await callRate({ dataSource: "bdl" });
    assert.equal(res.structuredContent!.reason, "bdl_not_configured");
    assert.equal(res.structuredContent!.suggestedDataSource, "sgo");
    assert.match(res.content[0].text, /BALLDONTLIE IS NOT CONFIGURED/);
  });

  /* ORDERING. batting_hits IS a supported BDL stat, so the pre-existing
   * "bdl_cannot_serve" refusal would not fire here anyway. Use a stat BDL does NOT
   * support to prove the configuration check runs FIRST: telling someone to pick a
   * different stat when there is no account behind it sends them in a circle. */
  test("configuration is reported BEFORE stat support, so the cause is named once", async () => {
    const res = await callRate({ dataSource: "bdl", statID: "pitching_strikeouts_thrown_nonexistent" });
    assert.equal(
      res.structuredContent!.reason,
      "bdl_not_configured",
      "an unsupported-stat message would send the caller to pick another stat and fail again"
    );
  });
});

describe("v2.16.0 index.ts wiring", () => {
  const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

  test("the FATAL guard on BDL_API_KEY is gone", () => {
    assert.ok(
      !/FATAL: BDL_API_KEY/.test(indexSrc),
      "the fatal BDL guard is still present, so an unset key still takes all 31 tools down"
    );
  });

  test("SGO is still fatal - it is the one provider nothing can replace", () => {
    assert.match(indexSrc, /FATAL: SGO_API_KEY/);
  });

  test("the client is built conditionally and falls back to the stub", () => {
    assert.match(
      indexSrc,
      /const bdl = BDL_API_KEY \? new BDLClient\(BDL_API_KEY\) : createUnavailableBDLClient\(\);/
    );
  });

  test("boot warns when BDL is absent, and says the injury feed has no substitute", () => {
    assert.match(indexSrc, /if \(!isBdlConfigured\(bdl\)\)/);
    assert.match(indexSrc, /WARN: BDL_API_KEY is not set/);
    assert.match(indexSrc, /NO SUBSTITUTE/);
  });

  test("package.json still agrees with SERVER_VERSION", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const m = indexSrc.match(/const SERVER_VERSION = "([^"]+)";/);
    assert.ok(m);
    assert.equal(pkg.version, m![1]);
  });
});
