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

/**
 * NOT PUBLISHABLE FOR THIS ACCOUNT, though not pick'em apps either.
 *
 * Fliff is a sweepstakes book. Unlike Underdog it posts genuinely juiced two-way
 * lines, so it does NOT corrupt the edge maths the way a flat +100/+100 board
 * does - measured 2026-08-19, Fliff had Chisholm total bases under at -182 while
 * Caesars had -179, and Rice at -145 while DraftKings had -128. The numbers are
 * real. The problem is that a follower cannot bet them, and this account's own
 * publishing rules name Fliff alongside Underdog, PrizePicks and Sleeper as
 * never-publishable. Enforcing that here rather than trusting the workflow to
 * re-check it every time is the same reasoning that moved "never publish fair
 * odds" out of prose and into extractPricedLine.
 *
 * Note the Rice case cuts BOTH ways: pricing against Fliff understated that
 * prop's real edge by 3 points. An unbettable price is not merely unpublishable,
 * it silently corrupts any ranking built on it. The durable fix is passing
 * preferredBookmakers into tkb_screen_props (v2.5.3) so the screen only ever
 * sees your books; this set is the backstop for anything that slips past.
 */
const NON_PUBLISHABLE_BOOKS = new Set(["fliff"]);

/**
 * PREDICTION MARKETS - not sportsbooks, and dangerous for a DIFFERENT reason
 * than either of the two sets above.
 *
 * MEASURED LIVE 2026-08-24, on a Lynx/Valkyries screen. Polymarket priced
 * Courtney Williams OVER 4.5 rebounds at +3079. Her counted rate was 5 of 15,
 * i.e. 33%. Break-even at +3079 is 3.1%, so the tool computed a 30-point edge
 * and RANKED IT FIRST ON THE BOARD - above five legitimate FanDuel props.
 *
 * A 33% prop at the top of the board is the exact outcome v2.5.0 identified when
 * Underdog's flat +100 was inflating everything, and the mechanism is the same:
 * a price that does not come from a two-sided sportsbook market makes the
 * break-even comparison meaningless, so edge stops measuring value and starts
 * measuring how strange the price is.
 *
 * WHY A SEPARATE SET RATHER THAN ADDING TO PICKEM_APPS, following the reasoning
 * v2.5.3 used to keep Fliff separate: the REASON determines where a venue goes.
 * Pick'em apps distort by being FLAT. Fliff is real but unbettable for this
 * audience. Prediction markets are neither - they are genuine markets with real
 * liquidity whose contract pricing simply is not comparable to a sportsbook
 * over/under. If a future venue needs blocking, its category tells you which set
 * it belongs in and what to expect from it.
 *
 * NOT INCLUDED, deliberately: exchanges such as prophetexchange, novig and
 * sporttrade. Those post realistic two-way prices (ProphetX appeared six times
 * in the same test at -139, -161, +124 and similar), so they do not corrupt the
 * maths. They are excluded from screening by the preferredBookmakers default in
 * screenProps instead, which is a ranking decision rather than a correctness one.
 * ProphetX in particular is a TKB affiliate partner, so blocking it outright here
 * would be the wrong call to make silently.
 */
const PREDICTION_MARKETS = new Set(["polymarket", "kalshi", "predictit", "manifold"]);

/**
 * OFFSHORE AND UNREGULATED BOOKS - blocked for a FOURTH distinct reason.
 *
 * WHY THIS SET DID NOT EXIST UNTIL v2.8.6, AND WHY ITS ABSENCE WAS LOAD-BEARING.
 * `betonline` and `bovada` appear in NONE of the three sets above, so
 * isRealBookmaker has always accepted them as publishable prices. They stayed out
 * of threads only because the three tools that mattered happened to send a
 * preferredBookmakers filter to SGO, which excluded them SERVER-SIDE before they
 * ever reached this function.
 *
 * THAT IS PROTECTION BY CONVENTION RATHER THAN BY CONSTRUCTION, and it has already
 * failed once. v2.8.3 recorded tkb_get_line_movement returning a price from
 * BetOnline and filed it as a missing-parameter problem. The parameter was half of
 * it. The other half is that the pricing layer had no opinion about offshore books
 * at all, so when a tool sent no filter there was nothing left to catch it.
 *
 * v2.8.6 does BOTH: the missing defaults are added AND this set exists. A default
 * can be overridden, forgotten on a future tool, or switched off with "all" for
 * diagnosis. This set cannot be bypassed by any call site - the same argument that
 * moved "never publish fair odds" out of prose and into extractPricedLine.
 *
 * THE REASON DECIDES THE SET, per this file's existing convention. These are
 * genuine two-way sportsbooks posting realistic juice, so unlike a flat pick'em
 * board or a prediction-market contract they do NOT corrupt the edge maths. They
 * are blocked because a US follower cannot legally bet them - the same reason as
 * Fliff. Fliff is kept separate because it is a sweepstakes product rather than an
 * offshore one, and if a venue ever needs unblocking the reason is what tells you
 * which set to look in.
 *
 * IDs taken from SportsGameOdds' published bookmakers list, checked 2026-09-02.
 */
const OFFSHORE_BOOKS = new Set([
  "betonline",
  "bovada",
  "mybookie",
  "betus",
  "everygame",
  "lowvig",
  "betanysports",
  "sportsbetting_ag",
  "bookmakereu",
]);

function isRealBookmaker(key: string): boolean {
  const k = key.trim().toLowerCase();
  return (
    !NON_BOOKMAKER_KEYS.has(k) &&
    !PICKEM_APPS.has(k) &&
    !NON_PUBLISHABLE_BOOKS.has(k) &&
    !PREDICTION_MARKETS.has(k) &&
    !OFFSHORE_BOOKS.has(k)
  );
}

/** Exported for tests. Every venue this connector refuses to price against. */
export function isBlockedBookmaker(key: string): boolean {
  return !isRealBookmaker(key);
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
 * EVERY REAL BOOK'S PRICE ON ONE ODD, BEST FIRST. Added v2.10.5.
 *
 * ============================================================================
 * WHY THIS EXISTS: firstAvailableBook DISCARDS THE REST OF THE MARKET
 * ============================================================================
 *
 * `extractPricedLine` reports ONE price per side, chosen by `firstAvailableBook`,
 * which is whichever entry SGO happened to return first among the books that pass
 * the filter. It is not the best price and it is not a stable choice: add a book to
 * DEFAULT_BOOKMAKERS and a different venue can win the slot on the same market.
 *
 * TWO CONSEQUENCES, BOTH MEASURED 2026-09-28 on NHL Boston at Florida:
 *
 *   1. A BOOK LOOKS ABSENT WHEN IT IS FULLY PRICED. Filtered to hardrockbet alone
 *      that event produced 89 rows across 15 players and six markets. On the
 *      multi-book board Hard Rock appeared on almost nothing, because other books
 *      kept winning the slot. The owner could see those prices in the Hard Rock app
 *      while the board implied they did not exist. That is not a coverage gap, it is
 *      a display artifact, and it is the more misleading of the two.
 *
 *   2. THE ACCOUNT PUBLISHES A PRICE IT DID NOT HAVE TO ACCEPT. Taking an arbitrary
 *      book instead of the best available one is a standing drag on every pick, and
 *      it interacts with the -125 to -200 band in the gates draft: whether a prop
 *      clears the floor at all can depend on which book happened to be first.
 *
 * WHAT THIS FUNCTION DOES AND DELIBERATELY DOES NOT DO. It returns the full set so a
 * caller can see and shop the market. It does NOT change what `extractPricedLine`
 * selects, because flipping the default selection alters the output of every tool at
 * once and that is the owner's call, not a side effect of a visibility fix.
 *
 * ORDERING IS BY VALUE TO THE BETTOR, not by book name: for either side of an
 * over/under, a longer price is strictly better, so American odds sort descending
 * (+150 ahead of -110 ahead of -200). Every entry still passes `isRealBookmaker`, so
 * pick'em apps, Fliff, prediction markets and offshore venues never appear here.
 */
export interface BookPrice {
  bookmaker: string;
  americanOdds: string;
  line?: string;
}

/** Numeric value of an American odds string, for comparison only. */
function americanValue(odds: string): number {
  const n = parseFloat(String(odds).replace(/[+\s]/g, ""));
  return Number.isNaN(n) ? Number.NEGATIVE_INFINITY : n;
}

export function allBookPrices(odd: SGOOdd | undefined): BookPrice[] {
  if (!odd?.byBookmaker) return [];

  const collect = (predicate: (e: { odds?: string; available?: boolean }) => boolean): BookPrice[] => {
    const out: BookPrice[] = [];
    for (const [key, b] of Object.entries(odd.byBookmaker!)) {
      if (!isRealBookmaker(key)) continue;
      const entry = b as { odds?: string; spread?: string; overUnder?: string; available?: boolean };
      if (!entry.odds) continue;
      if (!predicate(entry)) continue;
      out.push({
        bookmaker: key,
        americanOdds: entry.odds,
        // Same rule as the priced line: the number comes from the SAME book as the
        // price or it does not come at all.
        line: entry.spread ?? entry.overUnder ?? undefined,
      });
    }
    // Best for the bettor first. A longer price is better on either side of an O/U.
    out.sort((a, b) => americanValue(b.americanOdds) - americanValue(a.americanOdds));
    return out;
  };

  /* ---- THE CANDIDATE POOL MUST MATCH firstAvailableBook, FIXED v2.10.5a ----
   *
   * The first cut of this function skipped `available === false` unconditionally and
   * returned an EMPTY array on every settled event, because a finished market has
   * every book flagged unavailable. Measured on NHL Boston at Florida: the board came
   * back with the selected price intact and `bookCount: 0, bestPrice: null` on every
   * single side, while Hard Rock demonstrably priced those same markets.
   *
   * `firstAvailableBook` is two-tier: it PREFERS a book marked available, and falls
   * back to any book carrying odds when none is. This has to use the same two tiers,
   * or `bestPrice` is drawn from a smaller pool than the price it is being compared
   * against, which is how you get "no best price" sitting next to a real one.
   *
   * WHY THE UNIT TESTS MISSED IT, worth recording: they hand-built byBookmaker entries
   * with `available: true` and asserted on the helper, and the board test supplied
   * `allBooks` directly rather than letting the push site compute it. So the helper was
   * correct and the seam was never exercised. That is the exact failure toolWiring.test.ts
   * was written about, repeated here by the author of this comment.
   */
  const available = collect((e) => e.available !== false);
  return available.length ? available : collect(() => true);
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

  /* --------------------------------------------------------------------------
   * THE LINE COMES FROM THE SAME BOOK AS THE PRICE, OR IT DOES NOT COME AT ALL.
   *
   * This previously fell back to `odd.bookSpread ?? odd.bookOverUnder`, which are
   * SGO's TOP-LEVEL CROSS-BOOK figures, not any single book's number. The price was
   * still read from `byBookmaker.<book>.odds`, so the two halves of a published pick
   * could come from different places and be labelled with one book's name:
   *
   *   "OVER 4.5 (-115, DraftKings)"   where DraftKings' actual number was 5.5
   *
   * A price and a line that disagree are worse than a missing line, because the
   * missing line is refused three lines below and the mismatch is not detectable by
   * anyone reading the output. pickGrader.ts already documents `bookOverUnder` as a
   * converged consensus figure rather than a book's number, which is exactly why it
   * must not be a fallback here.
   *
   * A book quoting a price with no line is now handled by the requireLine refusal,
   * the same as a market with no price at all.
   * ------------------------------------------------------------------------*/
  const line = book?.[1]?.spread ?? book?.[1]?.overUnder ?? undefined;

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

/**
 * THE OPENING NUMBER, FROM A NAMED, PUBLISHABLE BOOK, OR NOT AT ALL.
 *
 * ============================================================================
 * WHY THIS IS NOT JUST `odd.openBookOdds`
 * ============================================================================
 *
 * MEASURED 2026-09-24 on an NHL moneyline whose only two venues were polymarket and
 * kalshi. tkb_get_line_movement returned:
 *
 *   currentOdds: null        correctly refused, prediction markets are blocked
 *   openingOdds: "-145"      came through anyway
 *   bookmaker:   null        with no attribution
 *
 * because the opening price was read straight off the odd as
 * `odd.openOdds ?? odd.openBookOdds`, bypassing extractPricedLine entirely.
 *
 * `openBookOdds` is a MEDIAN ACROSS BOOKS. This file's own rule, stated at the top,
 * is that a usable price must be traceable to a named sportsbook - which is why the
 * price check tests `book` rather than the presence of `bookOdds`. The opening price
 * was never held to it.
 *
 * ============================================================================
 * PREFERRING THE SAME BOOK AS THE CURRENT PRICE
 * ============================================================================
 *
 * A movement claim subtracts two numbers. If they come from different venues, part of
 * the difference is the venue, and "this total moved a full point" becomes an artifact.
 * So this takes the book the current price came from when that book also carries an
 * open, and only then falls back to any other real book - reporting which, so the
 * caller can say so.
 *
 * Returns undefined fields rather than zeros or consensus values. An unattributable
 * open is reported as absent, which is the honest answer and the one the caller can
 * act on.
 */
export interface OpeningFromBook {
  odds?: string;
  line?: string;
  bookmaker?: string;
}

export function extractOpeningFromBook(
  odd: SGOOdd,
  preferBookmaker?: string
): OpeningFromBook {
  const entries = odd.byBookmaker;
  if (!entries || typeof entries !== "object") return {};

  const read = (key: string): OpeningFromBook | null => {
    const e = entries[key];
    if (!e) return null;
    const odds = typeof e.openOdds === "string" ? e.openOdds : undefined;
    const line =
      typeof e.openOverUnder === "string"
        ? e.openOverUnder
        : typeof e.openSpread === "string"
          ? e.openSpread
          : undefined;
    if (odds === undefined && line === undefined) return null;
    return { odds, line, bookmaker: key };
  };

  // 1. The book the current price came from, so both ends of a movement agree.
  if (preferBookmaker && isRealBookmaker(preferBookmaker)) {
    const same = read(preferBookmaker);
    if (same) return same;
  }

  // 2. Any other REAL book. Blocked venues are never a source, opening or current.
  for (const key of Object.keys(entries)) {
    if (!isRealBookmaker(key)) continue;
    const hit = read(key);
    if (hit) return hit;
  }

  // 3. Nothing attributable. NOT a fallback to openBookOdds - that is the bug.
  return {};
}
