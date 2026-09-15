import { matchLinePeriodFor, type SportKey } from "../constants.js";

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

/**
 * THE "JUST SHRINK THE RESPONSE" ODDID, PER SPORT.
 *
 * ============================================================================
 * WHY THIS IS A FUNCTION AND NOT A CONSTANT, AND WHAT IT COST TO FIND OUT
 * ============================================================================
 *
 * Ten call sites in this repo pass a single throwaway oddID to SGO for one reason:
 * without it, SGO attaches every market on the event and a response that should be
 * a few kilobytes becomes megabytes. v1.2.0 added it as the fix for a real
 * out-of-memory crash. The string used everywhere was the literal
 * `points-home-game-ml-home`.
 *
 * THAT STRING IS ALSO A FILTER. SGO returns only events that HAVE the requested
 * market, so an oddID no event carries returns NO EVENTS AT ALL.
 *
 * ---------------------------------------------------------------------------
 * THE DOCS DO NOT SAY THIS, AND A DOC AUDIT ON 2026-09-15 NEARLY UNDID THE FIX.
 * ---------------------------------------------------------------------------
 *
 * SGO documents `oddID` as a RESPONSE-SHAPING parameter, grouped with bookmakerID
 * and playerID and described as "An oddID or comma-separated list of oddIDs to
 * include odds for". Nowhere do they say an event with zero matching markets is
 * dropped from `data`. Read the docs alone and you would conclude this parameter
 * cannot affect which events come back.
 *
 * THE MEASUREMENT DISAGREES, and the measurement is what shipped:
 *
 *   tkb_get_schedule sport="epl"  with points-home-game-ml-home   ->  0 events
 *   the same call     sport="epl"  with points-home-reg-ml-home   -> 21 events
 *
 * One parameter changed. Twenty-one Premier League fixtures appeared. Whatever the
 * documentation intends, the observable behaviour is that an event carrying none of
 * the requested markets does not come back.
 *
 * Recorded here so nobody "corrects" this to a hard-coded string on the strength of
 * a doc page. The doc is silent on the case, not contradictory, and silence loses to
 * a reproducible measurement.
 *
 * FOR ACTUAL EVENT-LEVEL FILTERING, SGO documents two dedicated parameters that this
 * connector does not currently use: `oddsAvailable` (events whose markets are open
 * for wagering) and `oddsPresent` (events with any markets at all, open or not).
 * Those are the supported way to ask "which games have a board", and they are a
 * better tool than inferring it from a market probe.
 *
 * Soccer match lines live on the `reg` period, not `game`. So every one of those
 * ten call sites silently excluded EPL and UCL entirely - the schedule tool
 * returned an empty slate for a league playing that week, and v2.9.0's own
 * league-access probe reported those leagues as possibly unentitled.
 *
 * MEASURED LIVE 2026-09-14, on the deployed v2.9.0 build:
 *
 *   tkb_get_schedule sport="epl"                     -> no events
 *   tkb_check_league_access                          -> EPL "nothing either direction"
 *   tkb_get_odds sport="epl" teamName="Arsenal"      -> Brighton vs Arsenal,
 *                                                       points-home-reg-ml-home,
 *                                                       +270 / -340, FanDuel
 *
 * The league was entitled and playing the whole time. The one tool that built its
 * oddID through matchLinePeriodFor found it instantly; the ten that hard-coded
 * `game` could not see it.
 *
 * This is the repo's own recurring lesson in a new costume, recorded in v2.6.0 as
 * "the fixes were correct, the audits were scoped to the file the symptom appeared
 * in". v2.9.0 fixed the period for match lines, in the files where match lines are
 * READ, and did not audit the files where an oddID is used merely to make a
 * response smaller. A narrowing parameter did not look like a market lookup.
 *
 * So it is one exported function now. The next sport whose full-event period is not
 * `game` is a row in matchLinePeriodFor, not another ten-site audit.
 */
export function narrowingOddID(sport: SportKey): string {
  return buildOddID({
    statID: "points",
    entity: "home",
    period: matchLinePeriodFor(sport),
    betType: "ml",
    side: "home",
  });
}

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
