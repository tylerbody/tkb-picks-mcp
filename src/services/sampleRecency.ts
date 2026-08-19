/**
 * SAMPLE RECENCY - is this hit rate describing NOW, or describing months ago?
 *
 * THE GAP THIS CLOSES. seasonBoundary.ts already catches a sample that reaches
 * back into a PRIOR season. It cannot see a sample that is stale WITHIN the
 * current season, because every date it looks at belongs to the same year.
 *
 * FOUND LIVE 2026-08-19 while testing v2.5.2. Chris Bassitt screened at 8 of 10
 * unders on strikeouts, presented with seasonWarning: null, i.e. clean. His
 * counted starts were:
 *
 *   8/14, then 6/03, 5/28, 5/22, 5/16, 5/10 ...
 *
 * ONE of his ten counted starts was inside the last 30 days. A healthy starter
 * makes ten starts in roughly fifty days; that sample spanned about ninety-six.
 * He had plainly just returned from a long absence, and the screen described
 * three-month-old form as current. Every number in it was correct. That is the
 * same failure class as the reversed-array bug in v2.1.0: right values, wrong
 * story, and no data-integrity check can catch it because nothing is malformed.
 *
 * WHY THIS IS A WARNING AND NOT A FILTER. A stale sample is not automatically a
 * bad bet. Bassitt's under may well be correct. What it cannot be is described
 * as "cleared this in 8 of his last 10" without noting the gap, which is exactly
 * the kind of sentence this account publishes. So this surfaces nuance for the
 * writer rather than silently dropping the prop.
 *
 * WHY FOUR SIGNALS RATHER THAN A SIMPLE COUNT. A plain "how many in the last 30
 * days" misses a player who played last night but has a six-week hole in the
 * middle of the sample. Each signal catches a different shape of the same
 * problem, and the warning names which one fired so the writer knows what to do
 * about it:
 *
 *   appearancesLast30Days  - sample is mostly old
 *   largestGapDays         - sample straddles a long absence
 *   daysSinceMostRecent    - player has not been in a game lately (Azzi Fudd,
 *                            12 of 15 while not having played in a week)
 *   sampleSpanDays         - context for the three above, never flags alone
 *
 * COSTS NOTHING. Every date is already present in the log; this is pure
 * post-processing with no additional API call and no entity spend.
 */

export interface SampleRecency {
  /** Games the player actually appeared in, i.e. the real denominator. */
  countedAppearances: number;
  appearancesLast30Days: number;
  /** Days between today and the newest counted appearance. */
  daysSinceMostRecent: number | null;
  /** Longest stretch between two consecutive counted appearances. */
  largestGapDays: number | null;
  /** Newest counted appearance minus oldest. */
  sampleSpanDays: number | null;
  isStale: boolean;
  /** Which checks fired, for diagnostics and for the internal report. */
  reasons: string[];
  /** Ready-to-surface prose, or null when the sample is genuinely current. */
  warning: string | null;
}

export interface RecencyThresholds {
  /** Window used for the "mostly old" test. */
  recentWindowDays: number;
  /** A gap longer than this between appearances means an absence, not a rest day. */
  maxGapDays: number;
  /** Not having appeared in this long is itself a flag. */
  maxDaysSinceMostRecent: number;
}

export const DEFAULT_RECENCY_THRESHOLDS: RecencyThresholds = {
  recentWindowDays: 30,
  maxGapDays: 21,
  maxDaysSinceMostRecent: 10,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function dayDiff(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

/**
 * Assess how recent a counted sample actually is.
 *
 * Accepts the same log shape both aggregators already produce. Entries with a
 * null statValue are DNPs and are ignored - they are not appearances, and
 * counting them would make an injured player look like he had been playing.
 */
export function describeRecency(
  log: { date: string; statValue: number | null }[],
  thresholds: Partial<RecencyThresholds> = {},
  now: Date = new Date()
): SampleRecency {
  const t = { ...DEFAULT_RECENCY_THRESHOLDS, ...thresholds };

  const dates = log
    .filter((g) => g.statValue !== null)
    .map((g) => new Date(g.date))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime()); // newest first

  const counted = dates.length;
  if (counted === 0) {
    return {
      countedAppearances: 0,
      appearancesLast30Days: 0,
      daysSinceMostRecent: null,
      largestGapDays: null,
      sampleSpanDays: null,
      isStale: false,
      reasons: [],
      warning: null,
    };
  }

  const newest = dates[0]!;
  const oldest = dates[dates.length - 1]!;
  const daysSinceMostRecent = dayDiff(now, newest);
  const sampleSpanDays = dayDiff(newest, oldest);
  const appearancesLast30Days = dates.filter(
    (d) => dayDiff(now, d) <= t.recentWindowDays
  ).length;

  let largestGapDays = 0;
  for (let i = 0; i < dates.length - 1; i++) {
    largestGapDays = Math.max(largestGapDays, dayDiff(dates[i]!, dates[i + 1]!));
  }

  const reasons: string[] = [];
  // "Mostly old" only makes sense with more than one game to speak of.
  if (counted > 1 && appearancesLast30Days * 2 < counted) {
    reasons.push(
      `only ${appearancesLast30Days} of ${counted} counted games fall in the last ${t.recentWindowDays} days`
    );
  }
  if (largestGapDays > t.maxGapDays) {
    reasons.push(`a ${largestGapDays}-day gap sits inside the sample`);
  }
  if (daysSinceMostRecent > t.maxDaysSinceMostRecent) {
    reasons.push(`the most recent appearance was ${daysSinceMostRecent} days ago`);
  }

  const isStale = reasons.length > 0;

  return {
    countedAppearances: counted,
    appearancesLast30Days,
    daysSinceMostRecent,
    largestGapDays,
    sampleSpanDays,
    isStale,
    reasons,
    warning: isStale
      ? `STALE SAMPLE: ${reasons.join("; ")}. The counted games span ${sampleSpanDays} days. ` +
        `The numbers are real, but this is NOT current form - do not write it as "in his last ` +
        `${counted} games" without saying when those games happened, and prefer a different ` +
        `angle if the gap is due to an injury or a role change.`
      : null,
  };
}
