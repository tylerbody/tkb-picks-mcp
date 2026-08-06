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
};

/**
 * UNVERIFIED: period codes above (1h, 2h, 1q, etc.) are inferred from the single
 * confirmed example we have ("1ix5" for 1st 5 Innings, seen directly in the CSV).
 * The others follow the same apparent abbreviation logic but have not been
 * individually confirmed against a live oddID. Verify a handful of these
 * (e.g. build an oddID for "1st Half Moneyline" and check it resolves) on first
 * live test, and correct any that don't match.
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
