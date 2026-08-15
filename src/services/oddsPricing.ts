import type { SGOOdd } from "../types.js";

/**
 * PRICING GUARDRAIL - the single most important accuracy safeguard in this connector.
 *
 * THE BUG THIS PREVENTS (found via live test, 8 Aug 2026):
 * Pulling Drake Maye's passing-yards prop for NFL Week 1, five weeks before kickoff,
 * returned a usable-looking result: americanOdds "-137". It was not usable. There was
 * no line, no bookmaker, and the identical -137 came back on BOTH the over and the
 * under - which is impossible for a real two-sided market. A manual check of Hard Rock,
 * theScore, and Caesars confirmed no sportsbook had posted NFL player props yet.
 *
 * What happened: SGO's catalog contained the market, no book had priced it, so the tool
 * fell through to `fairOdds` (SGO's own model estimate) and rendered it as though it
 * were a real price. A thread built on that would have published a made-up number with
 * no line attached - exactly the placeholder-odds failure that is banned outright.
 *
 * THE RULE: a market counts as usable ONLY if a real sportsbook has priced it.
 * `fairOdds` is a modelled estimate and must NEVER be published or presented as odds.
 * When no book price exists, tools say so plainly instead of returning something that
 * looks like data.
 *
 * WHY THIS FAILS LOUDLY RATHER THAN QUIETLY: a missing prop is a minor inconvenience -
 * pick a different market. A fabricated prop published to thousands of people is a
 * credibility problem that cannot be undone. Silent fallbacks that resemble real data
 * are strictly worse than errors.
 */

export interface PricedLine {
  /** American odds from a real sportsbook. Never a fair-odds estimate. */
  americanOdds: string;
  /** The over/under number or spread, e.g. "245.5" or "+2.5". */
  line?: string;
  /** Which book supplied the price. */
  bookmaker?: string;
}

export interface PricingResult {
  priced: boolean;
  value?: PricedLine;
  /** Why it isn't usable, phrased for direct display. */
  reason?: string;
}

/** True only if at least one bookmaker has an available price on this market. */
/**
 * Bookmaker keys that are NOT real, citable sportsbooks.
 *
 * FOUND VIA LIVE TEST (8 Aug 2026): SGO's byBookmaker map contains a literal key
 * named "unknown". On the NFL Week 1 Drake Maye passing-yards market it carried
 * odds of -137 with no attributable source, and the guardrail accepted it as a
 * real book - defeating the entire purpose of the guardrail. The MLB control
 * (Ohtani hits) returned named books, "fanduel" at +150 over and "draftkings" at
 * -236 under, which is what a genuinely priced two-sided market looks like.
 *
 * WHY THIS MATTERS BEYOND TIDINESS: a price you cannot attribute to a named book
 * is a price you cannot verify, cannot line-shop against, and cannot defend if a
 * follower asks where it came from. Publishing it is the same failure as
 * publishing fair odds, just one step less obvious.
 */
const NON_BOOKMAKER_KEYS = new Set(["unknown", "", "consensus", "average", "fair"]);

/**
 * PICK'EM APPS - real companies, but NOT sportsbooks for pricing purposes.
 *
 * Underdog, PrizePicks and their peers price nearly every prop at a flat
 * +100/+100. That is a product decision, not a market opinion: the payout is
 * fixed and the edge comes from requiring multiple correct legs. Treating one
 * of those numbers as a market price makes every prop look like a coin flip
 * with enormous edge, because the "break-even" is always 50%.
 *
 * MEASURED 2026-08-15: a Cardinals/Cubs screen returned 8 of its top 14 props
 * priced by Underdog at +100, including one showing a 50-point edge purely
 * because 12 of 12 was being compared against a flat 50% break-even. Those
 * numbers cannot be published - a follower shopping DraftKings or FanDuel would
 * find a completely different price.
 *
 * Excluded at this layer so no tool can source a price from them, matching the
 * existing rule that fair-odds estimates are never publishable.
 */
const PICKEM_APPS = new Set(["underdog", "prizepicks", "sleeper", "betr", "dabble", "parlayplay"]);

function isRealBookmaker(key: string): boolean {
  const k = key.trim().toLowerCase();
  return !NON_BOOKMAKER_KEYS.has(k) && !PICKEM_APPS.has(k);
}

function firstAvailableBook(
  odd: SGOOdd
): [string, { odds: string; spread?: string; overUnder?: string }] | undefined {
  if (!odd.byBookmaker) return undefined;
  // Only consider entries that name a REAL sportsbook. An unattributable price
  // is treated as no price at all.
  const entries = Object.entries(odd.byBookmaker).filter(([key]) => isRealBookmaker(key));
  // Prefer a book explicitly marked available; some entries are stale and flagged false.
  const available = entries.find(([, b]) => b.available !== false && b.odds);
  return (available ?? entries.find(([, b]) => b.odds)) as
    | [string, { odds: string; spread?: string; overUnder?: string }]
    | undefined;
}

/**
 * Extract a genuinely book-priced line, or explain why one isn't available.
 *
 * @param requireLine set true for over/under and spread markets, where a price
 *   without a number is meaningless ("OVER Passing Yards (-137)" says nothing).
 *   Leave false for moneyline and yes/no markets, which have no line by nature.
 */
export function extractPricedLine(
  odd: SGOOdd | undefined,
  opts: { requireLine: boolean; marketDescription: string }
): PricingResult {
  if (!odd) {
    return {
      priced: false,
      reason: `No market found for ${opts.marketDescription} on this event. It may not be offered for this game.`,
    };
  }

  if (odd.cancelled) {
    return {
      priced: false,
      reason: `The market for ${opts.marketDescription} is cancelled on this event.`,
    };
  }

  const book = firstAvailableBook(odd);

  // DELIBERATE: `odd.bookOdds` alone is NOT sufficient. It is SGO's cross-book
  // consensus figure, and on an unpriced market it can be present while no single
  // named book has actually posted anything - which is exactly how the Drake Maye
  // "-137 on both sides, no bookmaker" result slipped through. A usable price must
  // be traceable to a named sportsbook, which is why the check below tests `book`
  // (a named entry from byBookmaker) rather than the presence of bookOdds.

  if (!book) {
    const fairOnly = Boolean(odd.fairOdds);
    return {
      priced: false,
      reason: fairOnly
        ? `NOT YET PRICED BY ANY SPORTSBOOK: ${opts.marketDescription} exists in the market catalog for this event, but no book has posted a price. ` +
          `The only number available is SportsGameOdds' own fair-value estimate (${odd.fairOdds}), which is a model output, NOT real odds, and must not be published. ` +
          `This is normal for markets pulled well ahead of game day - player props in particular typically post within a few days of kickoff/first pitch, not weeks out. ` +
          `Either wait until closer to game time or pick a different market that has a real price.`
        : `No sportsbook price available for ${opts.marketDescription} on this event.`,
    };
  }

  const americanOdds = book?.[1]?.odds ?? odd.bookOdds!;
  const line =
    book?.[1]?.spread ??
    book?.[1]?.overUnder ??
    odd.bookSpread ??
    odd.bookOverUnder ??
    undefined;

  if (opts.requireLine && (line === undefined || line === null || line === "")) {
    return {
      priced: false,
      reason: `A price exists for ${opts.marketDescription} (${americanOdds}) but NO LINE was returned. ` +
        `An over/under or spread without its number is unusable - "OVER Passing Yards (-137)" states no actual bet. ` +
        `Do not publish this. Pick a different market, or retry closer to game time once the book posts a full line.`,
    };
  }

  return {
    priced: true,
    value: { americanOdds, line, bookmaker: book?.[0] },
  };
}

/**
 * ODDS ROUNDING - TKB house style.
 *
 * Round to the nearest 10 using standard rounding, where the 5 rounds AWAY from
 * zero: -136 becomes -140, -134 becomes -130, +106 becomes +110, +104 becomes +100.
 *
 * WHY THIS LIVES IN THE SERVER: this was applied by hand on every single pick for
 * months. On 2026-08-09 a Melton outs prop was nearly published at -145 when the
 * real under price was -110, because the number was carried across from a
 * different query and re-rounded from memory. Arithmetic repeated dozens of times
 * a morning is arithmetic that eventually goes wrong. Every tool that returns a
 * price now returns the rounded form alongside it, so the published number is
 * never computed by hand.
 */
export function roundToNearestTen(american: string | number): string {
  const n = typeof american === "number" ? american : parseInt(american, 10);
  if (Number.isNaN(n)) return String(american);
  const sign = n < 0 ? -1 : 1;
  const abs = Math.abs(n);
  // Math.round pushes .5 up, which for an absolute value is "away from zero".
  const rounded = Math.round(abs / 10) * 10;
  return (sign < 0 ? "-" : "+") + String(rounded);
}

/**
 * Break-even win probability implied by an American price, as a 0-1 decimal.
 * -150 returns 0.60, meaning the bet must win 60% of the time to break even.
 */
export function impliedProbability(american: string | number): number {
  const n = typeof american === "number" ? american : parseInt(american, 10);
  if (Number.isNaN(n) || n === 0) return 0;
  return n < 0 ? -n / (-n + 100) : 100 / (n + 100);
}

/**
 * Edge = counted hit rate minus break-even. Positive means the number is better
 * than the price implies.
 *
 * WHY THIS IS RETURNED RATHER THAN LEFT TO THE CALLER: a raw hit rate is
 * misleading on its own. On 2026-08-09 a Hoerner singles prop showed 7 of 11,
 * which reads like a play, at a price of -186. Break-even there is 65.0% and his
 * rate was 63.6% - a negative-edge bet that looks positive. Ranking or writing
 * from hit rate alone systematically surfaces exactly these. Returning edge makes
 * the comparison impossible to skip.
 */
export function computeEdge(hitRate: number, american: string | number): number {
  return hitRate - impliedProbability(american);
}
