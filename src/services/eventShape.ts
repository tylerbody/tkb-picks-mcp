import type { SGOEvent } from "../types.js";

/**
 * IS THIS EVENT THE TWO-PARTICIPANT MATCH EVERY TOOL ASSUMES IT IS?
 *
 * ============================================================================
 * THE CRASH THIS PREVENTS
 * ============================================================================
 *
 * Reported 2026-09-17: tkb_get_players throwing
 *
 *   "Cannot read properties of undefined"
 *
 * which is not a message, it is a stack trace wearing one. It names no cause, no
 * event, and no fix, and it arrived mid-game while someone was trying to grade a
 * prop - the moment when a readable refusal is worth the most.
 *
 * Twenty-two places across nine files read `event.teams.home.teamID` or
 * `event.teams.away.score` with no guard at all. Every one of them throws a bare
 * TypeError the instant SGO hands back an event that is not shaped like a match.
 *
 * ============================================================================
 * AND SGO HAS SUCH EVENTS. THIS REPO ALREADY WROTE THAT DOWN.
 * ============================================================================
 *
 * From src/types.ts, on the Event type: `type` is "'match' for games. Futures/
 * outright markets use a different type."
 *
 * A futures or outright market has no home side and no away side - a
 * league-winner market has twenty participants and no matchup at all. Pass that
 * eventID to any tool here and the first line that reaches for `teams.home`
 * detonates. The knowledge was in a comment; the guard was nowhere.
 *
 * ============================================================================
 * WHY A SHARED HELPER RATHER THAN NINE LOCAL CHECKS
 * ============================================================================
 *
 * Because this codebase has now been burned four times in one week by fixing the
 * file where a symptom appeared and not the other eight that share the assumption:
 * the soccer period across ten call sites (v2.9.1), the postedLine guard (v2.9.2),
 * the UFC empty-board message (v2.9.3), the empty-string status gate (v2.9.6).
 *
 * The lesson is not "check harder next time". It is that a shared assumption needs
 * a shared guard, so the next sport or market type that violates it produces one
 * clear refusal everywhere instead of nine different stack traces.
 */

/**
 * THE TEAM TYPE IS A PARAMETER, NOT A CONSTANT, and that is deliberate.
 *
 * liveMonitor's readLiveStat takes a deliberately narrow structural slice of an
 * event - only the two scores it actually reads - so that its pure core can be
 * unit-tested without constructing a whole SGOEvent. Pinning this helper to the
 * full SGOEvent team type would have forced that call site to either widen its
 * signature (giving the pure function reach it does not need) or cast (throwing
 * away the very checking this helper exists to provide).
 *
 * Generic over the side shape, it reads whatever the caller already has and hands
 * the same side objects back with their original type intact.
 */
export interface MatchTeamsOf<TSide> {
  home: TSide;
  away: TSide;
  homeID: string;
  awayID: string;
  homeName: string;
  awayName: string;
}

/** The full-event form, which is what eight of the nine call sites use. */
export type MatchTeams = MatchTeamsOf<NonNullable<SGOEvent["teams"]>["home"]>;

export type MatchTeamsResultOf<TSide> =
  | { ok: true; teams: MatchTeamsOf<TSide> }
  | { ok: false; reason: string };

export type MatchTeamsResult = MatchTeamsResultOf<NonNullable<SGOEvent["teams"]>["home"]>;

/** The minimum an event must look like to be asked this question at all. */
export interface MatchShaped<TSide> {
  eventID?: string;
  type?: string;
  teams?: { home?: TSide; away?: TSide };
}

/**
 * PURE. Never throws. Returns either both sides or a reason naming what arrived.
 *
 * The reason deliberately reports `event.type` and which half is missing, because
 * "this is a futures market, not a game" and "SGO returned a malformed match" need
 * different responses from the reader and look identical from a TypeError.
 */
export function readMatchTeams<TSide>(
  event: MatchShaped<TSide> | undefined | null
): MatchTeamsResultOf<TSide> {
  if (!event) {
    return { ok: false, reason: "No event was returned at all, so there is nothing to read." };
  }

  const teams = event.teams;
  const eventType = event.type;
  const typeNote = eventType ? ` The event's type is "${eventType}".` : "";

  if (!teams || typeof teams !== "object") {
    return {
      ok: false,
      reason:
        `Event ${event.eventID ?? "(no id)"} carries NO teams object, so it is not a ` +
        `head-to-head match and no tool here can read a home or away side from it.` +
        typeNote +
        ` SGO uses type "match" for games; FUTURES AND OUTRIGHT markets use a different ` +
        `type and have many participants rather than two. If this id came from a ` +
        `futures board, that is the explanation. Re-check the eventID against ` +
        `tkb_get_schedule, which only returns matches.`,
    };
  }

  const home = teams.home;
  const away = teams.away;
  const missing = [!home ? "home" : null, !away ? "away" : null].filter(Boolean).join(" and ");

  if (!home || !away) {
    return {
      ok: false,
      reason:
        `Event ${event.eventID ?? "(no id)"} is missing its ${missing} side, so it cannot be ` +
        `read as a two-participant match.` +
        typeNote +
        ` This is a malformed or non-match event rather than a tool failure, and it is ` +
        `reported rather than crashed on so the eventID can be checked.`,
    };
  }

  // TSide is unconstrained so that a caller carrying only the fields it reads is
  // still accepted. The identity fields are read defensively here rather than
  // demanded in the constraint, which is why every one of them has a fallback.
  type Identifiable = { teamID?: string; names?: { long?: string } };
  const homeSide = home as Identifiable;
  const awaySide = away as Identifiable;

  const homeID = homeSide.teamID ?? "";
  const awayID = awaySide.teamID ?? "";

  return {
    ok: true,
    teams: {
      home,
      away,
      homeID,
      awayID,
      // Fall back through name, then id, then a literal - never undefined, because
      // these land in user-facing strings and "undefined @ undefined" is its own bug.
      homeName: homeSide.names?.long ?? (homeID || "home"),
      awayName: awaySide.names?.long ?? (awayID || "away"),
    },
  };
}

/**
 * The aggregator form: is this event safe to READ inside a loop over many events?
 *
 * Aggregators must SKIP a malformed event rather than abort the scan. One bad row
 * in a 100-game history should cost that row, not the whole hit rate - the same
 * reasoning the CFBD aggregator uses when one week fails to fetch.
 */
export function isReadableMatch<TSide>(event: MatchShaped<TSide> | undefined | null): boolean {
  return readMatchTeams(event).ok;
}
