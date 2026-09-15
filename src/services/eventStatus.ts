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
  return (
    d === "f" ||
    d.startsWith("f ") ||
    d.startsWith("f/") ||
    d.startsWith("final") ||
    // SOCCER WRITES "FT", NOT "F". Measured live 2026-09-14 across EPL and UCL:
    // finished matches read "FT" and matches decided in extra time read "F (ET)".
    // The second already matched on the "f " prefix; the first did not match at
    // all, and only graded because SGO also set completed: true on those events.
    //
    // That is a latent trap rather than a live bug, and it is the same trap this
    // file was built around: `completed` is exactly the field SGO was measured
    // LAGGING on 2026-09-12, when an in-progress CFB game came back from a
    // finalized-only query. On a soccer match whose completed flag lags, the status
    // string would be the only remaining evidence the match had ended, and it would
    // have been unreadable. Anchored like every other pattern here, so "FT" matches
    // and a hypothetical "FT Pending" or "First Half" does not.
    d === "ft" ||
    d.startsWith("ft ") ||
    d.startsWith("ft/") ||
    d.startsWith("aet")
  );
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

/* ===========================================================================
 * SECOND SOURCE: WHEN SGO WILL NOT CALL A GAME FINAL BUT SOMEONE ELSE WILL
 * ===========================================================================
 *
 * ADDED v2.8.12, from the same live session that produced `assessFinality`.
 *
 * `assessFinality` has three outcomes, and only one of them is a genuine dead end:
 *
 *   cancelled              -> settled. Void. Nothing to cross-check.
 *   affirmatively live     -> settled. The game IS running. Nothing to cross-check.
 *   status unknown/absent  -> NOT settled. We refused because we could not tell.
 *
 * That third case is the whole reason this exists. SGO's own ingest lags the final
 * whistle, sometimes by many minutes, and during that window a genuinely finished
 * game carries no status this connector can read. The grader refuses, correctly,
 * and the user re-runs it, and re-runs it again. The refusal is right and the
 * experience is bad, and those are different problems.
 *
 * BALLDONTLIE already has a `getGames` endpoint on a key with NO monthly object
 * cap (see the bdlClient header for why hit rates moved there). One request per
 * stuck event is close to free. If a second, independent feed says the game ended,
 * that disagreement is resolvable rather than merely reportable.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS WILL AND WILL NOT DO
 * ---------------------------------------------------------------------------
 *
 * It ONLY ever moves a verdict from "unknown" to "final". It can never:
 *
 *   - overturn `cancelled`, which is affirmative information
 *   - overturn `affirmatively live`, which is also affirmative information
 *   - supply a score. Grading still reads SGO's scores, always.
 *
 * The last one is the important restraint. This is a FINALITY check, not a score
 * source. Two feeds' scores are not interchangeable and mixing them is how you get
 * a result that is internally inconsistent with the event it cites.
 *
 * ---------------------------------------------------------------------------
 * THREE CONDITIONS, ALL REQUIRED
 * ---------------------------------------------------------------------------
 *
 * 1. BOTH teams match. Home to home, away to away, on a normalised name compare.
 *    A single matched team is not a match - CFB alone has Miami (FL) and Miami (OH)
 *    playing on the same Saturday, which is the case v2.8.5 was built around.
 *
 * 2. BDL affirmatively says final. Same anchored matching as `displaySaysFinal`,
 *    never containment, plus BDL's own documented literals. An unrecognised status
 *    string resolves NOTHING. BDL's exact per-sport status vocabulary has NOT been
 *    measured on this account, so this code is written to be useless rather than
 *    wrong when it meets a string it does not know.
 *
 * 3. THE SCORES AGREE with SGO's. This is the guard that makes the whole thing
 *    safe. If SGO is merely lagging its status field, it already has the final
 *    score and the two feeds will agree exactly. If they disagree, then at least
 *    one feed is mid-ingest and grading either one is a coin flip, so the refusal
 *    stands and the disagreement is reported with both scores in it.
 *
 * Any of the three failing leaves the original refusal exactly as it was, with a
 * note appended saying what the second look found. Nothing gets quieter.
 * =========================================================================== */

/** Minimal structural view of BDL's game row. Deliberately not the full type. */
export interface BDLGameish {
  status?: string;
  home_team?: { full_name?: string; display_name?: string; name?: string; abbreviation?: string };
  visitor_team?: { full_name?: string; display_name?: string; name?: string; abbreviation?: string };
  home_team_score?: number;
  visitor_team_score?: number;
}

/**
 * Lowercase, strip diacritics, drop everything that is not a letter or digit.
 *
 * "Miami (FL)" -> "miamifl", "Miami (OH)" -> "miamioh". Still distinct, which is
 * the entire point. bdlClient strips diacritics for player names for the same
 * reason: the feeds disagree about punctuation constantly and agree about letters.
 */
function normalizeTeamName(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function bdlTeamNames(team: BDLGameish["home_team"]): string[] {
  if (!team) return [];
  return [team.full_name, team.display_name, team.name]
    .map(normalizeTeamName)
    .filter((n) => n.length > 0);
}

/**
 * Does this BDL row describe the same game as this SGO event, same orientation?
 *
 * Matching is on whole normalised names, never containment, for the reason given
 * above condition 1. A bare abbreviation is NOT accepted as a match: "MIA" is one
 * string and two schools.
 */
function sameGame(event: SGOEvent, game: BDLGameish): boolean {
  const sgoHome = normalizeTeamName(event.teams?.home?.names?.long);
  const sgoAway = normalizeTeamName(event.teams?.away?.names?.long);
  if (!sgoHome || !sgoAway) return false;
  return (
    bdlTeamNames(game.home_team).includes(sgoHome) &&
    bdlTeamNames(game.visitor_team).includes(sgoAway)
  );
}

/**
 * BDL's status field. Observed values differ by sport and have NOT been fully
 * measured on this account, so this recognises only strings that unambiguously
 * mean finished and treats everything else as "no information".
 */
function bdlSaysFinal(status: string | undefined): boolean {
  if (!status) return false;
  const s = status.trim().toLowerCase();
  return (
    s === "f" ||
    s.startsWith("f ") ||
    s.startsWith("f/") ||
    s.startsWith("final") ||
    s === "closed" ||
    s === "complete" ||
    s === "completed"
  );
}

export interface FinalityCrossCheck {
  /** True only when all three conditions held. Safe to grade against SGO's scores. */
  resolved: boolean;
  /** Appended to the refusal reason, or to the grade note when resolved. Never empty. */
  note: string;
}

/**
 * PURE. Takes the BDL rows the caller already fetched. Never fetches, never throws.
 */
export function reconcileFinalityWithBDL(
  event: SGOEvent,
  games: BDLGameish[]
): FinalityCrossCheck {
  const matches = games.filter((g) => sameGame(event, g));

  if (!matches.length) {
    return {
      resolved: false,
      note:
        `Second-source check: BALLDONTLIE returned ${games.length} game(s) for that date and NONE matched this ` +
        `matchup by name in the same home/away orientation, so it could not break the tie. ` +
        `Partial name agreement is deliberately not accepted here.`,
    };
  }

  const game = matches[0];

  if (!bdlSaysFinal(game.status)) {
    return {
      resolved: false,
      note:
        `Second-source check: BALLDONTLIE has this game too and calls its status "${game.status ?? "(none)"}", ` +
        `which is not an affirmative final. Both feeds are therefore unsettled, and the refusal stands.`,
    };
  }

  const bdlHome = game.home_team_score;
  const bdlAway = game.visitor_team_score;
  const sgoHome = event.teams?.home?.score;
  const sgoAway = event.teams?.away?.score;

  if (bdlHome === undefined || bdlAway === undefined || sgoHome === undefined || sgoAway === undefined) {
    return {
      resolved: false,
      note:
        `Second-source check: BALLDONTLIE calls this game final but one of the two feeds is missing a score ` +
        `(SGO ${sgoAway ?? "?"}-${sgoHome ?? "?"}, BDL ${bdlAway ?? "?"}-${bdlHome ?? "?"}, away-home). ` +
        `Finality without an agreed score is not enough to grade on.`,
    };
  }

  if (bdlHome !== sgoHome || bdlAway !== sgoAway) {
    return {
      resolved: false,
      note:
        `Second-source check: THE TWO FEEDS DISAGREE ON THE SCORE. BALLDONTLIE calls it final at ` +
        `${bdlAway}-${bdlHome} (away-home) while SGO currently shows ${sgoAway}-${sgoHome}. At least one of them ` +
        `is still mid-ingest, so this is NOT gradeable yet. Re-run in a few minutes; if the gap persists, check ` +
        `the box score by hand before posting anything.`,
    };
  }

  return {
    resolved: true,
    note:
      `Finality confirmed by SECOND SOURCE. SGO had not yet set a final status on this event, but BALLDONTLIE ` +
      `calls it "${game.status}" at ${bdlAway}-${bdlHome} (away-home), which matches SGO's score exactly. ` +
      `Graded against SGO's scores, as always - BDL supplied the finality, not the numbers.`,
  };
}

/** The narrow structural slice of BDLClient this needs. Keeps the module testable. */
export interface GamesFetcher {
  getGames(
    sport: string,
    params: { dates?: string[]; perPage?: number }
  ): Promise<{ data?: BDLGameish[] }>;
}

/**
 * Fetch-and-reconcile. ONE BDL request, on a key with no monthly object cap.
 *
 * NEVER THROWS. BALLDONTLIE does not carry every sport this connector supports and
 * a missing endpoint 404s (see formatBDLError's 404 branch, which exists precisely
 * because that is a real and permanent condition rather than a transient one). A
 * cross-check that could fail the grade would be worse than no cross-check, so
 * every failure path here degrades to "could not confirm" and the caller's original
 * refusal is returned untouched.
 */
export async function crossCheckFinality(
  bdl: GamesFetcher | undefined,
  sport: string,
  event: SGOEvent
): Promise<FinalityCrossCheck> {
  if (!bdl) {
    return { resolved: false, note: "Second-source check: no BALLDONTLIE client available." };
  }

  const startsAt = event.status?.startsAt;
  if (!startsAt) {
    return {
      resolved: false,
      note: "Second-source check: this event carries no startsAt, so there was no date to query BALLDONTLIE with.",
    };
  }

  // BDL's `dates[]` filter is a calendar day. A late kickoff can settle after
  // midnight UTC, so both the event's UTC day and the following one are asked for.
  // Two dates is still ONE request.
  const day = startsAt.slice(0, 10);
  const nextDay = new Date(new Date(`${day}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);

  try {
    const page = await bdl.getGames(sport, { dates: [day, nextDay], perPage: 100 });
    return reconcileFinalityWithBDL(event, page.data ?? []);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      resolved: false,
      note: `Second-source check could not run: ${message}`,
    };
  }
}
