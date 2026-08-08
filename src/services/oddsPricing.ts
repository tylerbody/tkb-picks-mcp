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
function firstAvailableBook(
  odd: SGOOdd
): [string, { odds: string; spread?: string; overUnder?: string }] | undefined {
  if (!odd.byBookmaker) return undefined;
  const entries = Object.entries(odd.byBookmaker);
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
  const hasBookOdds = Boolean(odd.bookOdds) && odd.bookOddsAvailable !== false;

  if (!book && !hasBookOdds) {
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
