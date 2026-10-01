import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseAmerican,
  probToAmerican,
  payoutFor,
  devig,
  assessEdge,
} from "../src/services/devig.js";

/**
 * v2.13.0 devig.
 *
 * EVERY MARKET IN HERE IS REAL, pulled 2026-09-29 and 2026-10-01. The arithmetic is
 * checked against hand calculations recorded in the comments, not against whatever the
 * code happened to return first.
 */

const near = (a: number, b: number, tol = 0.0005) =>
  assert.ok(Math.abs(a - b) < tol, `expected ~${b}, got ${a}`);

describe("v2.13.0 American odds conversion", () => {
  test("positive and negative prices convert to probability", () => {
    near(parseAmerican("+103").prob!, 0.492611);
    near(parseAmerican("-140").prob!, 0.583333);
    near(parseAmerican("+800").prob!, 0.111111);
    near(parseAmerican("-2800").prob!, 0.965517);
    near(parseAmerican("+2000").prob!, 0.047619);
  });

  test("payout per unit staked", () => {
    near(payoutFor(520), 5.2);
    near(payoutFor(-140), 0.714286);
    near(parseAmerican("+2000").payout!, 20);
  });

  test("a bare number reads as positive, and +100 / -100 both work", () => {
    near(parseAmerican("520").prob!, parseAmerican("+520").prob!);
    near(parseAmerican("+100").prob!, 0.5);
    near(parseAmerican("-100").prob!, 0.5);
  });

  /* THE AMBIGUOUS MIDDLE. Nothing sits strictly between -100 and +100 in American odds,
   * so a decimal price pasted into this field must be refused. Accepting 1.91 as odds
   * would produce a probability wrong by a factor of fifty. */
  test("decimal odds are refused by name, not silently misread", () => {
    for (const bad of ["1.91", "6.2", "2.5", "-50", "99", "0"]) {
      const r = parseAmerican(bad);
      assert.equal(r.ok, false, `accepted ${bad}`);
      assert.match(r.reason!, /between -100 and \+100|DECIMAL/, bad);
    }
  });

  test("junk is refused", () => {
    for (const bad of ["", "abc", "+-100", undefined, null]) {
      assert.equal(parseAmerican(bad as never).ok, false, String(bad));
    }
  });

  test("probability back to American round-trips", () => {
    assert.equal(probToAmerican(0.5), "+100");
    assert.equal(probToAmerican(parseAmerican("+520").prob!), "+520");
    assert.equal(probToAmerican(parseAmerican("-140").prob!), "-140");
    assert.equal(probToAmerican(parseAmerican("+2000").prob!), "+2000");
  });
});

describe("v2.13.0 a near-even market: the methods agree", () => {
  /* Aliyah Boston assists o3.5 at DraftKings, 2026-09-29: +103 / -140.
   * Hand-checked: raw 49.2611% + 58.3333% = 107.5944%, hold 7.5944%.
   *   multiplicative over = 49.2611 / 107.5944 = 45.784%
   *   additive            = 49.2611 - 3.7972  = 45.464%
   *   power (k ~ 1.1188)                      = 45.29%
   */
  const M = ["+103", "-140"];

  test("hold is measured, not assumed", () => {
    const r = devig(M);
    assert.equal(r.ok, true);
    near(r.impliedTotal!, 1.075944);
    near(r.holdPct!, 7.5944, 0.01);
  });

  test("each method lands where the hand calculation says", () => {
    const r = devig(M);
    const by = (m: string) => r.methods!.find((x) => x.method === m)!;
    near(by("multiplicative").probs[0], 0.45784);
    near(by("additive").probs[0], 0.45464);
    near(by("power").probs[0], 0.4529, 0.002);
  });

  test("the fair price is +118, which is what makes FanDuel's +116 nearly fair", () => {
    const r = devig(M);
    assert.equal(r.methods!.find((m) => m.method === "multiplicative")!.fairAmerican[0], "+118");
  });

  test("no disagreement warning on an even market", () => {
    const r = devig(M);
    assert.equal(r.methodsDisagree, false);
    assert.ok(r.methodSpread! < 1.02, `spread was ${r.methodSpread}`);
  });

  test("both sides of the fair probabilities still sum to 1", () => {
    for (const m of devig(M).methods!) {
      if (!m.ok) continue;
      near(m.probs.reduce((a, b) => a + b, 0), 1);
    }
  });
});

describe("v2.13.0 a longshot: the methods diverge, and that is the point", () => {
  /* Alexandre Carrier anytime goalscorer at ESPN Bet, 2026-09-29: +800 / -2800.
   * Hand-checked: raw 11.1111% + 96.5517% = 107.6628%, hold 7.6628%.
   *   multiplicative yes = 11.1111 / 107.6628 = 10.320%
   *   additive           = 11.1111 - 3.8314  =  7.280%
   *   power (k ~ 1.3866)                     =  4.75%
   * Better than 2x between the extremes. DraftKings was showing +2000 on the same
   * market, which implies 4.7619%: a +117% edge under multiplicative, roughly fair
   * under power. */
  const M = ["+800", "-2800"];

  test("the three methods land where the hand calculation says", () => {
    const r = devig(M);
    const by = (m: string) => r.methods!.find((x) => x.method === m)!;
    near(by("multiplicative").probs[0], 0.10320);
    near(by("additive").probs[0], 0.07280);
    near(by("power").probs[0], 0.0475, 0.002);
  });

  test("the divergence is detected and says do not publish one number", () => {
    const r = devig(M);
    assert.equal(r.methodsDisagree, true);
    assert.ok(r.methodSpread! > 2, `spread was ${r.methodSpread}`);
    assert.ok(r.warnings!.some((w) => /METHODS DISAGREE/.test(w)));
    assert.ok(r.warnings!.some((w) => /Power devig is the better behaved/.test(w)));
  });

  /* THE WHOLE REASON THIS TOOL REPORTS EVERY METHOD. The same bet is +117% EV or
   * roughly flat depending entirely on the devig, and the flattering answer is the
   * wrong one. */
  test("+2000 reads as a huge edge under multiplicative and flat under power", () => {
    const e = assessEdge(M, "+2000");
    assert.equal(e.ok, true);
    const by = (m: string) => e.assessments!.find((a) => a.method === m)!;
    near(by("multiplicative").evPct, 116.72, 0.5);
    assert.ok(Math.abs(by("power").evPct) < 3, `power EV was ${by("power").evPct}`);
    assert.equal(by("multiplicative").verdict, "positive");
  });

  test("the worst case is reported next to the best, never just the best", () => {
    const e = assessEdge(M, "+2000");
    assert.ok(e.bestEvPct! > 100);
    assert.ok(e.worstEvPct! < 10);
    assert.notEqual(e.bestEvPct, e.worstEvPct);
  });

  /* THE OUTLIER GUARD, which is the open item this closes. */
  test("a double digit edge is flagged as probably stale data", () => {
    const e = assessEdge(M, "+2000");
    assert.ok(e.warnings!.some((w) => /not credible/.test(w)));
    assert.ok(e.warnings!.some((w) => /stale or mis-keyed/.test(w)));
  });

  test("the straddle warning fires when the range crosses zero", () => {
    const e = assessEdge(M, "+900");
    assert.ok(
      e.warnings!.some((w) => /edge is unproven/.test(w)),
      JSON.stringify(e.warnings)
    );
  });
});

describe("v2.13.0 what it refuses", () => {
  /* A ONE-SIDED MARKET CANNOT BE DEVIGGED. The hold is only visible in the sides
   * summing past 1. Half the yes/no rows on the prop board are one-sided, so this
   * refusal will fire often and must be clear about why. */
  test("one side is refused with the reason, not devigged against an assumed hold", () => {
    const r = devig(["+520"]);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /EVERY side/);
    assert.match(r.reason!, /nothing to remove/);
  });

  test("an empty or non-array input is refused", () => {
    assert.equal(devig([]).ok, false);
    assert.equal(devig(undefined as never).ok, false);
  });

  /* PRICES SUMMING BELOW 100% ARE NOT A MARKET. Devigging them would INFLATE both
   * probabilities, which is backwards. It means two books, or a stale price. */
  test("a sub-100% sum is refused rather than inflated", () => {
    const r = devig(["+120", "+120"]);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /at or below 100%/);
    assert.match(r.reason!, /not from the same book, or one is stale/);
    // It still reports what it saw, so the caller can see how far off it was.
    assert.ok(r.impliedTotal! < 1);
  });

  test("a bad price names which side failed", () => {
    const r = devig(["+103", "1.91"]);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /^Side 2:/);
  });

  test("a very high hold is warned about but still computed", () => {
    // -170 both ways is a 25.9% hold. (-150/-150 is exactly 20.0% and floating point
    // puts it a hair UNDER the threshold, which is why that is not the fixture.)
    const r = devig(["-170", "-170"]);
    assert.equal(r.ok, true);
    assert.ok(r.holdPct! > 20, `hold was ${r.holdPct}`);
    assert.ok(r.warnings!.some((w) => /very high/.test(w)));
  });

  /* ADDITIVE'S FAILURE CASE IS UNREACHABLE AT TWO OUTCOMES, which I had to prove rather
   * than assume. It needs excess/n > p_longshot, and at n = 2 that rearranges to
   * p_favourite > 1 + p_longshot, which no probability can satisfy. My first fixture here
   * tried to force it with +100000/-100000 and that market sums to exactly 100%, so it
   * was refused before additive ever ran.
   *
   * It IS reachable from three outcomes up, which this tool accepts because SGO's ml3way
   * carries home, away and draw. So the guard is tested where it can actually fire. */
  test("additive refuses its own impossible case on a 3-way, instead of going negative", () => {
    // +10000 / -300 / +150 -> 0.99% + 75% + 40% = 115.99%, 5.33% excess per side.
    const r = devig(["+10000", "-300", "+150"]);
    assert.equal(r.ok, true);
    assert.ok(r.impliedTotal! > 1.15);
    const add = r.methods!.find((m) => m.method === "additive")!;
    assert.equal(add.ok, false, "additive should refuse: 5.33% excess exceeds a 0.99% side");
    assert.match(add.reason!, /zero or below/);
    assert.match(add.reason!, /known limitation/);
    // One method failing is not a total failure: the other two still report.
    assert.equal(r.methods!.find((m) => m.method === "power")!.ok, true);
    assert.equal(r.methods!.find((m) => m.method === "multiplicative")!.ok, true);
  });

  test("a two-outcome market never trips additive, as the algebra says", () => {
    for (const m of [["+800", "-2800"], ["+10000", "-20000"], ["+103", "-140"]]) {
      const r = devig(m);
      if (!r.ok) continue;
      const add = r.methods!.find((x) => x.method === "additive")!;
      assert.equal(add.ok, true, `additive unexpectedly failed on ${m.join(" / ")}`);
      assert.ok(add.probs.every((p) => p > 0));
    }
  });
});

describe("v2.13.0 edge assessment mechanics", () => {
  const M = ["+103", "-140"];

  test("a price better than fair is positive EV, worse is negative", () => {
    const worse = assessEdge(M, "+103");
    const better = assessEdge(M, "+150");
    assert.equal(worse.assessments![0].verdict, "negative");
    assert.equal(better.assessments![0].verdict, "positive");
  });

  test("FanDuel's +116 against DraftKings' own fair number is roughly break even", () => {
    const e = assessEdge(M, "+116");
    const mult = e.assessments!.find((a) => a.method === "multiplicative")!;
    assert.ok(Math.abs(mult.evPct) < 1.5, `EV was ${mult.evPct}`);
  });

  test("sideIndex picks the under instead of the over", () => {
    const over = assessEdge(M, "+103", 0).assessments![0];
    const under = assessEdge(M, "-140", 1).assessments![0];
    near(over.fairProb + under.fairProb, 1);
  });

  test("an out of range sideIndex is refused", () => {
    assert.equal(assessEdge(M, "+103", 5).ok, false);
    assert.match(assessEdge(M, "+103", 5).reason!, /outside the 2 sides/);
  });

  test("a bad offered price is refused and says so", () => {
    const e = assessEdge(M, "1.91");
    assert.equal(e.ok, false);
    assert.match(e.reason!, /Offered price:/);
  });

  test("the market's own price devigs to exactly the fair price, EV zero", () => {
    const r = devig(M);
    const fair = r.methods!.find((m) => m.method === "multiplicative")!.fairAmerican[0];
    const e = assessEdge(M, fair);
    const mult = e.assessments!.find((a) => a.method === "multiplicative")!;
    assert.ok(Math.abs(mult.evPct) < 0.5, `EV at fair was ${mult.evPct}`);
  });
});

// ---------------------------------------------------------------------------
// WIRING.
// ---------------------------------------------------------------------------

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

const call = async (input: Record<string, unknown>) => {
  const { registerDevigTool } = await import("../src/tools/devig.js");
  const { server, handlers } = captureServer();
  registerDevigTool(server as never);
  return handlers["tkb_devig"](input as never);
};

describe("v2.13.0 the tool handler", () => {
  test("a near-even market renders every method and the hold", async () => {
    const res = await call({ prices: ["+103", "-140"], label: "Boston Assists o3.5" });
    assert.equal(res.structuredContent!.ok, true);
    assert.match(res.content[0].text, /Boston Assists o3\.5/);
    assert.match(res.content[0].text, /hold 7\.59%/);
    assert.match(res.content[0].text, /multiplicative/);
    assert.match(res.content[0].text, /additive/);
    assert.match(res.content[0].text, /power/);
  });

  test("an offered price adds the EV block", async () => {
    const res = await call({ prices: ["+103", "-140"], offeredPrice: "+116" });
    assert.match(res.content[0].text, /AGAINST \+116/);
    assert.ok(Array.isArray(res.structuredContent!.edge));
    assert.equal((res.structuredContent!.edge as unknown[]).length, 3);
  });

  test("a longshot carries the disagreement and outlier warnings through", async () => {
    const res = await call({ prices: ["+800", "-2800"], offeredPrice: "+2000" });
    assert.equal(res.structuredContent!.methodsDisagree, true);
    const w = res.structuredContent!.warnings as string[];
    assert.ok(w.some((x) => /METHODS DISAGREE/.test(x)));
    assert.ok(w.some((x) => /not credible/.test(x)));
    assert.match(res.content[0].text, /WARNING/);
  });

  test("a refusal comes back as a refusal, not an empty result", async () => {
    const res = await call({ prices: ["+520", "1.91"] });
    assert.equal(res.structuredContent!.ok, false);
    assert.match(res.content[0].text, /CANNOT DEVIG/);
  });

  /* v2.11.1 lesson applied on a new tool's first release: a stale client schema sends
   * strings, and a direct handler call skips zod entirely. */
  test("a string sideIndex is honoured", async () => {
    const res = await call({ prices: ["+103", "-140"], offeredPrice: "-140", sideIndex: "1" });
    assert.equal(res.structuredContent!.sideIndex, 1);
    const edge = res.structuredContent!.edge as { fairProb: number }[];
    assert.ok(edge[0].fairProb > 0.5, "sideIndex 1 is the under, which is the favourite here");
  });

  test("it says out loud that this is one book's opinion, not consensus", async () => {
    const res = await call({ prices: ["+103", "-140"] });
    assert.match(String(res.structuredContent!.note), /ONE book's opinion/);
    assert.match(String(res.structuredContent!.note), /not built yet/);
  });

  test("no offeredPrice means no edge block at all", async () => {
    const res = await call({ prices: ["+103", "-140"] });
    assert.equal(res.structuredContent!.edge, undefined);
    assert.doesNotMatch(res.content[0].text, /AGAINST/);
  });
});
