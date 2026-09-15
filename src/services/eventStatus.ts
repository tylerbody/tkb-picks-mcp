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
  /**
   * ADDED v2.9.4. Documented by SGO and never read here until a docs audit found
   * it. `finalized` is the flag their FAQ says to grade on; `reGrade` is their
   * signal that a settled result was revised. `displayShort` has NO documented
   * enumeration at all - every value this file matches on was measured live, not
   * read from a spec - which is the strongest possible argument for preferring
   * these booleans over string matching.
   */
  finalized?: boolean;
  reGrade?: boolean;
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

  /* ------------------------------------------------------------------------
   * `status.finalized` IS THE FIELD SGO TELLS YOU TO GRADE ON, and this file was
   * built without reading it. Added v2.9.4 after a documentation audit.
   *
   * From SGO's FAQ, verbatim: "We recommend waiting until status.finalized is true
   * before you finalise a grade. You can start as soon as status.ended is true."
   *
   * THAT IS THE ANSWER TO THE BUG THIS ENTIRE FILE EXISTS FOR. v2.8.8 was written
   * because a `finalized: true` QUERY returned an in-progress CFB game, and the
   * conclusion drawn was that the request flag is "a request, not a guarantee".
   * That conclusion was right, and incomplete: the query parameter is not a
   * guarantee, but the EVENT carries its own `status.finalized` boolean, and
   * nothing here ever looked at it. The connector inferred finality from a display
   * string while the feed was stating it outright in a documented field.
   *
   * Checked BEFORE the live-status branch on purpose. A feed that affirmatively
   * says finalized has settled the question, and no display string should override
   * it.
   *
   * ONE CAVEAT WORTH CARRYING: SGO's event schema also has `status.reGrade`, which
   * implies a settled result can be revised after the fact. A grade is therefore
   * not permanently immutable, and a cached one can go stale.
   * --------------------------------------------------------------------------*/
  if (s.finalized === true) {
    return { final: true, label: label === "unknown" ? "Final" : label, reason: "" };
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

  /* `ended` is the documented "the game is over" flag, and it is WEAKER than
   * finalized rather than equal to it. SGO's guidance is that grading may START
   * here and should be FINALISED on `finalized`. So this grades, and says plainly
   * that the result can still be revised - which is more useful than either
   * refusing a finished game or pretending the number is locked. */
  if (s.ended === true) {
    return {
      final: true,
      label: label === "unknown" ? "Ended" : label,
      reason:
        `NOTE: this event is marked ENDED but NOT yet FINALIZED by SGO. Their own ` +
        `guidance is that grading can start at ended and should be finalised once ` +
        `status.finalized is true, and their schema carries a reGrade flag, so a ` +
        `settled result can still be revised. Safe to log; worth a re-check before ` +
        `it goes in a public record.`,
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

/**
 * Minimal structural view of BDL's game row.
 *
 * ============================================================================
 * BALLDONTLIE HAS NO SINGLE GAME SHAPE. IT HAS ONE PER SPORT.
 * ============================================================================
 *
 * Corrected v2.9.4 by a documentation audit, and the version shipped in v2.8.12
 * was silently broken for the two sports that would use it most:
 *
 *   field            NFL / NBA            WNBA                 MLB
 *   away team        visitor_team         visitor_team         away_team
 *   home score       home_team_score      home_score           home_team_data.runs
 *   away score       visitor_team_score   away_score           away_team_data.runs
 *   status           "Final"              "Final"              "STATUS_FINAL"
 *
 * The old interface read `visitor_team`, `home_team_score` and `visitor_team_score`
 * only. On MLB the away team never resolved, so no row ever matched; on WNBA the
 * teams matched and both scores read undefined, so the score-agreement guard
 * refused every time. In both cases the cross-check degraded to "could not
 * confirm" - safe, and completely useless, and invisible because a
 * could-not-confirm looks identical to a genuine disagreement.
 *
 * `status` IS NOT NORMALISED ACROSS SPORTS, which is the trap underneath the trap:
 * MLB returns ESPN's raw "STATUS_FINAL" while NFL and NBA return "Final". A matcher
 * anchored on "final" catches one and not the other.
 *
 * `status_state` IS normalised, with the same documented value set on every sport:
 * scheduled, in_progress, final, postponed, canceled, delayed, suspended,
 * abandoned, unknown. That is what this now keys on first. (Note "canceled" is
 * spelled with one L there, and the SGO side of this file spells it "cancelled" -
 * neither is wrong, they are different vendors.)
 */
export interface BDLGameish {
  /** Normalised across every BDL sport. PREFERRED. */
  status_state?: string;
  /** Per-sport and NOT normalised: "Final" on NFL/NBA, "STATUS_FINAL" on MLB. */
  status?: string;
  home_team?: { full_name?: string; display_name?: string; name?: string; abbreviation?: string };
  /** NFL, NBA, WNBA, NCAAF. */
  visitor_team?: { full_name?: string; display_name?: string; name?: string; abbreviation?: string };
  /** MLB writes the away side under a different key entirely. */
  away_team?: { full_name?: string; display_name?: string; name?: string; abbreviation?: string };
  /** NFL / NBA / NCAAF. */
  home_team_score?: number;
  visitor_team_score?: number;
  /** WNBA. */
  home_score?: number;
  away_score?: number;
  /** MLB has NO top-level score. Runs live one level down. */
  home_team_data?: { runs?: number };
  away_team_data?: { runs?: number };
}

/** The away-team object, wherever this sport happens to keep it. */
function awayTeamOf(game: BDLGameish): BDLGameish["home_team"] {
  return game.visitor_team ?? game.away_team;
}

/**
 * Scores, across three different per-sport spellings.
 *
 * Returns undefined rather than 0 when absent, because the caller's whole job is
 * to compare two feeds' numbers and a zero that means "missing" would make two
 * disagreeing feeds look like they agree on a 0-0.
 */
function bdlScores(game: BDLGameish): { home?: number; away?: number } {
  const home =
    game.home_team_score ?? game.home_score ?? game.home_team_data?.runs ?? undefined;
  const away =
    game.visitor_team_score ?? game.away_score ?? game.away_team_data?.runs ?? undefined;
  return {
    home: typeof home === "number" ? home : undefined,
    away: typeof away === "number" ? away : undefined,
  };
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
    bdlTeamNames(awayTeamOf(game)).includes(sgoAway)
  );
}

/**
 * BDL's status field. Observed values differ by sport and have NOT been fully
 * measured on this account, so this recognises only strings that unambiguously
 * mean finished and treats everything else as "no information".
 */
function bdlSaysFinal(game: BDLGameish): boolean {
  // NORMALISED FIELD FIRST. `status_state` carries the same nine values on every
  // BDL sport, so this branch is the only one that does not depend on guessing a
  // vendor's per-sport spelling.
  const state = game.status_state?.trim().toLowerCase();
  if (state) return state === "final";

  // Fallback for a row with no status_state. "STATUS_FINAL" is MLB's raw ESPN
  // string and is why an anchored startsWith("final") was not enough.
  const s = game.status?.trim().toLowerCase();
  if (!s) return false;
  return (
    s === "f" ||
    s.startsWith("f ") ||
    s.startsWith("f/") ||
    s.startsWith("final") ||
    s === "status_final" ||
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

  if (!bdlSaysFinal(game)) {
    const shown = game.status_state ?? game.status ?? "(none)";
    return {
      resolved: false,
      note:
        `Second-source check: BALLDONTLIE has this game too and calls its status "${shown}", ` +
        `which is not an affirmative final. Both feeds are therefore unsettled, and the refusal stands.`,
    };
  }

  const { home: bdlHome, away: bdlAway } = bdlScores(game);
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
      `calls it "${game.status_state ?? game.status}" at ${bdlAway}-${bdlHome} (away-home), which matches SGO's score exactly. ` +
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
