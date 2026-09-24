import type { NhlGameLogEntry } from "./nhlStatsClient.js";

/**
 * MAPPING SGO statIDs ONTO THE NHL'S OWN GAME-LOG SHAPE.
 *
 * ============================================================================
 * THE ONE THING TO READ BEFORE TOUCHING THIS FILE
 * ============================================================================
 *
 * `points` EXISTS IN BOTH VOCABULARIES AND MEANS DIFFERENT THINGS.
 *
 *   SGO      `points`         "Goals scored"                        -> goals only
 *   SGO      `goals+assists`  "Hockey Points. Sum of goals ... "    -> what a bettor
 *                                                                      calls points
 *   NHL API  `goals`          goals
 *   NHL API  `points`         goals + assists
 *
 * So the crossover is:
 *
 *   SGO points        -> NHL goals
 *   SGO goals+assists -> NHL points
 *
 * Both SGO strings are quoted from their stats page. Both NHL fields were read off a
 * live game log on 2026-09-24. Wire these across by NAME and every player-points prop
 * in the connector grades against goals alone, which is right roughly 40% of the time
 * by accident - the worst possible failure rate, because it looks like noise rather
 * than a bug.
 *
 * This file is the ONLY place the crossover is written down. Nothing else in the
 * repo is permitted to map a hockey stat by hand.
 *
 * ============================================================================
 * WHAT THE GAME LOG CANNOT SERVE, AND WHY THAT IS A REFUSAL
 * ============================================================================
 *
 * The one-request game log is why NHL hit rates are the cheapest in this connector.
 * It is also incomplete. Measured on a live skater log, these fields are ABSENT:
 *
 *   hits            no field
 *   blockedShots    no field
 *   faceoffs        no field
 *
 * They exist on the per-game BOX SCORE, so a hits hit rate is buildable at the cost of
 * one HTTP request PER GAME - ten requests for a "last 10" instead of one. That is a
 * real design decision rather than an oversight, and it was made in favour of refusing:
 * this connector's rule since v2.7.0 is that a path REFUSES rather than degrades, and
 * the honest refusal names the box-score route so whoever wants it knows the price.
 *
 * NAMED REFUSAL, NOT SILENCE. `blocks` and `hits` are in the OU prop catalog because
 * SGO prices them and a thread can quote the line. Asking for a RATE on one produces a
 * message saying the source lacks the field, never an empty result that reads as "he
 * has not done it".
 *
 * ============================================================================
 * SHOTS: THE SECOND NAME COLLISION, MILDER BUT REAL
 * ============================================================================
 *
 * The NHL game log's `shots` field is the official S column, which is SHOTS ON GOAL.
 * SGO has two separate statIDs:
 *
 *   `shots_onGoal`  "Shots which were not blocked ... and did not miss the goal"
 *   `shots`         "Total shots taken"
 *
 * So SGO `shots_onGoal` maps to NHL `shots`, and SGO `shots` - attempts including
 * misses and blocks - has NO game-log equivalent and is refused. Mapping SGO `shots`
 * to NHL `shots` because the words match would overstate a shots-on-goal prop by every
 * attempt that missed the net.
 *
 * ============================================================================
 * GOALIE SAVES ARE DERIVED, AND SAYING SO MATTERS
 * ============================================================================
 *
 * A goalie's log carries `shotsAgainst` and `goalsAgainst` and NO `saves` field.
 * nhlStatsClient derives saves as shotsAgainst minus goalsAgainst, which is exact
 * arithmetic rather than an estimate - every shot against is saved or a goal - and
 * emits it only when both inputs are present. `matchedField` below reports it as
 * derived so a reader can see where the number came from.
 */

export type NhlStatLookup =
  | { kind: "value"; value: number; matchedField: string }
  | { kind: "stat_not_mapped"; note: string }
  | { kind: "field_absent"; note: string };

/**
 * SGO statID -> candidate NHL game-log field names, checked in order.
 *
 * Candidate ARRAYS rather than single strings, the same shape bdlStatMap, cfbdStatMap
 * and cbbdStatMap use, and it matters more here than anywhere else in the repo: these
 * paths are undocumented. There is no spec to consult if the league renames a field,
 * so a second candidate degrades to the next name rather than to a silent absence.
 * Add to an array, never replace it.
 */
const NHL_STAT_FIELDS: Record<string, string[]> = {
  // ---- THE CROSSOVER. See the header. Do not "fix" these to match by name. ----
  /** SGO `points` is GOALS in hockey. */
  points: ["goals"],
  /** SGO `goals+assists` is the bettor's "points". NHL spells that `points`. */
  "goals+assists": ["points"],

  assists: ["assists"],

  /** The NHL's `shots` IS shots on goal. SGO's bare `shots` is not, and is unmapped. */
  shots_onGoal: ["shots"],

  penaltyMinutes: ["pim"],
  plusMinus: ["plusMinus"],

  powerPlay_goals: ["powerPlayGoals"],
  /** The league publishes PP points directly, so this needs no derivation. */
  "powerPlay_goals+assists": ["powerPlayPoints"],

  /** Derived in nhlStatsClient from shotsAgainst minus goalsAgainst. */
  goalie_saves: ["saves"],
};

/**
 * STATS SGO PRICES THAT THIS SOURCE CANNOT COUNT, with the reason for each.
 *
 * Listed explicitly rather than falling through to a generic "not mapped", because
 * "the game log has no such field, the box score does, here is the cost" is actionable
 * and "unsupported stat" is not.
 */
const NHL_UNAVAILABLE: Record<string, string> = {
  hits:
    "The NHL game log carries no `hits` field. It exists on the per-game BOX SCORE " +
    "(`playerByGameStats...hits`), so a hits rate is buildable at one HTTP request PER " +
    "GAME instead of one per player, and that trade was deliberately not taken. Quote " +
    "the posted line and reason from research rather than a counted rate.",
  blocks:
    "The NHL game log carries no blocked-shots field. Same position as hits: it is on " +
    "the per-game box score as `blockedShots`, which costs one request per game. Note " +
    "also that SGO's `blocks` is shots the player BLOCKED, while `shots_blocked` is the " +
    "player's own shots that GOT blocked - opposite directions, easy to confuse.",
  shots:
    "SGO's bare `shots` is TOTAL SHOTS TAKEN, including attempts that missed the net or " +
    "were blocked. The NHL game log's `shots` field is the official S column, which is " +
    "shots ON GOAL, so mapping one to the other would overstate the count. Use " +
    "`shots_onGoal` for the shots prop books actually post.",
  shots_blocked:
    "SGO's `shots_blocked` is the player's OWN shots that an opponent blocked. The NHL " +
    "publishes no such per-player field on either the game log or the box score.",
  faceOffs_won:
    "The game log carries no faceoff counts, and the box score reports " +
    "`faceoffWinningPctg` - a PERCENTAGE, not the wins-and-losses count a faceoffs-won " +
    "line settles on. A count cannot be recovered from a percentage without the " +
    "attempts, which are not published per game.",
  powerPlay_assists:
    "The game log publishes `powerPlayGoals` and `powerPlayPoints` but not power-play " +
    "assists. Subtracting goals from points would produce them, and that derivation is " +
    "deliberately NOT done here: both inputs are rounded counts of different events and " +
    "the connector's rule on combined stats is all-or-nothing from published fields.",
  fantasyScore:
    "Fantasy scoring is a book-specific formula rather than a league stat, and every " +
    "operator weights it differently. There is nothing to count.",
};

export function isNhlStatSupported(statID: string): boolean {
  return statID in NHL_STAT_FIELDS;
}

export function supportedNhlStatIDs(): string[] {
  return Object.keys(NHL_STAT_FIELDS).sort();
}

/** The reason a priced hockey market has no countable rate, or null if it does. */
export function nhlStatUnavailableReason(statID: string): string | null {
  return NHL_UNAVAILABLE[statID] ?? null;
}

/**
 * PURE. Read one stat off one game-log row.
 *
 * NEVER RETURNS A BARE NUMBER, for the reason cbbdStatMap states: this repo has
 * shipped the absent-read-as-zero bug twice, and both times it was invisible because
 * zero is a legal value for every one of these markets. A goalless night and a missing
 * field must not be the same value.
 */
export function lookupNhlStat(entry: NhlGameLogEntry, statID: string): NhlStatLookup {
  const fields = NHL_STAT_FIELDS[statID];
  if (!fields) {
    const reason = nhlStatUnavailableReason(statID);
    return {
      kind: "stat_not_mapped",
      note:
        reason ??
        `"${statID}" is not mapped to an NHL game-log field. Mapped stats: ${supportedNhlStatIDs().join(", ")}.`,
    };
  }

  for (const field of fields) {
    const v = entry.stats[field];
    if (typeof v === "number" && Number.isFinite(v)) {
      return {
        kind: "value",
        value: v,
        matchedField: field === "saves" ? "saves (derived: shotsAgainst - goalsAgainst)" : field,
      };
    }
  }

  return {
    kind: "field_absent",
    note:
      `Game ${entry.gameId} on ${entry.gameDate || "an unknown date"} carries no value for ` +
      `"${statID}" (looked for ${fields.join(", ")}). Treated as an ABSENT field rather than a ` +
      `zero, because zero is a legal result for this market and the two must not be conflated.`,
  };
}
