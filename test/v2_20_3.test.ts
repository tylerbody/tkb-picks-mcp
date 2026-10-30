import { test, describe } from "node:test";
import assert from "node:assert/strict";
import axios, { AxiosError, type AxiosAdapter } from "axios";

import { OU_PROP_MARKETS, YES_NO_MARKETS, findMarketByLabel } from "../src/services/marketCatalog.js";
import { resolveStatID } from "../src/services/statAliases.js";
import { parseRetryAfter, installRetryAfter, RETRY_AFTER_MAX_MS } from "../src/services/sgoClient.js";

/**
 * v2.20.3: label fix from the SGO docs review (2026-10-30) and Retry-After on 429.
 */

describe("`points` labels read like a bet, old labels still resolve", () => {
  test("basketball and football: Points; MLB: Runs; Score is an alias everywhere", () => {
    for (const sport of ["nba", "cbb", "wnba", "nfl", "cfb"] as const) {
      assert.equal(findMarketByLabel(OU_PROP_MARKETS[sport], "Points")?.statID, "points", sport);
      assert.equal(findMarketByLabel(OU_PROP_MARKETS[sport], "score")?.statID, "points", `${sport} alias`);
    }
    assert.equal(findMarketByLabel(OU_PROP_MARKETS.mlb, "Runs")?.statID, "points");
    assert.equal(findMarketByLabel(OU_PROP_MARKETS.mlb, "Score")?.statID, "points");
    assert.equal(findMarketByLabel(OU_PROP_MARKETS.mlb, "Runs Scored")?.statID, "points");
    assert.ok(!OU_PROP_MARKETS.mlb.some((m) => m.label === "Score"), "MLB no longer shows Score");
  });

  test("NHL is untouched: Points is goals+assists, Goals is points", () => {
    assert.equal(findMarketByLabel(OU_PROP_MARKETS.nhl, "Points")?.statID, "goals+assists");
    assert.equal(findMarketByLabel(OU_PROP_MARKETS.nhl, "Goals")?.statID, "points");
    assert.equal(findMarketByLabel(OU_PROP_MARKETS.nhl, "Score"), undefined);
  });

  test("a label wins over an alias, and no alias collides with another label in its sport", () => {
    for (const [sport, cat] of Object.entries(OU_PROP_MARKETS)) {
      const labels = new Set(cat.map((m) => m.label.toLowerCase()));
      for (const m of cat) for (const a of m.aliases ?? []) {
        assert.ok(!labels.has(a.toLowerCase()), `${sport}: alias "${a}" shadows a label`);
      }
    }
  });

  test("yes/no markets untouched", () => {
    assert.equal(findMarketByLabel(YES_NO_MARKETS.nba, "Any Score")?.statID ?? null, findMarketByLabel(YES_NO_MARKETS.nba, "any score")?.statID ?? null);
  });

  test("resolveStatID accepts the old label", () => {
    assert.equal(resolveStatID("nba", "Score").statID, "points");
    assert.equal(resolveStatID("nba", "Points").statID, "points");
  });
});

describe("Retry-After", () => {
  test("parses seconds and HTTP dates", () => {
    assert.equal(parseRetryAfter("5"), 5000);
    assert.equal(parseRetryAfter(undefined), null);
    assert.equal(parseRetryAfter("soon"), null);
    const now = Date.parse("2026-10-30T12:00:00Z");
    assert.equal(parseRetryAfter("Fri, 30 Oct 2026 12:00:07 GMT", now), 7000);
  });

  const make = (responses: { status: number; headers?: Record<string, string> }[]) => {
    let calls = 0;
    const adapter: AxiosAdapter = async (config) => {
      const r = responses[Math.min(calls++, responses.length - 1)]!;
      const res = { data: { ok: r.status === 200 }, status: r.status, statusText: "", headers: r.headers ?? {}, config };
      if (r.status >= 400) throw new AxiosError("x", "ERR", config, null, res as never);
      return res as never;
    };
    const http = axios.create({ adapter });
    const waits: number[] = [];
    installRetryAfter(http, async (ms) => { waits.push(ms); });
    return { http, waits, calls: () => calls };
  };

  test("a short 429 is waited out and retried once", async () => {
    const h = make([{ status: 429, headers: { "retry-after": "2" } }, { status: 200 }]);
    const r = await h.http.get("/events");
    assert.equal(r.status, 200);
    assert.deepEqual(h.waits, [2000]);
    assert.equal(h.calls(), 2);
  });

  test("never retries twice", async () => {
    const h = make([{ status: 429, headers: { "retry-after": "1" } }]);
    await assert.rejects(h.http.get("/events"));
    assert.equal(h.calls(), 2);
  });

  test("a long wait or no header is not retried", async () => {
    const long = make([{ status: 429, headers: { "retry-after": String(RETRY_AFTER_MAX_MS / 1000 + 1) } }]);
    await assert.rejects(long.http.get("/events"));
    assert.equal(long.calls(), 1);
    const none = make([{ status: 429 }]);
    await assert.rejects(none.http.get("/events"));
    assert.equal(none.calls(), 1);
  });

  test("other errors are never retried", async () => {
    const h = make([{ status: 500, headers: { "retry-after": "1" } }]);
    await assert.rejects(h.http.get("/events"));
    assert.equal(h.calls(), 1);
  });
});
