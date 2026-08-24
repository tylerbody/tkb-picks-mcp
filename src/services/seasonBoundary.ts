import type { SportKey } from "../constants.js";

/**
 * Determines which SEASON a given game date belongs to, per sport.
 *
 * WHY THIS EXISTS: tkb_get_player_hit_rate pulls a team's recent finalized games
 * on a rolling ~220-day lookback. Early in a season that window reaches back into
 * the PREVIOUS season, and the tool previously reported those games with no
 * indication of it. A live test on 8 Aug 2026 asked for Drake Maye's passing yards
 * and got back five games dated Jan/Feb 2026 - all from the 2025 season - presented
 * identically to current-season form.
 *
 * That is a real accuracy problem for threads. "Cleared this in 3 of 5" implies
 * current form; "cleared this in 3 of 5 last season" is a different and much weaker
 * claim, and the difference has to be visible to whoever writes the reasoning bullet.
 *
 * ON THE UNDERLYING QUESTION OF WHETHER PRIOR-SEASON DATA IS USABLE AT ALL: for NFL
 * it largely is - published preseason-model work puts year-over-year team predictive
 * correlation around +0.45 to +0.48, the strongest single non-market factor. Preseason
 * GAME results, by contrast, have effectively no predictive value and should never be
 * used. Current-season stats become the better signal around 4 to 6 games in. So the
 * right behavior is not to hide prior-season games, it's to label them clearly and let
 * the thread-writer decide.
 *
 * Season year convention: the year the season STARTED. NFL 2025 season runs Sep 2025
 * through Feb 2026, so a Jan 2026 playoff game belongs to season 2025.
 */

export interface SeasonInfo {
  /** Year the season started. */
  seasonYear: number;
  /** Human label, e.g. "2025 season". */
  label: string;
}

/** Month (0-indexed) in which each sport's season begins. */
const SEASON_START_MONTH: Record<SportKey, number> = {
  mlb: 2, // March
  wnba: 4, // May
  nfl: 7, // August (preseason); regular season September
  cfb: 7, // August
  // TENNIS RUNS ON THE CALENDAR YEAR. The tours open with the Australian swing in
  // January and close in November, so a season never spans a year boundary and
  // the "belongs to the previous season" branch below can never fire for tennis.
  // That is correct, not an oversight.
  atp: 0, // January
  wta: 0, // January
};

export function seasonForDate(sport: SportKey, dateISO: string): SeasonInfo | null {
  const d = new Date(dateISO);
  if (isNaN(d.getTime())) return null;

  const startMonth = SEASON_START_MONTH[sport];
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();

  // If the game falls before this sport's season-start month, it belongs to the
  // season that began in the PREVIOUS calendar year (e.g. an NFL game in January).
  const seasonYear = month < startMonth ? year - 1 : year;

  return { seasonYear, label: `${seasonYear} season` };
}

/** The season currently in progress (or most recently started) for a sport. */
export function currentSeason(sport: SportKey): SeasonInfo {
  const now = new Date().toISOString();
  return seasonForDate(sport, now) ?? { seasonYear: new Date().getUTCFullYear(), label: "current season" };
}

/**
 * Given a set of game dates, summarize which seasons they span and whether any
 * are from a prior season. Used to attach an honest warning to hit-rate output.
 */
export function summarizeSeasons(
  sport: SportKey,
  dates: string[]
): {
  current: number;
  prior: number;
  seasonsRepresented: number[];
  crossesSeasonBoundary: boolean;
  warning: string | null;
} {
  const thisSeason = currentSeason(sport).seasonYear;
  const years: number[] = [];
  let current = 0;
  let prior = 0;

  for (const dateISO of dates) {
    const s = seasonForDate(sport, dateISO);
    if (!s) continue;
    years.push(s.seasonYear);
    if (s.seasonYear === thisSeason) current++;
    else prior++;
  }

  const seasonsRepresented = [...new Set(years)].sort((a, b) => b - a);
  const crossesSeasonBoundary = prior > 0;

  let warning: string | null = null;
  if (prior > 0 && current === 0) {
    warning =
      `EVERY game in this sample is from a PRIOR season (${seasonsRepresented.join(", ")}), not the current ${thisSeason} season. ` +
      `Do NOT write this as current form. If used at all, the reasoning bullet must say "last season" explicitly. ` +
      `Prior-season data is defensible for NFL team/player baselines but is a weaker claim than current-season form, ` +
      `and is materially less reliable where a player changed teams, role, or scheme.`;
  } else if (prior > 0) {
    warning =
      `This sample MIXES seasons: ${current} game(s) from the current ${thisSeason} season and ${prior} from prior season(s) (${seasonsRepresented.join(", ")}). ` +
      `Either report only the current-season count, or state the split explicitly. Do not present the blended number as current form.`;
  }

  return { current, prior, seasonsRepresented, crossesSeasonBoundary, warning };
}
