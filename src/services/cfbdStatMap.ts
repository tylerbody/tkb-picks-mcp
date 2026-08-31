import type { CfbdStatLookup } from "../types.js";

/**
 * MAPPING SGO statIDs ONTO CollegeFootballData's BOX SCORE SHAPE.
 *
 * WHY THIS FILE IS DEFENSIVE RATHER THAN A PLAIN TABLE.
 *
 * CFBD's OpenAPI schema pins the STRUCTURE exactly:
 *
 *   GamePlayerStats
 *     id: number                       <- gameId
 *     teams[]
 *       team, conference, homeAway, points
 *       categories[]
 *         name: string                 <- "passing" | "rushing" | "receiving" | ...
 *         types[]
 *           name: string               <- "YDS" | "TD" | "CAR" | "REC" | "C/ATT" | ...
 *           athletes[]
 *             id: string, name: string, stat: string
 *
 * ...and then declares `categories[].name` and `types[].name` as bare `string`
 * with NO enum. So the schema guarantees the nesting and guarantees nothing about
 * the literals, which are exactly the part a mapping depends on.
 *
 * THIS REPO HAS BEEN BURNED BY GUESSED PROVIDER LITERALS THREE TIMES:
 *   - v2.0.1  `p_k` vs `k`: a pitcher-strikeout resolver fell through to the
 *             BATTER strikeout field, which is populated on every row. Fully
 *             populated, plausible, completely wrong.
 *   - v2.0.3  `visitor_team` vs `away_team`: half the log rendered "unknown".
 *   - v2.6.6  `away_record`: a third naming variant for one value, silently null
 *             on every CFB row forever.
 *
 * So this uses the same shape as bdlStatMap: CANDIDATE ARRAYS CHECKED IN ORDER,
 * reporting WHICH literal actually matched, and returning null - never 0 - when
 * nothing resolves. Run tkb_debug_cfbd_stats once after deploy to see the real
 * literals; if one is missing here, add it to the array rather than replacing it,
 * so a provider that changes its mind later still resolves.
 *
 * TWO SPECIFIC HAZARDS THIS SHAPE CREATES.
 *
 * 1. "YDS" IS NOT UNIQUE. It appears under passing, rushing AND receiving. Keying
 *    on the type name alone would be the p_k collision reborn, on a bigger surface:
 *    a receiving-yards prop would silently resolve to a quarterback's passing
 *    yards. EVERY entry here is therefore keyed on the (category, type) PAIR, and
 *    there is no code path that matches a type without its category.
 *
 * 2. `stat` IS A STRING, and some are compound. "C/ATT" arrives as "24/35". A
 *    naive Number() on it yields NaN, and anything that coerces NaN to 0 produces
 *    a confident zero for a quarterback who threw 35 times. Compound fields are
 *    parsed explicitly by index and refuse rather than guess.
 */

/** Which half of a compound "a/b" stat string to read. */
type CompoundPart = "first" | "second";

interface CfbdStatSpec {
  /** Candidate category names, checked in order. Case-insensitive. */
  categories: string[];
  /** Candidate type names within that category, checked in order. Case-insensitive. */
  types: string[];
  /**
   * Set when the provider packs two numbers into one string, e.g. C/ATT = "24/35".
   * Absent means the whole string is the value.
   */
  compound?: CompoundPart;
}

/**
 * SGO statID -> where to find it in a CFBD box score.
 *
 * Only markets this account actually posts are mapped. An unmapped statID returns
 * a clear refusal rather than a substituted number, exactly as bdlStatMap does.
 */
export const CFBD_STAT_MAP: Record<string, CfbdStatSpec> = {
  // ---- PASSING ----
  passing_yards: { categories: ["passing"], types: ["YDS", "yards", "passingYards"] },
  passing_touchdowns: { categories: ["passing"], types: ["TD", "touchdowns"] },
  passing_interceptions: { categories: ["passing"], types: ["INT", "interceptions"] },
  // "C/ATT" is a single string like "24/35". Completions first, attempts second.
  passing_completions: {
    categories: ["passing"],
    types: ["C/ATT", "COMP/ATT", "completions"],
    compound: "first",
  },
  passing_attempts: {
    categories: ["passing"],
    types: ["C/ATT", "COMP/ATT", "attempts"],
    compound: "second",
  },

  // ---- RUSHING ----
  rushing_yards: { categories: ["rushing"], types: ["YDS", "yards", "rushingYards"] },
  rushing_attempts: { categories: ["rushing"], types: ["CAR", "ATT", "carries"] },
  rushing_touchdowns: { categories: ["rushing"], types: ["TD", "touchdowns"] },
  rushing_longestRush: { categories: ["rushing"], types: ["LONG", "long"] },

  // ---- RECEIVING ----
  receiving_yards: { categories: ["receiving"], types: ["YDS", "yards", "receivingYards"] },
  receiving_receptions: { categories: ["receiving"], types: ["REC", "receptions"] },
  receiving_touchdowns: { categories: ["receiving"], types: ["TD", "touchdowns"] },
  receiving_longestReception: { categories: ["receiving"], types: ["LONG", "long"] },
};

/**
 * COMBINED MARKETS, derived from components.
 *
 * Same rule the SGO aggregator uses for composites: a partial sum is worse than no
 * answer, because it looks like a real number. EVERY component must resolve or the
 * whole derivation refuses.
 */
export const CFBD_COMPONENT_DERIVATIONS: Record<string, string[]> = {
  "passing+rushing_yards": ["passing_yards", "rushing_yards"],
  "rushing+receiving_yards": ["rushing_yards", "receiving_yards"],
};

export function isCfbdStatSupported(statID: string): boolean {
  return statID in CFBD_STAT_MAP || statID in CFBD_COMPONENT_DERIVATIONS;
}

export function supportedCfbdStatIDs(): string[] {
  return [
    ...Object.keys(CFBD_STAT_MAP),
    ...Object.keys(CFBD_COMPONENT_DERIVATIONS),
  ].sort();
}

/** Case- and whitespace-insensitive match, so "Passing" and "passing" both resolve. */
function norm(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * Parse a CFBD stat string into a number.
 *
 * RETURNS null, NEVER 0, on anything it cannot read. A missing or unparseable
 * field reading as zero is indistinguishable from a real zero, which is this
 * connector's single most repeated failure mode.
 *
 * Handles: plain integers, decimals, thousands separators, a leading "+", and
 * compound "a/b" pairs. Refuses empty strings, "-", "--" and anything else.
 */
export function parseCfbdStat(raw: string, compound?: CompoundPart): number | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (text === "" || text === "-" || text === "--") return null;

  if (compound) {
    const parts = text.split("/");
    // A compound field that is not actually compound is a shape change, not a
    // value. Refuse rather than treat the whole string as one of its halves.
    if (parts.length !== 2) return null;
    text = (compound === "first" ? parts[0] : parts[1]).trim();
  }

  const cleaned = text.replace(/,/g, "").replace(/^\+/, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** One athlete row as CFBD returns it. */
export interface CfbdAthlete {
  id: string;
  name: string;
  stat: string;
}

/** One (category, type) slice of a team's box score. */
export interface CfbdCategory {
  name: string;
  types: { name: string; athletes: CfbdAthlete[] }[];
}

/**
 * Resolve one stat for one player out of a team's categories.
 *
 * REPORTS WHICH LITERAL MATCHED (`matchedCategory` / `matchedType`) for the same
 * reason bdlStatMap does: when a mapping is wrong, the difference between a silent
 * null and "I looked for passing/YDS and the box score offered passing/yards" is
 * the difference between a debugging cycle and a one-line fix.
 */
export function lookupCfbdStat(
  categories: CfbdCategory[],
  playerId: string,
  statID: string
): CfbdStatLookup {
  const derivation = CFBD_COMPONENT_DERIVATIONS[statID];
  if (derivation) {
    let sum = 0;
    const matched: string[] = [];
    for (const component of derivation) {
      const part = lookupCfbdStat(categories, playerId, component);
      // ALL OR NOTHING. A partial sum is a plausible wrong number.
      if (part.kind !== "value") {
        return {
          kind: part.kind,
          note:
            `Composite ${statID} refused: component ${component} did not resolve ` +
            `(${part.kind}). A partial sum would be a plausible wrong number.`,
        };
      }
      sum += part.value;
      matched.push(`${part.matchedCategory}/${part.matchedType}`);
    }
    return {
      kind: "value",
      value: sum,
      matchedCategory: "derived",
      matchedType: matched.join(" + "),
    };
  }

  const spec = CFBD_STAT_MAP[statID];
  if (!spec) {
    return {
      kind: "stat_not_mapped",
      note:
        `"${statID}" has no CollegeFootballData mapping. Supported: ` +
        `${supportedCfbdStatIDs().join(", ")}. Do NOT substitute a value.`,
    };
  }

  // MATCH ON THE PAIR, NEVER THE TYPE ALONE. "YDS" lives under passing, rushing
  // and receiving; a type-only match would resolve a receiver's prop to a
  // quarterback's passing yards.
  for (const wantCategory of spec.categories) {
    const category = categories.find((c) => norm(c.name) === norm(wantCategory));
    if (!category) continue;

    for (const wantType of spec.types) {
      const type = category.types?.find((t) => norm(t.name) === norm(wantType));
      if (!type) continue;

      const athlete = type.athletes?.find((a) => a.id === playerId);
      // The category and type exist but this player is not listed under them.
      // That is a genuine absence from this slice, not a mapping failure.
      if (!athlete) continue;

      const value = parseCfbdStat(athlete.stat, spec.compound);
      if (value === null) {
        return {
          kind: "unparseable",
          note:
            `Found ${category.name}/${type.name} for player ${playerId} but could ` +
            `not read "${athlete.stat}" as a number` +
            `${spec.compound ? ` (expected a compound "a/b" value)` : ""}. ` +
            `Returning null rather than 0.`,
        };
      }
      return {
        kind: "value",
        value,
        matchedCategory: category.name,
        matchedType: type.name,
      };
    }
  }

  return {
    kind: "player_absent",
    note:
      `No ${spec.categories[0]} entry for player ${playerId} in this box score. ` +
      `Either he did not record this stat, or the category/type literals differ ` +
      `from ${spec.categories.join("|")} / ${spec.types.join("|")}. Run ` +
      `tkb_debug_cfbd_stats to see the literals this provider actually uses.`,
  };
}
