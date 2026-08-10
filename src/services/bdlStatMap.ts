import type { SportKey } from "../constants.js";

/**
 * SGO statID -> BALLDONTLIE field mapping.
 *
 * WHY THIS FILE IS SHAPED THIS WAY (candidate arrays, not single field names):
 *
 * This connector has shipped a wrong BALLDONTLIE field assumption twice. The
 * injuries team lookup read `player.team.display_name`, which is correct for MLB
 * and WNBA but absent on NFL, where the field is `full_name`. Both times the
 * failure was SILENT - it returned "unknown" or an empty result that read as a
 * legitimate answer. The eventual fix was to stop guessing one field name and
 * instead check every known shape in order (see resolveTeamName in tools/injuries.ts).
 *
 * Stat fields carry the same risk with worse consequences. A missing field would
 * read as 0, which is indistinguishable from a real 0 hits, and would produce a
 * confident and completely wrong hit rate published to thousands of people.
 *
 * So every stat lists CANDIDATE field names. Resolution walks them in order and
 * reports which one actually matched, and a stat that resolves to nothing returns
 * null (treated as "did not play") rather than 0. The resolver also surfaces which
 * candidate hit, so a wrong-but-present field can be spotted rather than trusted.
 *
 * TOTAL BASES is the one stat that frequently does not exist as a field anywhere.
 * It is computed from the hit components when a direct field is unavailable:
 *   TB = singles + 2*doubles + 3*triples + 4*home runs
 * When singles are not exposed directly (common), singles are derived:
 *   singles = hits - doubles - triples - home runs
 */

/** How a stat value gets pulled off a BDL stat row. */
export interface StatResolver {
  /** SGO statID this maps to. */
  statID: string;
  /** Candidate BDL field names, tried in order. */
  candidates: string[];
  /** Sports this resolver applies to. */
  sports: SportKey[];
  /**
   * Optional derivation when no candidate field exists. Receives the raw row and
   * returns a value, or null when the inputs are not present.
   */
  derive?: (row: Record<string, unknown>) => number | null;
  /** Human label for diagnostics. */
  label: string;
}

function num(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    // BDL sometimes returns numerics as strings (innings pitched, averages).
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

/**
 * Total bases, computed when no direct field exists.
 * Returns null rather than a partial sum if hits or the extra-base components
 * are missing - a half-computed total base count is worse than no answer.
 */
function deriveTotalBases(row: Record<string, unknown>): number | null {
  const hits = num(row, ["hits"]);
  const doubles = num(row, ["doubles"]);
  const triples = num(row, ["triples"]);
  const homeRuns = num(row, ["hr"]);

  if (hits === null || doubles === null || triples === null || homeRuns === null) {
    return null;
  }
  const singles = hits - doubles - triples - homeRuns;
  if (singles < 0) return null; // inconsistent row, do not fabricate
  return singles + 2 * doubles + 3 * triples + 4 * homeRuns;
}

export const STAT_RESOLVERS: StatResolver[] = [
  // ---- MLB batting ----
  {
    statID: "batting_hits",
    label: "Hits",
    sports: ["mlb"],
    candidates: ["hits"],
  },
  {
    statID: "batting_totalBases",
    label: "Total Bases",
    sports: ["mlb"],
    candidates: ["total_bases"],
    derive: deriveTotalBases,
  },
  {
    statID: "batting_RBI",
    label: "Runs Batted In",
    sports: ["mlb"],
    candidates: ["rbi"],
  },
  {
    statID: "batting_homeRuns",
    label: "Home Runs",
    sports: ["mlb"],
    candidates: ["hr"],
  },
  {
    statID: "batting_doubles",
    label: "Doubles",
    sports: ["mlb"],
    candidates: ["doubles"],
  },
  {
    statID: "batting_triples",
    label: "Triples",
    sports: ["mlb"],
    candidates: ["triples"],
  },
  {
    statID: "batting_singles",
    label: "Singles",
    sports: ["mlb"],
    candidates: [],
    derive: (row) => {
      const hits = num(row, ["hits"]);
      const d = num(row, ["doubles"]);
      const t = num(row, ["triples"]);
      const hr = num(row, ["hr"]);
      if (hits === null || d === null || t === null || hr === null) return null;
      const s = hits - d - t - hr;
      return s >= 0 ? s : null;
    },
  },
  {
    statID: "batting_basesOnBalls",
    label: "Walks (batter)",
    sports: ["mlb"],
    candidates: ["bb"],
  },
  {
    statID: "batting_strikeouts",
    label: "Strikeouts (batter)",
    sports: ["mlb"],
    candidates: ["k"],
  },
  {
    statID: "batting_stolenBases",
    label: "Stolen Bases",
    sports: ["mlb"],
    candidates: ["stolen_bases"],
  },

  // ---- MLB pitching ----
  // NOTE: several pitching field names collide with batting ones (strikeouts,
  // hits, walks). BDL returns batting and pitching rows with different field
  // sets, so the pitching-specific candidates are listed first here.
  {
    statID: "pitching_strikeouts",
    label: "Strikeouts (pitcher)",
    sports: ["mlb"],
    // CONFIRMED via live probe 2026-08-10: BDL prefixes pitching counterparts
    // with p_ (p_k, p_hits, p_bb, p_hr, p_runs) precisely because the unprefixed
    // names are the BATTING versions on the same row.
    //
    // "k", "so" and "strikeouts" are DELIBERATELY EXCLUDED here. "k" is the
    // batter strikeout field and is populated on every batting row. Including it
    // as a fallback would let a pitcher-strikeout lookup silently return how many
    // times a hitter struck out - a fully populated, plausible, completely wrong
    // number. That is the exact silent-failure class this file exists to prevent.
    candidates: ["p_k"],
  },
  {
    statID: "pitching_earnedRuns",
    label: "Earned Runs",
    sports: ["mlb"],
    candidates: ["er"],
  },
  {
    statID: "pitching_hits",
    label: "Hits Allowed",
    sports: ["mlb"],
    // p_hits, not hits - "hits" is the batting field on the same row.
    candidates: ["p_hits"],
  },
  {
    statID: "pitching_basesOnBalls",
    label: "Walks (pitcher)",
    sports: ["mlb"],
    // p_bb, not bb - "bb" is the batter walk field on the same row.
    candidates: ["p_bb"],
  },
  {
    statID: "pitching_outs",
    label: "Outs",
    sports: ["mlb"],
    candidates: ["pitching_outs"],
    // Innings pitched is conventionally "6.2" meaning 6 innings + 2 outs, NOT 6.2
    // innings. Multiplying by 3 would be wrong. Parse the decimal as thirds.
    derive: (row) => {
      const ip = num(row, ["ip"]);
      if (ip === null) return null;
      const whole = Math.floor(ip);
      const frac = Math.round((ip - whole) * 10);
      if (frac > 2) return null; // not the expected .0/.1/.2 convention
      return whole * 3 + frac;
    },
  },

  // ---- Shared: runs scored ----
  // SGO uses "points" for the winner-determining stat, which in MLB is runs.
  {
    statID: "points",
    label: "Runs / Points",
    sports: ["mlb"],
    candidates: ["runs"],
  },

  // ---- WNBA ----
  {
    statID: "points",
    label: "Points",
    sports: ["wnba"],
    candidates: ["pts", "points"],
  },
  {
    statID: "rebounds",
    label: "Rebounds",
    sports: ["wnba"],
    candidates: ["reb", "rebounds", "total_rebounds"],
  },
  {
    statID: "assists",
    label: "Assists",
    sports: ["wnba"],
    candidates: ["ast", "assists"],
  },
  {
    statID: "steals",
    label: "Steals",
    sports: ["wnba"],
    candidates: ["stl", "steals"],
  },
  {
    statID: "blocks",
    label: "Blocks",
    sports: ["wnba"],
    candidates: ["blk", "blocks"],
  },
  {
    statID: "threePointersMade",
    label: "Three Pointers Made",
    sports: ["wnba"],
    candidates: ["fg3m", "three_pointers_made", "threes_made", "tpm"],
  },
  {
    statID: "turnovers",
    label: "Turnovers",
    sports: ["wnba"],
    candidates: ["turnover", "turnovers", "to", "tov"],
  },
  {
    statID: "fieldGoalsMade",
    label: "Field Goals Made",
    sports: ["wnba"],
    candidates: ["fgm", "field_goals_made"],
  },
  {
    statID: "freeThrowsMade",
    label: "Free Throws Made",
    sports: ["wnba"],
    candidates: ["ftm", "free_throws_made"],
  },
  {
    statID: "freeThrowsAttempted",
    label: "Free Throws Attempted",
    sports: ["wnba"],
    candidates: ["fta", "free_throws_attempted"],
  },

  // ---- WNBA combo stats ----
  // These CAN be computed here even though the SGO path could not, because the
  // components are all present on one BDL row.
  {
    statID: "points+rebounds",
    label: "Points + Rebounds",
    sports: ["wnba"],
    candidates: [],
    derive: (row) => {
      const p = num(row, ["pts", "points"]);
      const r = num(row, ["reb", "rebounds"]);
      return p === null || r === null ? null : p + r;
    },
  },
  {
    statID: "points+assists",
    label: "Points + Assists",
    sports: ["wnba"],
    candidates: [],
    derive: (row) => {
      const p = num(row, ["pts", "points"]);
      const a = num(row, ["ast", "assists"]);
      return p === null || a === null ? null : p + a;
    },
  },
  {
    statID: "rebounds+assists",
    label: "Rebounds + Assists",
    sports: ["wnba"],
    candidates: [],
    derive: (row) => {
      const r = num(row, ["reb", "rebounds"]);
      const a = num(row, ["ast", "assists"]);
      return r === null || a === null ? null : r + a;
    },
  },
  {
    statID: "points+rebounds+assists",
    label: "Points + Rebounds + Assists",
    sports: ["wnba"],
    candidates: [],
    derive: (row) => {
      const p = num(row, ["pts", "points"]);
      const r = num(row, ["reb", "rebounds"]);
      const a = num(row, ["ast", "assists"]);
      return p === null || r === null || a === null ? null : p + r + a;
    },
  },
  {
    statID: "blocks+steals",
    label: "Blocks + Steals",
    sports: ["wnba"],
    candidates: [],
    derive: (row) => {
      const b = num(row, ["blk", "blocks"]);
      const s = num(row, ["stl", "steals"]);
      return b === null || s === null ? null : b + s;
    },
  },
];

export interface StatResolution {
  value: number | null;
  /** Which BDL field supplied it, or "derived", or null if unresolvable. */
  source: string | null;
}

/**
 * Pull one SGO statID off a BDL stat row.
 *
 * Returns { value: null, source: null } when the stat cannot be resolved at all -
 * the caller MUST treat that as "no data", never as a zero.
 */
export function resolveStat(
  sport: SportKey,
  statID: string,
  row: Record<string, unknown>
): StatResolution {
  const resolver = STAT_RESOLVERS.find(
    (r) => r.statID === statID && r.sports.includes(sport)
  );
  if (!resolver) return { value: null, source: null };

  for (const c of resolver.candidates) {
    const v = num(row, [c]);
    if (v !== null) return { value: v, source: c };
  }

  if (resolver.derive) {
    const derived = resolver.derive(row);
    if (derived !== null) return { value: derived, source: "derived" };
  }

  return { value: null, source: null };
}

/** Every SGO statID this mapping can serve for a sport. */
export function supportedStatIDs(sport: SportKey): string[] {
  return STAT_RESOLVERS.filter((r) => r.sports.includes(sport)).map((r) => r.statID);
}

export function isStatSupported(sport: SportKey, statID: string): boolean {
  return STAT_RESOLVERS.some((r) => r.statID === statID && r.sports.includes(sport));
}
