/**
 * MAPPING SGO statIDs ONTO CollegeBasketballData's BOX SCORE SHAPE.
 *
 * ============================================================================
 * THIS IS NOT THE CFBD MAPPER WITH THE WORDS CHANGED
 * ============================================================================
 *
 * CollegeBasketballData is CollegeFootballData's sibling - same organisation, same
 * Bearer auth, same shared account quota - which makes it tempting to assume the
 * same response shape. It is NOT the same shape, and the differences are exactly
 * the kind that produce silent wrong numbers:
 *
 *   CollegeFootballData   game -> teams[] -> categories[] -> types[] -> athletes[]
 *                         stats are STRINGS, some compound ("24/35")
 *                         a type name like "YDS" is ambiguous across categories
 *
 *   CollegeBasketballData one row PER TEAM PER GAME -> players[]
 *                         stats are NUMBERS OR NULL, never strings
 *                         shooting and rebounding are NESTED OBJECTS
 *
 * So there is no category/type pair to disambiguate here, and no string parsing.
 * What there IS instead is a nesting problem: three of the most-posted college
 * markets - threes made, offensive rebounds, total rebounds - do not exist as
 * top-level fields at all.
 *
 *   NOT `threePointFieldGoalsMade`   BUT `threePointFieldGoals.made`
 *   NOT `rebounds` as a number       BUT `rebounds.total`
 *   NOT `offensiveRebounds`          BUT `rebounds.offensive`
 *
 * A mapper that read `row.rebounds` as a number would get an OBJECT, and anything
 * that then coerced it would produce NaN or, worse, a truthy value that survives a
 * `!= null` check and lands in a hit rate as garbage.
 *
 * ============================================================================
 * NULL IS NOT ZERO, AND HERE IT IS EXPLICITLY MODELLED
 * ============================================================================
 *
 * Every stat field on a CBBD player row is `number | null`. The API's own source
 * converts DB values with `x !== null ? Number(x) : null`, so a null is a real,
 * intended null rather than a missing key.
 *
 * This connector has shipped the null-read-as-zero bug twice (v2.0.1, v2.6.6) and
 * both times it was invisible, because a zero is a legal value for every one of
 * these markets. So this file returns a discriminated result and NEVER a bare
 * number, exactly as cfbdStatMap and bdlStatMap do.
 *
 * ============================================================================
 * WHO IS EVEN IN THE ARRAY
 * ============================================================================
 *
 * CBBD's `/games/players` service filters on `gamePlayerStats.minutes is not null`,
 * so a player who did not play is ABSENT from `players[]` rather than present with
 * zeros. That is a genuinely better shape than CFBD's, where absence from a
 * category means "recorded nothing" and cannot be told apart from "did not dress".
 *
 * It means a CBB availability flag can be honest in a way the CFB one cannot:
 * present in the array means he played, and `minutes` says how much.
 */

/** One player's row as CBBD returns it. Every stat is number | null by contract. */
export interface CbbdPlayerRow {
  athleteId: number;
  athleteSourceId?: string;
  name: string;
  position?: string;
  starter?: boolean | null;
  ejected?: boolean | null;
  minutes?: number | null;
  points?: number | null;
  assists?: number | null;
  steals?: number | null;
  blocks?: number | null;
  turnovers?: number | null;
  fouls?: number | null;
  fieldGoals?: { made?: number | null; attempted?: number | null; pct?: number | null } | null;
  twoPointFieldGoals?: { made?: number | null; attempted?: number | null; pct?: number | null } | null;
  threePointFieldGoals?: { made?: number | null; attempted?: number | null; pct?: number | null } | null;
  freeThrows?: { made?: number | null; attempted?: number | null; pct?: number | null } | null;
  rebounds?: { offensive?: number | null; defensive?: number | null; total?: number | null } | null;
}

export type CbbdStatLookup =
  | { kind: "value"; value: number; matchedField: string }
  | { kind: "stat_not_mapped"; note: string }
  | { kind: "field_absent"; note: string };

/**
 * SGO statID -> a path into a CBBD player row.
 *
 * CANDIDATE PATHS, CHECKED IN ORDER, for the reason bdlStatMap and cfbdStatMap use
 * the same shape: a provider that renames a field later should degrade to the next
 * candidate rather than to a silent null. Add to an array, never replace it.
 *
 * SGO's basketball statID namespace is SHARED across NBA, WNBA and NCAAB - their
 * stats page lists basketball once, not per league - so these keys are the same
 * strings the WNBA path already uses.
 */
const CBBD_STAT_PATHS: Record<string, string[][]> = {
  points: [["points"]],
  assists: [["assists"]],
  steals: [["steals"]],
  blocks: [["blocks"]],
  turnovers: [["turnovers"]],
  fouls: [["fouls"]],
  minutesPlayed: [["minutes"]],

  // NESTED. The three below are the ones most likely to be written flat by mistake.
  rebounds: [["rebounds", "total"]],
  offensiveRebounds: [["rebounds", "offensive"]],
  defensiveRebounds: [["rebounds", "defensive"]],

  threePointersMade: [["threePointFieldGoals", "made"]],
  threePointersAttempted: [["threePointFieldGoals", "attempted"]],
  fieldGoalsMade: [["fieldGoals", "made"]],
  fieldGoalsAttempted: [["fieldGoals", "attempted"]],
  freeThrowsMade: [["freeThrows", "made"]],
  freeThrowsAttempted: [["freeThrows", "attempted"]],
  twoPointersMade: [["twoPointFieldGoals", "made"]],
  twoPointersAttempted: [["twoPointFieldGoals", "attempted"]],
};

/**
 * COMBINED MARKETS. All-or-nothing, same rule as everywhere else in this repo: a
 * partial sum is a plausible wrong number, which is worse than a refusal.
 */
export const CBBD_COMPONENT_DERIVATIONS: Record<string, string[]> = {
  "points+rebounds": ["points", "rebounds"],
  "points+assists": ["points", "assists"],
  "rebounds+assists": ["rebounds", "assists"],
  "points+rebounds+assists": ["points", "rebounds", "assists"],
  "blocks+steals": ["blocks", "steals"],
};

export function isCbbdStatSupported(statID: string): boolean {
  return statID in CBBD_STAT_PATHS || statID in CBBD_COMPONENT_DERIVATIONS;
}

export function supportedCbbdStatIDs(): string[] {
  return [
    ...Object.keys(CBBD_STAT_PATHS),
    ...Object.keys(CBBD_COMPONENT_DERIVATIONS),
  ].sort();
}

/**
 * Read one path out of a row, refusing anything that is not a finite number.
 *
 * NULL, undefined, a nested object where a number was expected, and NaN all return
 * null. Never 0.
 */
function readPath(row: CbbdPlayerRow, path: string[]): number | null {
  let cursor: unknown = row;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  if (typeof cursor !== "number" || !Number.isFinite(cursor)) return null;
  return cursor;
}

/** Resolve one SGO statID against one CBBD player row. */
export function lookupCbbdStat(row: CbbdPlayerRow, statID: string): CbbdStatLookup {
  const derivation = CBBD_COMPONENT_DERIVATIONS[statID];
  if (derivation) {
    let sum = 0;
    const matched: string[] = [];
    for (const component of derivation) {
      const part = lookupCbbdStat(row, component);
      if (part.kind !== "value") {
        return {
          kind: part.kind === "stat_not_mapped" ? "stat_not_mapped" : "field_absent",
          note:
            `Composite ${statID} refused: component ${component} did not resolve ` +
            `(${part.kind}). A partial sum would be a plausible wrong number.`,
        };
      }
      sum += part.value;
      matched.push(part.matchedField);
    }
    return { kind: "value", value: sum, matchedField: matched.join(" + ") };
  }

  const paths = CBBD_STAT_PATHS[statID];
  if (!paths) {
    return {
      kind: "stat_not_mapped",
      note:
        `"${statID}" has no CollegeBasketballData mapping. Supported: ` +
        `${supportedCbbdStatIDs().join(", ")}. Do NOT substitute a value.`,
    };
  }

  for (const path of paths) {
    const value = readPath(row, path);
    if (value !== null) return { kind: "value", value, matchedField: path.join(".") };
  }

  return {
    kind: "field_absent",
    note:
      `${statID} resolved to null on this row (looked at ${paths
        .map((p) => p.join("."))
        .join(", ")}). CBBD returns null rather than 0 for a stat it does not have, ` +
      `so this is recorded as an absence and NOT as a zero.`,
  };
}
