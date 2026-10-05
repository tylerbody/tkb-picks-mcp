import type { SportKey } from "../constants.js";
import { parseStatValue } from "./espnClient.js";

/**
 * ============================================================================
 * MAPPING SGO statIDs ONTO ESPN'S GAME-LOG COLUMNS
 * ============================================================================
 *
 * THE ONE THING TO READ BEFORE TOUCHING THIS FILE.
 *
 * ESPN's column set DIFFERS BY POSITION, not merely by league, and two NFL column
 * NAMES mean OPPOSITE THINGS depending on which shape you are looking at. Measured
 * live 2026-10-05 across seven shapes:
 *
 *   NFL quarterback   name "sacks"          = sacks TAKEN      (Josh Allen: 3)
 *   NFL defender      name "sacks"          = sacks MADE       (Rousseau: 0)
 *
 *   NFL quarterback   name "interceptions"  = interceptions THROWN
 *   NFL defender      name "interceptions"  = interceptions CAUGHT
 *
 * SGO distinguishes both cleanly - `passing_interceptions` against
 * `defense_interceptions`, and `defense_sacks` with no statID at all for sacks
 * taken. ESPN does not distinguish them.
 *
 * SO "MAP ON `names`, NEVER ON INDEX" IS CORRECT AND STILL NOT ENOUGH. A resolver
 * that says `defense_sacks -> sacks` grades a pass rusher's sack prop against a
 * quarterback's sacks-taken column the moment it is pointed at a QB. That is
 * bug-for-bug the NHL `points` crossover recorded in nhlStatMap.ts, whose comment
 * is worth repeating here because it describes this failure exactly:
 *
 *   "...which is right roughly 40% of the time by accident - the worst possible
 *    failure rate, because it looks like noise rather than a bug."
 *
 * ============================================================================
 * THE FIX: A SHAPE WITNESS, READ OFF THE RESPONSE ITSELF
 * ============================================================================
 *
 * ESPN ships the `names` array WITH EVERY RESPONSE. So the connector reads the
 * labelling from the response rather than from a position table it would have to
 * maintain and keep current as ESPN adds columns.
 *
 * Each ambiguous resolver declares a WITNESS: another column that can only exist in
 * the correct shape. `totalTackles` cannot appear on a quarterback's log;
 * `passingAttempts` cannot appear on a linebacker's.
 *
 * Resolution is three steps and every one of them REFUSES rather than falling
 * through:
 *
 *   1. No resolver for (sport, statID)              -> refuse by name
 *   2. Witness declared but absent from this `names` -> refuse, wrong shape
 *   3. Component name absent from this `names`       -> refuse
 *
 * There is no index fallback anywhere. An index fallback is the whole bug.
 *
 * ============================================================================
 * THE FOUR NFL SHAPES, MEASURED
 * ============================================================================
 *
 *   QB        16 cols  CMP ATT YDS CMP% AVG TD INT LNG SACK RTG QBR CAR YDS AVG TD LNG
 *   Skill     15 cols  REC TGTS YDS AVG TD LNG CAR YDS AVG LNG TD FUM LST FF KB
 *   Defender  17 cols  TOT SOLO AST SACK STF STFYDS FUM LST FF FR KB INT YDS AVG TD LNG PD
 *   Kicker     0 cols  NO DATA. ESPN answers 200 with no rows at all.
 *
 * The kicker result is why every kicking and punting statID below is a refusal
 * rather than a mapping. Measured on Tyler Bass (3917232), season 2025: HTTP 200,
 * `topLevelKeys: ["filters"]`, zero rows. A 200 with no data is precisely the shape
 * that becomes a silent empty hit rate if nothing checks for it.
 *
 * SOCCER HAS TWO SHAPES, also measured:
 *
 *   Outfield  totalGoals goalAssists totalShots shotsOnTarget foulsCommitted
 *             foulsSuffered offsides yellowCards redCards
 *   Keeper    cleanSheet saves goalsConceded totalGoals goalAssists foulsCommitted
 *             foulsSuffered yellowCards redCards
 *
 * Nine columns each, and NOT the same nine.
 *
 * NBA has ONE shape, 14 columns, with `labelsAreUnique: true`. It is the easy one.
 */

/** One ESPN column to read. Several of these summed is a combo prop. */
export interface EspnComponent {
  /** The exact string from ESPN's `names` array. Never a label, never an index. */
  espnName: string;
  /**
   * For a paired "7-18" column, which half to take.
   *
   * NBA FG, 3PT and FT arrive as ONE column holding both numbers, so
   * fieldGoalsMade and fieldGoalsAttempted are two resolvers reading the same
   * column. nhlStatMap has no equivalent concept; this is new here.
   */
  part?: "made" | "attempted";
}

export interface EspnStatResolver {
  statID: string;
  sports: SportKey[];
  /** Summed. Length 1 is the ordinary case. */
  components: EspnComponent[];
  /**
   * A column that must be present in THIS response's `names` for the mapping to be
   * valid. Only set where a name is ambiguous ACROSS SHAPES. Setting it where it is
   * not needed costs a refusal on a log that could have answered.
   */
  witness?: string;
  /** Why the witness exists, printed in the refusal so the reason is never a mystery. */
  witnessReason?: string;
}

const BASKETBALL: SportKey[] = ["nba", "wnba"];
const SOCCER: SportKey[] = ["epl", "ucl"];

/* ---- WITNESS COLUMNS, one per NFL shape ----
 * Chosen because each is unique to its shape across all three measured NFL shapes.
 * If ESPN ever adds `totalTackles` to a QB log these break, which is why the
 * refusal message names the witness rather than hiding it. */
const W_QB = "passingAttempts";
const W_SKILL = "receivingTargets";
const W_DEF = "totalTackles";
const W_KEEPER = "goalsConceded";

export const ESPN_STAT_RESOLVERS: EspnStatResolver[] = [
  /* ===================== NFL: passing, QB shape ===================== */
  { statID: "passing_attempts", sports: ["nfl"], components: [{ espnName: "passingAttempts" }] },
  { statID: "passing_completions", sports: ["nfl"], components: [{ espnName: "completions" }] },
  { statID: "passing_yards", sports: ["nfl"], components: [{ espnName: "passingYards" }] },
  { statID: "passing_touchdowns", sports: ["nfl"], components: [{ espnName: "passingTouchdowns" }] },
  { statID: "passing_longestCompletion", sports: ["nfl"], components: [{ espnName: "longPassing" }] },
  {
    statID: "passing_interceptions",
    sports: ["nfl"],
    components: [{ espnName: "interceptions" }],
    witness: W_QB,
    witnessReason:
      `ESPN uses the name "interceptions" for interceptions THROWN on a quarterback's ` +
      `log and interceptions CAUGHT on a defender's. "${W_QB}" only exists on the ` +
      `passing shape, so it proves this log is a passer's.`,
  },

  /* ===================== NFL: rushing, QB and skill shapes =====================
   * `rushingYards` and friends mean the same thing on both shapes, so no witness.
   * Over-witnessing costs a refusal on a log that could have answered. */
  { statID: "rushing_attempts", sports: ["nfl"], components: [{ espnName: "rushingAttempts" }] },
  { statID: "rushing_yards", sports: ["nfl"], components: [{ espnName: "rushingYards" }] },
  { statID: "rushing_touchdowns", sports: ["nfl"], components: [{ espnName: "rushingTouchdowns" }] },
  { statID: "rushing_longestRush", sports: ["nfl"], components: [{ espnName: "longRushing" }] },

  /* ===================== NFL: receiving, skill shape ===================== */
  { statID: "receiving_receptions", sports: ["nfl"], components: [{ espnName: "receptions" }] },
  { statID: "receiving_targets", sports: ["nfl"], components: [{ espnName: "receivingTargets" }] },
  { statID: "receiving_yards", sports: ["nfl"], components: [{ espnName: "receivingYards" }] },
  { statID: "receiving_touchdowns", sports: ["nfl"], components: [{ espnName: "receivingTouchdowns" }] },
  { statID: "receiving_longestReception", sports: ["nfl"], components: [{ espnName: "longReception" }] },

  /* ===================== NFL: defense, defender shape ===================== */
  { statID: "defense_combinedTackles", sports: ["nfl"], components: [{ espnName: "totalTackles" }] },
  { statID: "defense_soloTackles", sports: ["nfl"], components: [{ espnName: "soloTackles" }] },
  { statID: "defense_assistedTackles", sports: ["nfl"], components: [{ espnName: "assistTackles" }] },
  {
    statID: "defense_sacks",
    sports: ["nfl"],
    components: [{ espnName: "sacks" }],
    witness: W_DEF,
    witnessReason:
      `ESPN uses the name "sacks" for sacks TAKEN on a quarterback's log and sacks ` +
      `MADE on a defender's. "${W_DEF}" only exists on the defensive shape, so it ` +
      `proves this log is a defender's. Without this check a pass rusher's sack prop ` +
      `grades against a quarterback's sacks-taken column.`,
  },
  {
    statID: "defense_interceptions",
    sports: ["nfl"],
    components: [{ espnName: "interceptions" }],
    witness: W_DEF,
    witnessReason:
      `Mirror of passing_interceptions. ESPN's "interceptions" is THROWN on a passer ` +
      `and CAUGHT on a defender; "${W_DEF}" proves which.`,
  },

  /* ===================== NFL: combos =====================
   * Each component must resolve or the whole thing refuses. Never partial: a combo
   * missing one leg is a smaller number that still looks like an answer. */
  {
    statID: "passing+rushing_yards",
    sports: ["nfl"],
    components: [{ espnName: "passingYards" }, { espnName: "rushingYards" }],
    witness: W_QB,
    witnessReason: `Only a passing shape carries both legs of this combo.`,
  },
  {
    statID: "rushing+receiving_yards",
    sports: ["nfl"],
    components: [{ espnName: "rushingYards" }, { espnName: "receivingYards" }],
    witness: W_SKILL,
    witnessReason: `Only the skill-position shape carries receivingYards.`,
  },

  /* ===================== BASKETBALL: one shape, nba and wnba =====================
   * The repo's ONE BASKETBALL STAT NAMESPACE rule applies: nba, wnba and cbb share
   * identical SGO statID spellings, so one resolver set serves the ESPN-backed ones. */
  { statID: "points", sports: BASKETBALL, components: [{ espnName: "points" }] },
  { statID: "rebounds", sports: BASKETBALL, components: [{ espnName: "totalRebounds" }] },
  { statID: "assists", sports: BASKETBALL, components: [{ espnName: "assists" }] },
  { statID: "steals", sports: BASKETBALL, components: [{ espnName: "steals" }] },
  { statID: "blocks", sports: BASKETBALL, components: [{ espnName: "blocks" }] },
  { statID: "turnovers", sports: BASKETBALL, components: [{ espnName: "turnovers" }] },
  { statID: "minutesPlayed", sports: BASKETBALL, components: [{ espnName: "minutes" }] },

  /* Paired columns: ONE ESPN column holds "7-18", so made and attempted are two
   * resolvers over the same name with different `part`. Reading the percentage column
   * beside it instead is the tempting shortcut and it is a RATE, not a count. */
  {
    statID: "fieldGoalsMade",
    sports: BASKETBALL,
    components: [{ espnName: "fieldGoalsMade-fieldGoalsAttempted", part: "made" }],
  },
  {
    statID: "fieldGoalsAttempted",
    sports: BASKETBALL,
    components: [{ espnName: "fieldGoalsMade-fieldGoalsAttempted", part: "attempted" }],
  },
  {
    statID: "threePointersMade",
    sports: BASKETBALL,
    components: [
      { espnName: "threePointFieldGoalsMade-threePointFieldGoalsAttempted", part: "made" },
    ],
  },
  {
    statID: "threePointersAttempted",
    sports: BASKETBALL,
    components: [
      { espnName: "threePointFieldGoalsMade-threePointFieldGoalsAttempted", part: "attempted" },
    ],
  },
  {
    statID: "freeThrowsMade",
    sports: BASKETBALL,
    components: [{ espnName: "freeThrowsMade-freeThrowsAttempted", part: "made" }],
  },
  {
    statID: "freeThrowsAttempted",
    sports: BASKETBALL,
    components: [{ espnName: "freeThrowsMade-freeThrowsAttempted", part: "attempted" }],
  },

  /* Basketball combos. All legs exist on the single shape, so no witness. */
  {
    statID: "points+assists",
    sports: BASKETBALL,
    components: [{ espnName: "points" }, { espnName: "assists" }],
  },
  {
    statID: "points+rebounds",
    sports: BASKETBALL,
    components: [{ espnName: "points" }, { espnName: "totalRebounds" }],
  },
  {
    statID: "rebounds+assists",
    sports: BASKETBALL,
    components: [{ espnName: "totalRebounds" }, { espnName: "assists" }],
  },
  {
    statID: "points+rebounds+assists",
    sports: BASKETBALL,
    components: [
      { espnName: "points" },
      { espnName: "totalRebounds" },
      { espnName: "assists" },
    ],
  },
  {
    statID: "blocks+steals",
    sports: BASKETBALL,
    components: [{ espnName: "blocks" }, { espnName: "steals" }],
  },

  /* ===================== SOCCER: two shapes, epl and ucl ===================== */
  { statID: "assists", sports: SOCCER, components: [{ espnName: "goalAssists" }] },
  { statID: "shots", sports: SOCCER, components: [{ espnName: "totalShots" }] },
  { statID: "shots_onGoal", sports: SOCCER, components: [{ espnName: "shotsOnTarget" }] },
  { statID: "fouls", sports: SOCCER, components: [{ espnName: "foulsCommitted" }] },
  { statID: "foulsDrawn", sports: SOCCER, components: [{ espnName: "foulsSuffered" }] },
  { statID: "offsides", sports: SOCCER, components: [{ espnName: "offsides" }] },
  {
    statID: "goalie_saves",
    sports: SOCCER,
    components: [{ espnName: "saves" }],
    witness: W_KEEPER,
    witnessReason:
      `"saves" exists only on the goalkeeper shape. "${W_KEEPER}" proves the log is a ` +
      `keeper's rather than an outfielder's, where a saves column simply does not exist.`,
  },
  /* `goals+assists` IS SAFE TO MAP and `points` IS NOT, which looks inconsistent and
   * is not. This statID NAMES ITS OWN DEFINITION: goals plus assists. `points` names
   * nothing, and in hockey SGO's `points` means GOALS ONLY (see nhlStatMap.ts). The
   * soccer catalog pairs `points` and `goals+assists` the same way hockey's does,
   * which makes the same crossover likely and unverified. Likely is not measured, so
   * `points` is refused below rather than guessed. */
  {
    statID: "goals+assists",
    sports: SOCCER,
    components: [{ espnName: "totalGoals" }, { espnName: "goalAssists" }],
  },
];

/* ============================================================================
 * NAMED REFUSALS
 * ============================================================================
 *
 * Same rule as nhlStatMap.ts: a statID stays in the OU prop catalog because SGO
 * prices it and a thread can quote the line. Asking for a RATE on one produces a
 * message saying the source lacks the field, NEVER an empty result that reads as
 * "he has not done it".
 */
const REFUSALS: { statIDs: string[]; sports: SportKey[]; reason: string }[] = [
  {
    statIDs: [
      "fieldGoals_made",
      "fieldGoals_longestMade",
      "extraPoints_kicksMade",
      "kicking_totalPoints",
      "punting_numPunts",
      "punting_puntsInside20",
    ],
    sports: ["nfl"],
    reason:
      `ESPN'S GAMELOG IS EMPTY FOR KICKERS AND PUNTERS. Measured 2026-10-05 on Tyler ` +
      `Bass (espnId 3917232, season 2025): HTTP 200, top-level keys ["filters"] only, ` +
      `ZERO game rows. Not a parse failure and not a shape change - ESPN serves no ` +
      `kicking data at this endpoint at all. Use dataSource "sgo" for kicking and ` +
      `punting rates, which costs SGO entities but actually returns numbers.`,
  },
  {
    statIDs: ["touchdowns", "turnovers"],
    sports: ["nfl"],
    reason:
      `AMBIGUOUS DEFINITION, deliberately refused rather than guessed. ESPN carries ` +
      `passingTouchdowns, rushingTouchdowns and receivingTouchdowns as separate ` +
      `columns, and SGO's bare "touchdowns" does not say which it sums - the betting ` +
      `convention for an anytime-TD market excludes passing TDs, but that is a ` +
      `convention and not something SGO documents here. Same for "turnovers" across ` +
      `interceptions and fumblesLost. Ask for rushing_touchdowns or ` +
      `receiving_touchdowns, whose definitions are unambiguous. Resolve SGO's ` +
      `definition against their stats page and this becomes a two-line addition.`,
  },
  {
    statIDs: ["points", "fantasyScore"],
    sports: ["nfl"],
    reason:
      `No per-player source at this endpoint. "points" on an NFL log is a team figure ` +
      `and "fantasyScore" is computed by the book from a scoring system this connector ` +
      `does not hold. Neither is a counted player stat.`,
  },
  {
    statIDs: ["offensiveRebounds"],
    sports: BASKETBALL,
    reason:
      `ESPN'S BASKETBALL GAMELOG CARRIES ONLY "totalRebounds", with no offensive and ` +
      `defensive split. Measured 2026-10-05 across the full 14-column shape. The split ` +
      `exists on the per-game BOX SCORE, which would cost one HTTP request PER GAME ` +
      `instead of one for the whole season - the same trade nhlStatMap refuses for ` +
      `hits and blocked shots, refused here for the same reason.`,
  },
  {
    statIDs: ["fantasyScore"],
    sports: BASKETBALL,
    reason: `Computed by the book from a scoring system this connector does not hold.`,
  },
  {
    statIDs: ["minutesPlayed"],
    sports: SOCCER,
    reason:
      `NO MINUTES COLUMN EXISTS ON EITHER SOCCER SHAPE. Measured 2026-10-05 on an ` +
      `outfielder (Isak) and a goalkeeper (Alisson): nine columns each, no minutes in ` +
      `either.\n\nTHIS IS AN OPERATIONAL WARNING, NOT JUST A MISSING MARKET. Rotation ` +
      `risk is the single biggest hazard in soccer player props, and in a counted rate ` +
      `a 20-minute substitute appearance is indistinguishable from a 90-minute start. ` +
      `So a soccer rate from this source cannot tell you whether the sample is even ` +
      `comparable game to game. Read the team news before posting a soccer prop; do ` +
      `not let a counted rate stand in for it.`,
  },
  {
    statIDs: [
      "clearances",
      "duels_won",
      "interceptions",
      "passes_accurate",
      "shots_blocked",
      "tackles",
      "touches",
    ],
    sports: SOCCER,
    reason:
      `Not present on either measured soccer shape. ESPN's soccer gamelog carries nine ` +
      `columns: goals, assists, shots, shots on target, fouls committed, fouls ` +
      `suffered, offsides, yellow cards, red cards - plus saves, clean sheets and ` +
      `goals conceded for keepers. Defensive and possession detail is not among them.`,
  },
  {
    statIDs: ["points"],
    sports: SOCCER,
    reason:
      `UNVERIFIED CROSSOVER, refused on purpose. In hockey SGO's "points" means GOALS ` +
      `ONLY while the bettor's "points" means goals plus assists, which nhlStatMap.ts ` +
      `documents as a mapping that is "right roughly 40% of the time by accident". The ` +
      `soccer catalog pairs "points" and "goals+assists" the same way hockey's does, ` +
      `so the same crossover is LIKELY and has not been measured. Ask for ` +
      `"goals+assists", which names its own definition and is mapped. Verify SGO's ` +
      `soccer definition of "points" and this becomes a one-line addition.`,
  },
  {
    statIDs: ["fantasyScore"],
    sports: SOCCER,
    reason: `Computed by the book from a scoring system this connector does not hold.`,
  },
];

export function espnStatUnavailableReason(sport: SportKey, statID: string): string | null {
  for (const r of REFUSALS) {
    if (r.sports.includes(sport) && r.statIDs.includes(statID)) return r.reason;
  }
  return null;
}

export function resolveEspnStat(sport: SportKey, statID: string): EspnStatResolver | null {
  return (
    ESPN_STAT_RESOLVERS.find((r) => r.statID === statID && r.sports.includes(sport)) ?? null
  );
}

export function isEspnStatSupported(sport: SportKey, statID: string): boolean {
  return resolveEspnStat(sport, statID) !== null;
}

export function supportedEspnStatIDs(sport: SportKey): string[] {
  return ESPN_STAT_RESOLVERS.filter((r) => r.sports.includes(sport))
    .map((r) => r.statID)
    .sort();
}

export type EspnStatRead =
  | { ok: true; value: number }
  | { ok: false; reason: string; wrongShape?: boolean };

/**
 * Read one mapped stat out of one game row.
 *
 * PURE, and the three refusal paths are the point of the function. `names` is THIS
 * response's own array, which is what makes the mapping self-describing rather than
 * dependent on a position table.
 *
 * `absent` IS NOT ZERO. ESPN writes "-" for a column that does not apply to a game,
 * and parseStatValue returns form "absent" with a null value. Treating that as 0
 * would turn "this stat was not recorded" into "he did none", which is the same class
 * of silent wrong answer as the index fallback. It returns a refusal and the caller
 * decides whether that is a DNP or a coverage gap.
 */
export function readEspnStat(
  resolver: EspnStatResolver,
  names: string[],
  stats: string[]
): EspnStatRead {
  if (resolver.witness && !names.includes(resolver.witness)) {
    return {
      ok: false,
      wrongShape: true,
      reason:
        `This player's ESPN game log is the WRONG SHAPE for "${resolver.statID}". ` +
        `The mapping requires the column "${resolver.witness}" to be present and it ` +
        `is not. ${resolver.witnessReason ?? ""}`.trim(),
    };
  }

  let total = 0;
  for (const c of resolver.components) {
    const idx = names.indexOf(c.espnName);
    if (idx < 0) {
      return {
        ok: false,
        wrongShape: true,
        reason:
          `ESPN column "${c.espnName}" is not present on this player's game log, so ` +
          `"${resolver.statID}" cannot be read. Columns available: ${names.join(", ")}.`,
      };
    }
    const parsed = parseStatValue(stats[idx]);
    const picked =
      c.part === "made"
        ? parsed.made
        : c.part === "attempted"
          ? parsed.attempted
          : parsed.value ?? undefined;

    if (picked === undefined || picked === null || Number.isNaN(picked)) {
      return {
        ok: false,
        reason:
          `ESPN column "${c.espnName}" held ${JSON.stringify(stats[idx])} ` +
          `(parsed as "${parsed.form}")${c.part ? ` and no ${c.part} value could be taken from it` : ""}, ` +
          `so no number is available for "${resolver.statID}" in this game. ` +
          `A missing value is NOT zero and is not substituted.`,
      };
    }
    total += picked;
  }

  return { ok: true, value: total };
}
