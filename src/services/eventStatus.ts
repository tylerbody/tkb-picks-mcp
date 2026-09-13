import type { SGOEvent } from "../types.js";

/**
 * IS THIS GAME ACTUALLY OVER? Pure, exported, no client anywhere near it.
 *
 * ============================================================================
 * WHY: `finalized: true` IS A REQUEST, NOT A GUARANTEE
 * ============================================================================
 *
 * Measured live 2026-09-12. Pittsburgh @ UCF, eventID sGMmL4WzMWVl5eoshB7N:
 *
 *   tkb_get_schedule  -> status "4th", Pittsburgh 12 UCF 7, game in progress
 *   tkb_grade_pick    -> "final 12-7", Pittsburgh -3.5 graded a confident WIN
 *
 * Same connector, same eventID, same minute, opposite answers. The grader fetches
 * with `finalized: true` and then trusts that the events it got back are final.
 * SGO returned an in-progress game anyway, and nothing downstream looked.
 *
 * The grader's own description promised the opposite: "NOT_FINAL for any event SGO
 * has not finalized" and "unfinished events return NOT_FINAL, never a guess". It
 * was violating its own documented contract, and doing it silently, on a path that
 * publishes results. One UCF score flips that pick.
 *
 * ============================================================================
 * THIS IS NOT ONLY A GRADING BUG. SEVEN CALL SITES TRUST THAT FLAG.
 * ============================================================================
 *
 * `finalized: true` is passed by gradePicks, gradeSlate, screenProps,
 * coverPlayer, splitsAggregator (twice) and hitRateAggregator. Every one of them
 * treats what comes back as a completed game.
 *
 * So the same leak does not just mis-grade a pick. A live game reaching
 * hitRateAggregator contributes a PARTIAL stat line as though it were a finished
 * one: a pitcher three innings into a start counts as a completed outing with
 * three strikeouts. That is the exact "right values, wrong story" failure this
 * connector keeps hitting, and it would be invisible, because a low number in a
 * game log looks like a bad night rather than an unfinished one.
 *
 * The fix therefore goes in `getAllEvents` as well as in the graders, for the
 * reason v1.2.0 put the history cache there and v2.6.0 put request coalescing
 * there: one change that every caller inherits beats six that have to be
 * remembered.
 *
 * ============================================================================
 * TWO DIFFERENT THRESHOLDS, DELIBERATELY
 * ============================================================================
 *
 * These are not the same question and must not share an answer.
 *
 * `isAffirmativelyLive` - used at the CLIENT layer. Drops only events the feed
 * says are in progress. An event whose status is missing or unrecognised is KEPT.
 * Aggregates want every finished game they can get, and silently dropping games
 * on an unrecognised status string would shrink hit-rate samples for a reason
 * nobody could see. Conservative in the direction that preserves data.
 *
 * `assessFinality` - used by the GRADERS. Requires the feed to affirmatively say
 * the game is over. Unknown is NOT final. The asymmetry is the point: grading a
 * live game publishes a wrong result, while refusing a finished one costs a retry.
 * Those are not comparable errors, so they do not get comparable thresholds.
 */

/** The status block SGO puts on an event. Every field is optional in practice. */
interface EventStatusish {
  started?: boolean;
  completed?: boolean;
  cancelled?: boolean;
  ended?: boolean;
  live?: boolean;
  delayed?: boolean;
  displayShort?: string;
  displayLong?: string;
  startsAt?: string;
}

function statusOf(event: SGOEvent): EventStatusish {
  return ((event as unknown as { status?: EventStatusish }).status ?? {}) as EventStatusish;
}

/**
 * Does `displayShort` say the game is over?
 *
 * Observed values on 2026-09-12: "F", "F (OT)" for finished; "1st", "2nd", "4th",
 * "HT" for in progress. Anchored to the start of the string and case-insensitively,
 * so "F", "F/OT" and "Final" all match while "4th" and "HT" do not.
 *
 * Deliberately NOT substring containment. This repo already learned that lesson in
 * v2.8.5, where "Miami" containing "Miami (OH)" would have hidden a wrong-team
 * pick. Here a loose match on "F" would catch a hypothetical "First Half".
 */
function displaySaysFinal(display: string | undefined): boolean {
  if (!display) return false;
  const d = display.trim().toLowerCase();
  return d === "f" || d.startsWith("f ") || d.startsWith("f/") || d.startsWith("final");
}

function displaySaysInProgress(display: string | undefined): boolean {
  if (!display) return false;
  const d = display.trim().toLowerCase();
  if (displaySaysFinal(d)) return false;
  // Quarters and halves (1st, 2nd, 3rd, 4th, HT), innings (T5, B7), OT, and the
  // explicit words. Anything that names a period in progress.
  return (
    /^(1st|2nd|3rd|4th|ht|halftime|ot|[0-9]+(st|nd|rd|th))/.test(d) ||
    /^[tb][0-9]+/.test(d) ||
    d.includes("in progress") ||
    d.includes("live")
  );
}

/**
 * CLIENT-LAYER GUARD. True only when the feed AFFIRMATIVELY says this game is
 * still going. Unknown or absent status returns false, so nothing is dropped on a
 * status string this code does not recognise.
 */
export function isAffirmativelyLive(event: SGOEvent): boolean {
  const s = statusOf(event);
  if (s.completed === true) return false;
  if (s.live === true) return true;
  if (s.started === true && s.ended === false) return true;
  return displaySaysInProgress(s.displayShort);
}

export interface FinalityVerdict {
  /** Safe to grade. Requires the feed to say so, never merely fail to deny it. */
  final: boolean;
  /** Short status label for the caller to echo, e.g. "4th", "F", "unknown". */
  label: string;
  /** Why, in a sentence the reader can act on. Empty when final. */
  reason: string;
}

/**
 * GRADER-LAYER GUARD. Unknown is not final.
 */
export function assessFinality(event: SGOEvent): FinalityVerdict {
  const s = statusOf(event);
  const label = s.displayShort ?? (s.completed === true ? "Final" : "unknown");

  if (s.cancelled === true) {
    return {
      final: false,
      label: label === "unknown" ? "cancelled" : label,
      reason:
        "This event is marked CANCELLED. There is no result to grade and the pick had no action, so it belongs in the tracker as Void rather than as a Hit or a Miss.",
    };
  }

  if (isAffirmativelyLive(event)) {
    return {
      final: false,
      label,
      reason:
        `This game is STILL IN PROGRESS (status "${label}"). The score on the event is the CURRENT score, not a final one, ` +
        `and grading against it publishes a result that one more score can flip. ` +
        `Use tkb_monitor_live_picks for live games - it enforces the over/under asymmetry that a grader cannot - and re-grade once the status reads F.`,
    };
  }

  if (s.completed === true || displaySaysFinal(s.displayShort)) {
    return { final: true, label, reason: "" };
  }

  return {
    final: false,
    label,
    reason:
      `SGO has not marked this event finished (status "${label}"). It was returned by a finalized-only query, but that flag is a ` +
      `REQUEST rather than a guarantee - measured 2026-09-12, an in-progress game came back from one. ` +
      `Unknown is treated as not final here deliberately: grading a live game publishes a wrong result, while waiting costs a retry. ` +
      `Note SGO's own ingest can lag the final whistle by several minutes, so a game that plainly ended will settle shortly.`,
  };
}
