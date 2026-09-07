/**
 * PICK GRADING MATH - pure, exported, no API client anywhere near it.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * The WIN/LOSS comparison lived inline, twice, in tools/gradePicks.ts and
 * tools/gradeSlate.ts. The two copies were byte-identical and both were wrong in
 * the same way, which is this repo's single most repeated failure: "the fixes
 * were correct, the audits were scoped to the file the symptom appeared in"
 * (v2.6.0). Grading logic decides what gets published as a CASHED post and what
 * goes in the tracker, so by the rule v2.6.1 learned and v2.6.3, v2.7.0, v2.8.4
 * and v2.8.5 restated, it is correctness logic and must be assertable without a
 * network. It is now one implementation with tests behind it.
 *
 * ============================================================================
 * WHAT WAS BROKEN: THE SPREAD WAS COMPARED AGAINST A RAW TEAM SCORE
 * ============================================================================
 *
 * Measured live 2026-09-07 on Mississippi State 62, UL Monroe 13 (eventID
 * rMHlsh9uyGQJHnyrq4eo), by asking tkb_grade_slate to grade both sides of the
 * same spread:
 *
 *   UL Monroe +35.5, away  ->  reported WIN, "actual 13"
 *
 * UL Monroe lost by 49. It is a LOSS by 13.5 points, and no reading of the
 * result makes it a win.
 *
 * The cause. For a spread the connector builds oddID `points-<side>-game-sp-<side>`,
 * so statID is `points` and statEntityID is `home` or `away`. SGO's `score` field
 * is the value of THAT statID for THAT entity, which is the team's own points:
 * 62 for the home side, 13 for the away side. The grader then compared that raw
 * score against the spread number as though a spread were a threshold:
 *
 *     result = actual > lineUsed ? "WIN" : "LOSS"     // 13 vs 35.5, 62 vs -35.5
 *
 * A spread is not a threshold. It is a handicap applied to a MARGIN. Comparing a
 * team's point total to it is a category error that happens to return a verdict.
 *
 * The failure is not random, which is why it survived so long. Any home pick
 * against a negative line grades WIN automatically, because a team's score is
 * always greater than a negative number. That is every home favourite, always,
 * regardless of the result. The confirmed flips recorded in
 * `claude/grading-accuracy-guardrails.md` - Rutgers -29.5, Wake Forest -24.5,
 * Yankees -1.5, White Sox +1.5, Dodgers -1.5, Rangers -1.5, Braves -1.5,
 * Orioles -1.5, Royals +1.5, Ole Miss -6.5 - are all this one line.
 *
 * THE FIX DOES NOT USE `odd.score` FOR SPREADS AT ALL. The margin is computed
 * from `event.teams.home.score` and `event.teams.away.score`, which are the same
 * two numbers the moneyline branch has always used correctly. That removes the
 * dependency on an ambiguous field rather than reinterpreting it.
 *
 * ============================================================================
 * WHAT WAS ALSO BROKEN: THE FEED'S LINE ON A SETTLED EVENT IS THE RESULT
 * ============================================================================
 *
 * v2.8.3 established that `bookOverUnder` on a finalized event carries the last
 * LIVE value rather than the close, and stopped reporting it as `closingLine`.
 * It kept using it to GRADE when no `postedLine` was supplied. That half was
 * never re-examined, and it is not survivable.
 *
 * Same event, same call, 2026-09-07:
 *
 *   total over, no postedLine   -> graded against feed line 76.5, actual 75, LOSS
 *   spread home, no postedLine  -> graded against feed line -48.5, actual margin -49
 *
 * The real pre-game total on that game was in the fifties and the real spread was
 * around -35. Note what those two feed numbers actually are: 76.5 against a final
 * of 75 points, and -48.5 against a final margin of 49. On a settled event the
 * feed's line has converged onto the result, half a point away from it. Grading
 * against it is grading the result against itself, and it decides real picks on
 * that half point - the total above was a comfortable OVER win reported as a loss.
 *
 * So a line-based market with no `postedLine` now REFUSES. It does not fall back.
 * This follows the connector's oldest rule: a value that cannot be resolved
 * returns null, never a plausible substitute. The workflow doc already mandates
 * passing `postedLine`; this makes forgetting it loud instead of silent.
 */

export type Verdict = "WIN" | "LOSS" | "PUSH";

import type { StatLookup } from "./hitRateAggregator.js";

/**
 * SPREAD SIGN CONVENTION, stated once and referenced everywhere.
 *
 * `line` is signed FROM THE PICKED SIDE'S PERSPECTIVE, exactly as posted:
 *   -6.5  the picked team is laying 6.5 and must win by 7 or more
 *   +6.5  the picked team is getting 6.5 and may lose by 6 or fewer
 *
 * There is deliberately NO auto-detection of a dropped minus sign. It is not
 * detectable: 6.5 is a valid line for a dog and an unsigned line for a favourite,
 * and the two are indistinguishable as numbers. The feed cannot settle it either,
 * because as shown above its spread on a finalized event has converged onto the
 * final margin and carries no information about what the game opened or closed at.
 *
 * What is possible instead is making a wrong sign VISIBLE, which is the v2.1.0
 * principle: make the wrong reading impossible rather than merely discouraged.
 * Every spread grade returns the final score, the margin, what the pick needed,
 * and the arithmetic that produced the verdict, so a sign error is obvious on the
 * face of the output rather than hidden behind a bare WIN.
 */
export const SPREAD_SIGN_CONVENTION =
  "Spread lines are signed from the PICKED side's perspective, as posted: -6.5 means that team must win by 7+, +6.5 means it may lose by 6 or fewer.";

export interface SpreadGrade {
  result: Verdict;
  /** Picked team's score minus the opponent's. Negative means it lost outright. */
  margin: number;
  /** margin + line. Positive covers, zero pushes, negative does not cover. */
  adjustedMargin: number;
  /** Full arithmetic, so a wrong sign is visible rather than hidden behind a verdict. */
  explanation: string;
}

export function gradeSpread(params: {
  side: "home" | "away";
  homeScore: number;
  awayScore: number;
  line: number;
  pickedName?: string;
  opponentName?: string;
}): SpreadGrade {
  const picked = params.side === "home" ? params.homeScore : params.awayScore;
  const opponent = params.side === "home" ? params.awayScore : params.homeScore;

  const margin = picked - opponent;
  const adjustedMargin = margin + params.line;

  const result: Verdict =
    adjustedMargin > 0 ? "WIN" : adjustedMargin < 0 ? "LOSS" : "PUSH";

  const pickedName = params.pickedName ?? params.side;
  const opponentName = params.opponentName ?? (params.side === "home" ? "away" : "home");

  // Spelled out in words as well as arithmetic. The words are what a human
  // writing a CASHED reply actually reads, and they are what catches a sign error.
  const requirement =
    params.line < 0
      ? `win by more than ${Math.abs(params.line)}`
      : params.line > 0
        ? `lose by less than ${params.line}, or win outright`
        : `win outright`;

  const outcome =
    margin > 0
      ? `won by ${margin}`
      : margin < 0
        ? `lost by ${Math.abs(margin)}`
        : `tied`;

  const signed = params.line >= 0 ? `+${params.line}` : `${params.line}`;

  const explanation =
    `${pickedName} ${signed}: final ${picked}-${opponent} vs ${opponentName}, so ${pickedName} ${outcome}. ` +
    `Needed to ${requirement}. Margin ${margin >= 0 ? "+" : ""}${margin} ${params.line >= 0 ? "+" : "-"} ${Math.abs(params.line)} = ${adjustedMargin} -> ${result}.`;

  return { result, margin, adjustedMargin, explanation };
}

/**
 * Over/under, for game totals and player props alike. `actual` is the settled
 * value of the stat and `line` is the number it is compared against.
 *
 * This half was never broken - the total branch reads statEntityID "all", so
 * `score` really is the combined value, and a player prop reads the playerID, so
 * `score` really is that player's stat. Confirmed 2026-09-07: a 62-13 final
 * graded over 55.5 as a WIN on actual 75. It is centralised here so the spread
 * fix cannot drift away from it, not because it needed changing.
 */
export function gradeOverUnder(params: {
  side: "over" | "under";
  actual: number;
  line: number;
}): Verdict {
  if (params.actual === params.line) return "PUSH";
  if (params.side === "over") return params.actual > params.line ? "WIN" : "LOSS";
  return params.actual < params.line ? "WIN" : "LOSS";
}

/** Moneyline off the two team scores. No line is involved by nature. */
export function gradeMoneyline(params: {
  side: "home" | "away";
  homeScore: number;
  awayScore: number;
}): Verdict {
  const picked = params.side === "home" ? params.homeScore : params.awayScore;
  const other = params.side === "home" ? params.awayScore : params.homeScore;
  return picked > other ? "WIN" : picked < other ? "LOSS" : "PUSH";
}

/**
 * The refusal text for a line-based market with no postedLine. Written once so
 * both graders say the same thing, and written to name the fix rather than just
 * the failure.
 */
export function missingPostedLineRefusal(marketType: string): string {
  return (
    `NOT GRADED - no postedLine was supplied for this ${marketType}. ` +
    `This is a refusal, not a failure. On a FINALIZED event SGO's own line has ` +
    `converged onto the result: measured 2026-09-07, a game that finished 62-13 ` +
    `carried a feed total of 76.5 against 75 actual points and a feed spread of ` +
    `-48.5 against a final margin of 49. Grading against that number compares the ` +
    `result to itself and decides real picks on a half point. Pass postedLine - the ` +
    `line exactly as it was published - and re-run. ` +
    SPREAD_SIGN_CONVENTION
  );
}

/**
 * A SETTLED ZERO ON A PLAYER PROP IS NOT A CONFIRMED ZERO, SO RESOLVE IT.
 *
 * A player who did not play and a player who played and recorded nothing are
 * identical in `odd.score`: both are 0. The difference decides between a WIN on an
 * under and a Void that never had action, and
 * `claude/grading-accuracy-guardrails.md` rule 4 already says all-zeros alone is
 * not evidence of a scratch.
 *
 * The first pass at this flagged every zero and left the check to a human. That is
 * the wrong trade at slate volume: a warning that fires on every quiet night is a
 * warning nobody reads, which is precisely the v2.5.0 argument about the IRREGULAR
 * flag firing on Cam Schlittler. So this ANSWERS the question instead, and only
 * flags the case it genuinely cannot answer.
 *
 * IT DOES NOT INVENT A NEW DISCRIMINATOR. `lookupPlayerStat` in
 * hitRateAggregator.ts already separates a real absence from a missing box score
 * from an unsettled stat, and it derives that from the event rather than assuming a
 * shape - it asks whether the game carries player-keyed results for ANYONE on the
 * roster before concluding anything about one player. That distinction was forced
 * by the Dante Moore case, where twelve started games were reported as twelve DNPs.
 * Grading needs exactly the same three-way answer, so it uses exactly the same
 * function rather than a second one that can drift from it.
 *
 *   value          -> he has a box-score line. The zero is real. Grade it, no flag.
 *   player_absent  -> the game carries lines for others and none for him. A real
 *                     DNP, so the pick had no action: VOID, with the evidence.
 *   stat_unsettled -> he played but this stat has not settled. Not a DNP, not a
 *                     grade either.
 *   no_box_score   -> the provider has nothing for this game. The ONLY case that
 *                     still needs a human, and the only one that flags.
 */
export type PropOutcome =
  | { kind: "graded"; value: number; result: Verdict; note: null }
  | { kind: "void"; value: number | null; result: null; note: string }
  | { kind: "unsettled"; value: null; result: null; note: string }
  | { kind: "unresolved"; value: number | null; result: Verdict | null; note: string };

export function gradePlayerProp(params: {
  lookup: StatLookup;
  /** odd.score, used only when the provider carries no box score for the game. */
  fallbackScore: number | null;
  side: "over" | "under";
  line: number;
  playerLabel: string;
  sport: string;
}): PropOutcome {
  const { lookup, side, line, playerLabel } = params;

  if (lookup.kind === "value") {
    return {
      kind: "graded",
      value: lookup.value,
      result: gradeOverUnder({ side, actual: lookup.value, line }),
      note: null,
    };
  }

  if (lookup.kind === "player_absent") {
    return {
      kind: "void",
      value: null,
      result: null,
      note:
        `VOID - NO ACTION. ${playerLabel} does not appear in this game's box score, while ` +
        `other players on the event roster do. That is a real absence rather than a missing ` +
        `feed: he did not play, so the pick never had action and belongs in the tracker as ` +
        `Void, not as a Hit or a Miss. Had this been graded off the settled value it would ` +
        `have read as a zero, which credits any under.`,
    };
  }

  if (lookup.kind === "stat_unsettled") {
    return {
      kind: "unsettled",
      value: null,
      result: null,
      note:
        `${playerLabel} DID appear in this game, but this particular stat has not settled. ` +
        `Not a DNP and not gradeable. Re-run later, or grade this one from a box score.`,
    };
  }

  // no_box_score. The provider carries no player lines for this game at all, so
  // nothing about any individual can be concluded from their absence.
  const fallback = params.fallbackScore;

  if (fallback === null || Number.isNaN(fallback)) {
    return {
      kind: "unresolved",
      value: null,
      result: null,
      note:
        `No player box score exists for this game at all, and the market carries no settled ` +
        `value either. Nothing can be concluded. Grade from an outside box score.`,
    };
  }

  const result = gradeOverUnder({ side, actual: fallback, line });

  if (fallback !== 0) {
    // A non-zero settled value is self-evidencing: he plainly played.
    return { kind: "graded", value: fallback, result, note: null };
  }

  return {
    kind: "unresolved",
    value: 0,
    result,
    note:
      `PARTICIPATION UNCONFIRMED: ${playerLabel} settled at 0 and this game carries no player ` +
      `box score, so a DNP cannot be ruled out. This is the one case the connector cannot ` +
      `answer for itself. ` +
      (side === "under"
        ? `The UNDER is credited as a WIN on the strength of that zero - if he did not play it is a Void. `
        : `The OVER is a LOSS either way, but if he did not play it is a Void rather than a Miss. `) +
      (params.sport === "mlb"
        ? `Confirm with tkb_get_mlb_matchup for the game date with playerName set.`
        : `Confirm from a published box score.`),
  };
}
