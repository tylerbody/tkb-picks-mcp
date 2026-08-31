import type { BDLStanding, NormalizedStanding, BDLTeam } from "../types.js";

/**
 * STANDINGS NORMALIZER.
 *
 * THE PROBLEM THIS SOLVES (found via live test, 8 Aug 2026): BALLDONTLIE does not
 * use a shared standings schema across sports. The same information is returned
 * under different keys per league:
 *
 *   Meaning          NFL                  MLB
 *   -------          ---                  ---
 *   overall record   overall_record       total
 *   home record      home_record          home
 *   road record      road_record          road
 *   division record  division_record      intra_division
 *   conference       conference_record    intra_league
 *   streak           win_streak           streak
 *
 * The splits tool originally read only the NFL names. Against MLB every lookup
 * missed, the standings path was treated as unavailable, and every home/road
 * query silently fell back to tallying up to 100 finalized SGO events - the
 * expensive path this was specifically built to avoid. Correct answers, wrong
 * cost, and no point differential.
 *
 * Rather than branch on sport (which breaks again the moment NBA or NHL is added
 * with a third naming convention), every known alias is checked in order and the
 * first present value wins. Unknown sports degrade to nulls rather than throwing.
 *
 * MLB additionally exposes home_wins/home_losses as real numbers, which is
 * preferred over parsing a "44-37" string when available.
 */

function parseRecord(rec: string | undefined): { wins: number; losses: number } | null {
  if (!rec || typeof rec !== "string") return null;
  const parts = rec.split("-").map((n) => parseInt(n.trim(), 10));
  if (!Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null;
  return { wins: parts[0], losses: parts[1] };
}

function firstDefined<T>(...vals: (T | undefined | null)[]): T | null {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

/**
 * Compose "W-L" ONLY when both halves are real numbers.
 *
 * THE BUG THIS FIXES, found live 2026-08-27 the first time tkb_get_standings ran
 * against NCAAF. The overall record was built with:
 *
 *   s.wins !== undefined && s.losses !== undefined ? `${s.wins}-${s.losses}` : undefined
 *
 * BDL's NCAAF standings return `wins: null` before a season starts, not
 * `undefined`. `null !== undefined` is TRUE, so the guard passed and the template
 * interpolated the null, producing the string **"null-0"** on all 17 ACC rows.
 *
 * That is not a cosmetic defect. It is a fully-populated, plausible-shaped,
 * completely wrong value of exactly the kind this connector exists to prevent -
 * and unlike a missing field it would have printed the literal word "null" into a
 * published thread.
 *
 * The rest of this file already used firstDefined(), which rejects null properly.
 * This one call site hand-rolled its own check and got it wrong, which is the
 * argument for having the helper in the first place.
 */
function composeRecord(wins: unknown, losses: unknown): string | undefined {
  return typeof wins === "number" && typeof losses === "number"
    ? `${wins}-${losses}`
    : undefined;
}

export function teamDisplayName(t: BDLTeam | undefined): string {
  if (!t) return "unknown";
  return (
    (t as { full_name?: string }).full_name ??
    t.display_name ??
    [t.location, t.name].filter(Boolean).join(" ") ??
    t.abbreviation ??
    "unknown"
  );
}

export function normalizeStanding(s: BDLStanding): NormalizedStanding {
  // THIRD NAMING VARIANT, found live 2026-08-27. This file's own header documents
  // NFL (`road_record`) versus MLB (`road`) and says the fix is to check every
  // known alias rather than branch on sport. NCAAF then arrived with `away_record`
  // and nulled the road column on every CFB row - silently, because a null road
  // record is indistinguishable from "this sport does not report it".
  //
  // Adding the alias here rather than special-casing CFB in the tool is the same
  // reasoning as before: a fourth variant should be a one-line addition, not an
  // audit.
  const homeStr = firstDefined(s.home_record, s.home);
  const roadStr = firstDefined(s.road_record, s.away_record, s.road, s.away);
  const homeParsed = parseRecord(homeStr ?? undefined);
  const roadParsed = parseRecord(roadStr ?? undefined);

  // Prefer explicit numeric fields (MLB) over parsing a record string.
  const homeWins = firstDefined(s.home_wins, homeParsed?.wins);
  const homeLosses = firstDefined(s.home_losses, homeParsed?.losses);
  const roadWins = firstDefined(s.road_wins, roadParsed?.wins);
  const roadLosses = firstDefined(s.road_losses, roadParsed?.losses);

  return {
    teamName: teamDisplayName(s.team),
    overallRecord: firstDefined(
      s.overall_record,
      s.total,
      composeRecord(s.wins, s.losses)
    ),
    homeRecord:
      homeStr ??
      (homeWins !== null && homeLosses !== null ? `${homeWins}-${homeLosses}` : null),
    roadRecord:
      roadStr ??
      (roadWins !== null && roadLosses !== null ? `${roadWins}-${roadLosses}` : null),
    homeWins,
    homeLosses,
    roadWins,
    roadLosses,
    divisionRecord: firstDefined(s.division_record, s.intra_division),
    conferenceRecord: firstDefined(s.conference_record, s.intra_league),
    lastTen: firstDefined(s.last_ten_games),
    streak: firstDefined(s.win_streak, s.streak),
    pointsFor: firstDefined(s.points_for),
    pointsAgainst: firstDefined(s.points_against),
    pointDifferential: firstDefined(s.point_differential),
    avgPointsFor: firstDefined(s.avg_points_for),
    avgPointsAgainst: firstDefined(s.avg_points_against),
    playoffSeed: firstDefined(s.playoff_seed),
    gamesPlayed: firstDefined(s.games_played),
    season: firstDefined(s.season),
  };
}

/** Normalize a team name for fuzzy matching between SGO and BDL naming. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Find the standings row matching a team name, tolerant of the naming differences
 * between SGO ("Philadelphia Phillies") and BDL (full_name / display_name /
 * location + name / abbreviation).
 */
export function findStandingForTeam(
  rows: BDLStanding[],
  teamName: string
): BDLStanding | undefined {
  const needle = normalizeName(teamName);
  if (!needle) return undefined;

  const candidates = (s: BDLStanding): string[] => {
    const t = s.team ?? ({} as BDLTeam);
    return [
      (t as { full_name?: string }).full_name,
      t.display_name,
      (t as { short_display_name?: string }).short_display_name,
      t.name,
      t.location,
      t.abbreviation,
      [t.location, t.name].filter(Boolean).join(" "),
      (s as { team_name?: string }).team_name,
    ]
      .filter(Boolean)
      .map((n) => normalizeName(String(n)));
  };

  // Exact match first - avoids "Chicago White Sox" matching "Chicago Cubs" on location.
  const exact = rows.find((s) => candidates(s).some((c) => c === needle));
  if (exact) return exact;

  // Then containment, longest candidate first so the most specific name wins.
  return rows.find((s) =>
    candidates(s)
      .sort((a, b) => b.length - a.length)
      .some((c) => c.length >= 4 && (c.includes(needle) || needle.includes(c)))
  );
}
