/**
 * DEVIGGING: removing a book's margin to recover the market's own probability.
 *
 * A two-sided market's implied probabilities sum to more than 1. The excess is the
 * hold. Strip it and you get the fair probability, which is the only thing you can
 * compare an offered price against.
 *
 * ---- THE METHOD CHOICE IS THE SUBSTANCE, NOT A DETAIL ----
 *
 * There is no single "the" devig. The three implemented here disagree a little on a
 * near-even market and enormously on a longshot, and the difference decides whether a
 * price looks like free money or fair value. Measured on real prices from 2026-09-29:
 *
 *   Boston assists o3.5, +103 / -140      multiplicative 45.78%  additive 45.46%  power 45.29%
 *   Carrier anytime goal, +800 / -2800    multiplicative 10.32%  additive  7.28%  power  4.75%
 *
 * On the second one the methods differ by better than 2x. DraftKings was offering +2000
 * on that market, which implies 4.76%. Under multiplicative that is a +117% edge, which
 * is the kind of number that makes someone fire a bet. Under the power method it is
 * almost exactly fair and there is no edge at all.
 *
 * That is not an academic difference, and it is why this module reports every method and
 * refuses to hand back one confident number when they disagree. A single plausible wrong
 * answer is the failure mode this whole connector is built to avoid.
 *
 * WHY THEY DIVERGE. Multiplicative scales both sides by the same factor, which assumes
 * the book spreads its margin evenly. Books do not: they load it onto the longshot
 * (favourite-longshot bias). Power devig corrects for that by shrinking small
 * probabilities harder, so on a +2000 market it absorbs nearly all the vig into the
 * longshot side. Additive splits the excess equally in probability terms, which is
 * reasonable near even money and can drive an extreme longshot negative.
 *
 * NOT IMPLEMENTED: Shin's method, which models insider money and is generally regarded
 * as the best of the family. It needs an iterative solve against a different objective
 * and has not been verified here, so it is absent rather than approximated.
 */

export type DevigMethod = "multiplicative" | "additive" | "power";

export interface ParsedAmerican {
  ok: boolean;
  /** Implied probability, 0 to 1. */
  prob?: number;
  /** Profit on a 1 unit stake. +150 -> 1.5, -200 -> 0.5. */
  payout?: number;
  reason?: string;
}

/**
 * Parse American odds from a string or number.
 *
 * REFUSES THE AMBIGUOUS MIDDLE. American odds cannot sit strictly between -100 and
 * +100, so a value like 6.2 or 1.91 is decimal odds that someone pasted into the wrong
 * field. Accepting it would silently produce a probability that is wrong by a factor of
 * several, so it is rejected by name instead.
 */
export function parseAmerican(raw: string | number | undefined | null): ParsedAmerican {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, reason: "No price given." };
  }
  const s = String(raw).trim().replace(/\s+/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) {
    return { ok: false, reason: `"${raw}" is not American odds. Expected something like +520 or -140.` };
  }
  const n = Number(s);
  if (!Number.isFinite(n)) {
    return { ok: false, reason: `"${raw}" did not parse as a number.` };
  }
  if (n > -100 && n < 100) {
    return {
      ok: false,
      reason:
        `"${raw}" is not valid American odds: nothing sits strictly between -100 and +100. ` +
        `A value like 1.91 or 6.2 is DECIMAL odds. Convert it first, or pass the American price.`,
    };
  }
  if (n >= 100) return { ok: true, prob: 100 / (n + 100), payout: n / 100 };
  const abs = Math.abs(n);
  return { ok: true, prob: abs / (abs + 100), payout: 100 / abs };
}

/** Probability back to American odds. p > 0.5 is a negative price; 0.5 exactly is +100. */
export function probToAmerican(p: number): string {
  if (!(p > 0) || !(p < 1)) return "n/a";
  if (p > 0.5) {
    const v = -((p / (1 - p)) * 100);
    return String(Math.round(v));
  }
  const v = ((1 - p) / p) * 100;
  return `+${Math.round(v)}`;
}

/** Profit on 1 unit at these American odds. */
export function payoutFor(american: number): number {
  return american >= 100 ? american / 100 : 100 / Math.abs(american);
}

/**
 * Solve for the exponent k where the powered probabilities sum to 1.
 *
 * Bisection rather than Newton: the function is monotone in k over the bracket, the
 * bracket is known (k > 1 whenever the book has a positive hold), and bisection cannot
 * diverge. Speed is irrelevant at two outcomes.
 */
function solvePowerK(probs: number[]): number | null {
  const sumAt = (k: number) => probs.reduce((acc, p) => acc + Math.pow(p, k), 0);
  let lo = 1;
  let hi = 1;
  // Walk the upper bound out until the sum drops below 1.
  for (let i = 0; i < 200 && sumAt(hi) > 1; i++) hi *= 1.1;
  if (sumAt(hi) > 1) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (sumAt(mid) > 1) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface DevigOutcome {
  method: DevigMethod;
  /** Fair probability per side, in the order the prices were given. */
  probs: number[];
  /** Fair American price per side. */
  fairAmerican: string[];
  ok: boolean;
  reason?: string;
}

export interface DevigResult {
  ok: boolean;
  reason?: string;
  /** Raw implied probability per side, before any devig. */
  impliedProbs?: number[];
  /** Sum of the raw implied probabilities. 1.075 means a 7.5% hold. */
  impliedTotal?: number;
  holdPct?: number;
  methods?: DevigOutcome[];
  /** Largest ratio between any two methods' fair probability for side 0. */
  methodSpread?: number;
  /** True when the methods disagree enough that no single number should be published. */
  methodsDisagree?: boolean;
  warnings?: string[];
}

const DISAGREE_RATIO = 1.25;

/**
 * Devig a complete market.
 *
 * TAKES EVERY SIDE OR NOTHING. A one-sided market cannot be devigged: the hold is
 * measured from the sides summing past 1, and with one side there is nothing to measure.
 * This refuses rather than inventing an assumed hold, which would be a number with no
 * evidence behind it dressed up as arithmetic.
 */
export function devig(rawPrices: (string | number)[]): DevigResult {
  if (!Array.isArray(rawPrices) || rawPrices.length < 2) {
    return {
      ok: false,
      reason:
        `Devigging needs EVERY side of the market, and at least two. A one-sided price ` +
        `cannot be devigged: the hold is only visible in how far the sides sum past 100%, ` +
        `so with one side there is nothing to remove. Pass both the over and the under, ` +
        `or both the yes and the no, from the SAME book.`,
    };
  }

  const parsed = rawPrices.map((p) => parseAmerican(p));
  const bad = parsed.findIndex((p) => !p.ok);
  if (bad >= 0) {
    return { ok: false, reason: `Side ${bad + 1}: ${parsed[bad].reason}` };
  }

  const impliedProbs = parsed.map((p) => p.prob!);
  const impliedTotal = impliedProbs.reduce((a, b) => a + b, 0);
  const warnings: string[] = [];

  /* A SUM BELOW 1 IS NOT A MARKET TO DEVIG. It means either the two prices came from
   * different books, or one of them is stale. Devigging it would INFLATE both
   * probabilities, which is backwards, so it is refused. */
  if (impliedTotal <= 1) {
    return {
      ok: false,
      reason:
        `These prices sum to ${(impliedTotal * 100).toFixed(2)}%, which is at or below 100%. ` +
        `A real two-sided market from one book always sums above 100% because that excess ` +
        `is the book's margin. At or below 100% means the two prices are not from the same ` +
        `book, or one is stale. There is no vig here to remove.`,
      impliedProbs,
      impliedTotal,
    };
  }

  const holdPct = (impliedTotal - 1) * 100;
  if (holdPct > 20) {
    warnings.push(
      `Hold is ${holdPct.toFixed(1)}%, which is very high for a mainstream market. ` +
        `Treat one of these prices as possibly stale before trusting the fair number.`
    );
  }

  const methods: DevigOutcome[] = [];

  // ---- multiplicative ----
  methods.push({
    method: "multiplicative",
    ok: true,
    probs: impliedProbs.map((p) => p / impliedTotal),
    fairAmerican: impliedProbs.map((p) => probToAmerican(p / impliedTotal)),
  });

  // ---- additive ----
  /* ADDITIVE CANNOT GO NEGATIVE ON A TWO-OUTCOME MARKET, and it was worth proving rather
   * than assuming. The failure needs excess/n > p_longshot. At n = 2 that rearranges to
   * p_favourite > 1 + p_longshot, which is impossible because a probability is below 1.
   * So the guard below is unreachable for an over/under or a yes/no.
   *
   * It IS reachable from three outcomes up, which this tool accepts because SGO's
   * `ml3way` carries home, away and draw. Three sides let the combined excess exceed a
   * small longshot: +10000 / -300 / +150 sums to 115.99%, and 5.33% per side is more
   * than the longshot's 0.99%. The guard stays, and the test exercises it on a 3-way
   * rather than on a two-sided market where it can never fire. */
  const excessEach = (impliedTotal - 1) / impliedProbs.length;
  const addProbs = impliedProbs.map((p) => p - excessEach);
  if (addProbs.some((p) => p <= 0)) {
    methods.push({
      method: "additive",
      ok: false,
      probs: [],
      fairAmerican: [],
      reason:
        `Additive devig drives a side to zero or below here, because the excess (${(
          excessEach * 100
        ).toFixed(2)}% per side) is larger than the longshot's implied probability. ` +
        `That is a known limitation of the method on long prices, not a data problem.`,
    });
  } else {
    methods.push({
      method: "additive",
      ok: true,
      probs: addProbs,
      fairAmerican: addProbs.map((p) => probToAmerican(p)),
    });
  }

  // ---- power ----
  const k = solvePowerK(impliedProbs);
  if (k === null) {
    methods.push({
      method: "power",
      ok: false,
      probs: [],
      fairAmerican: [],
      reason: `Power devig did not converge on these prices.`,
    });
  } else {
    const powProbs = impliedProbs.map((p) => Math.pow(p, k));
    methods.push({
      method: "power",
      ok: true,
      probs: powProbs,
      fairAmerican: powProbs.map((p) => probToAmerican(p)),
    });
  }

  const side0 = methods.filter((m) => m.ok).map((m) => m.probs[0]);
  const methodSpread =
    side0.length > 1 ? Math.max(...side0) / Math.min(...side0) : 1;
  const methodsDisagree = methodSpread > DISAGREE_RATIO;

  if (methodsDisagree) {
    warnings.push(
      `THE METHODS DISAGREE BY ${((methodSpread - 1) * 100).toFixed(0)}% on this market, ` +
        `which happens on long prices because books load their margin onto the longshot. ` +
        `Do NOT publish a single fair number here. Power devig is the better behaved of ` +
        `the three on longshots; multiplicative will overstate the longshot's chance and ` +
        `therefore overstate your edge.`
    );
  }

  return {
    ok: true,
    impliedProbs,
    impliedTotal,
    holdPct,
    methods,
    methodSpread,
    methodsDisagree,
    warnings,
  };
}

export interface EdgeAssessment {
  method: DevigMethod;
  fairProb: number;
  fairPrice: string;
  offeredProb: number;
  /** Expected profit per 1 unit staked. 0.04 is a 4% edge. */
  ev: number;
  evPct: number;
  verdict: "positive" | "negative" | "flat";
}

export interface EdgeResult {
  ok: boolean;
  reason?: string;
  offered?: string;
  assessments?: EdgeAssessment[];
  /** Highest EV across methods, and the lowest. Both matter. */
  bestEvPct?: number;
  worstEvPct?: number;
  warnings?: string[];
}

/** An edge beyond this on a mainstream market is almost always bad data. */
const SUSPICIOUS_EV_PCT = 5;

/**
 * Compare an offered price against the fair price from each method.
 *
 * REPORTS THE WORST CASE ALONGSIDE THE BEST. A caller who sees only the best number is
 * being handed the most flattering method, which on a longshot is reliably
 * multiplicative and reliably the wrong one.
 */
export function assessEdge(
  marketPrices: (string | number)[],
  offeredPrice: string | number,
  sideIndex = 0
): EdgeResult {
  const base = devig(marketPrices);
  if (!base.ok) return { ok: false, reason: base.reason };

  const offered = parseAmerican(offeredPrice);
  if (!offered.ok) return { ok: false, reason: `Offered price: ${offered.reason}` };

  if (sideIndex < 0 || sideIndex >= marketPrices.length) {
    return {
      ok: false,
      reason: `sideIndex ${sideIndex} is outside the ${marketPrices.length} sides given.`,
    };
  }

  const warnings = [...(base.warnings ?? [])];
  const assessments: EdgeAssessment[] = [];

  for (const m of base.methods ?? []) {
    if (!m.ok) continue;
    const fairProb = m.probs[sideIndex];
    const ev = fairProb * offered.payout! - (1 - fairProb);
    assessments.push({
      method: m.method,
      fairProb,
      fairPrice: m.fairAmerican[sideIndex],
      offeredProb: offered.prob!,
      ev,
      evPct: ev * 100,
      verdict: ev > 0.0005 ? "positive" : ev < -0.0005 ? "negative" : "flat",
    });
  }

  const evs = assessments.map((a) => a.evPct);
  const bestEvPct = evs.length ? Math.max(...evs) : undefined;
  const worstEvPct = evs.length ? Math.min(...evs) : undefined;

  /* THE OUTLIER GUARD. A double-digit edge on a market eight books price is not an
   * opportunity, it is a stale or mis-keyed number. Measured 2026-09-29: DraftKings
   * showed +2000 on a market ESPN Bet had at +800, and espnbet +190 on an Any Passing TD
   * six books had near -250. Both read as enormous edges and neither was real. */
  if (bestEvPct !== undefined && bestEvPct > SUSPICIOUS_EV_PCT) {
    warnings.push(
      `BEST-CASE EDGE IS ${bestEvPct.toFixed(1)}%, which is not credible on a market this ` +
        `widely priced. An edge above about ${SUSPICIOUS_EV_PCT}% is far more often a stale ` +
        `or mis-keyed price than free money. Confirm the number is still live at the book ` +
        `and that a second book agrees before treating this as value.`
    );
  }

  if (base.methodsDisagree && bestEvPct !== undefined && worstEvPct !== undefined) {
    warnings.push(
      `The methods put this bet between ${worstEvPct.toFixed(1)}% and ` +
        `${bestEvPct.toFixed(1)}% EV. When the range straddles zero the honest answer is ` +
        `that the edge is unproven, not that it exists.`
    );
  }

  return { ok: true, offered: String(offeredPrice), assessments, bestEvPct, worstEvPct, warnings };
}
