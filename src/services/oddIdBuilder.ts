/**
 * SGO oddID format is systematic: {statID}-{entity}-{periodID}-{betType}-{side}
 *
 * entity: a playerID, "home", "away", or "all" (game-wide, e.g. total score)
 * periodID: "game" (full event) or a period code (see PERIOD_CODES below)
 * betType: "ou" (over/under), "yn" (yes/no), "ml" (moneyline), "sp" (spread), "ml3way"
 * side: "over"/"under", "yes"/"no", "home"/"away", "draw"
 *
 * Confirmed directly from SGO's published market CSVs (oddID column) across
 * MLB/WNBA/NBA/NFL/NCAAF - this is not guessed, it's the literal pattern observed
 * in their data across hundreds of market rows.
 */

export const PERIOD_CODES: Record<string, string> = {
  full_game: "game",
  "1st_half": "1h",
  "2nd_half": "2h",
  "1st_quarter": "1q",
  "2nd_quarter": "2q",
  "3rd_quarter": "3q",
  "4th_quarter": "4q",
  "1st_inning": "1i",
  "2nd_inning": "2i",
  "3rd_inning": "3i",
  "4th_inning": "4i",
  "5th_inning": "5i",
  "6th_inning": "6i",
  "7th_inning": "7i",
  "8th_inning": "8i",
  "9th_inning": "9i",
  "1st_3_innings": "1ix3",
  "1st_5_innings": "1ix5",
  "1st_7_innings": "1ix7",
  // TENNIS SETS. Confirmed from SGO's tennis documentation, which names 1s
  // through 5s explicitly for per-set markets - unlike the half/quarter codes
  // below, these are documented rather than inferred.
  "1st_set": "1s",
  "2nd_set": "2s",
  "3rd_set": "3s",
  "4th_set": "4s",
  "5th_set": "5s",

  // ---- REGULATION (v2.9.0, SOCCER) ----
  //
  // NOT a synonym for full_game, and treating it as one is the single most
  // expensive mistake available in this release. SGO's EPL documentation:
  // "match lines (moneyline, spread, totals) use the `reg` period rather than
  // `game`, because a Premier League result is settled over regulation: the
  // full-match moneyline is points-home-reg-ml-home, while player props stay on
  // game."
  //
  // So one soccer event carries markets on BOTH periods, split by market kind, and
  // asking for the wrong one returns no market rather than an error. Callers do not
  // choose this by hand: constants.ts exports matchLinePeriodFor(sport), and every
  // match-line path routes through it.
  regulation: "reg",

  // ---- UFC ROUNDS ----
  //
  // Documented periodIDs, quoted from SGO's periodID table: "1r | 1st Round"
  // through "5r | 5th Round". Five is the real ceiling - championship and
  // main-event fights go five rounds, everything else goes three - and asking for
  // 4r on a three-round fight correctly returns no market rather than an error.
  //
  // THE "OPENING ROUNDS" GROUPED MARKET IS DELIBERATELY ABSENT. SGO's UFC page
  // refers to it in prose and never prints its code, and no documented periodID has
  // that shape. Inventing one (1rx2? 1rx3?) would produce silent empty results,
  // which is precisely the failure this file's own warning block is about.
  "1st_round": "1r",
  "2nd_round": "2r",
  "3rd_round": "3r",
  "4th_round": "4r",
  "5th_round": "5r",

  // ---- SOCCER OVERTIME PERIODS ----
  //
  // Documented ("et | Extra Time", "ps | Penalty Shootout") and only reachable in a
  // knockout tie, never in league play. Present so a UCL knockout round can address
  // them; no tool offers them in its period list yet, because nothing in the docs
  // binds specific markets to them and this connector does not guess coverage.
  extra_time: "et",
  penalty_shootout: "ps",
};

/**
 * RESOLVED IN v2.9.0. The codes above are no longer inferred: SGO publishes a
 * periodID table on its markets page, and every code in this map now matches it
 * exactly - game, reg, 1h, 2h, 1q-4q, 1i-9i, 1s-5s, 1r-5r, et, ps, 1ix3/1ix5/1ix7.
 *
 * ONE CONTRADICTION IN THEIR OWN DOCS, WORTH RECORDING. SGO's glossary page writes
 * the half and quarter codes REVERSED, as "h1" and "q1", in prose. The data-types
 * markets table, the odds page, the cheat sheet and both the EPL and NCAAB league
 * pages all write "1h" and "1q". Four sources against one, and the four include the
 * machine-readable table, so 1h/1q is what this map uses. If a half market ever
 * comes back empty across several sports at once, that is the first thing to retest.
 *
 * ALSO NOTED: SGO says "the 1ix5 periodID (1st 5 Innings) is being deprecated in
 * favor of 1h (1st Half) for Baseball". 1ix5 still resolves today and is left in
 * place, but MLB first-half markets should be built on 1h going forward.
 */

export function buildOddID(params: {
  statID: string;
  entity: string; // playerID, "home", "away", or "all"
  period: keyof typeof PERIOD_CODES;
  betType: "ou" | "yn" | "ml" | "sp" | "ml3way";
  side: string; // "over" | "under" | "yes" | "no" | "home" | "away" | "draw"
}): string {
  const periodCode = PERIOD_CODES[params.period];
  if (!periodCode) {
    throw new Error(
      `Unknown period "${params.period}". Valid options: ${Object.keys(PERIOD_CODES).join(", ")}`
    );
  }
  return `${params.statID}-${params.entity}-${periodCode}-${params.betType}-${params.side}`;
}
