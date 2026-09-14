import { SPORT_CONFIG, SUPPORTED_SPORTS, type SportKey } from "../constants.js";
import { narrowingOddID } from "./oddIdBuilder.js";

/**
 * WHICH LEAGUES CAN THIS KEY ACTUALLY SEE?
 *
 * ============================================================================
 * WHY THIS EXISTS: ONE MESSAGE, THREE CAUSES
 * ============================================================================
 *
 * Measured 2026-09-14, on the live connector, before any of this release existed:
 *
 *   tkb_get_schedule sport="atp"                  -> "No ATP games found ..."
 *   tkb_get_schedule sport="atp" Sep 1-13         -> 81 events, the whole US Open
 *
 * The first answer is indistinguishable from three completely different situations:
 *
 *   1. The calendar is genuinely empty for that window (what it actually was - the
 *      US Open had ended and the next ATP event had not started).
 *   2. The filters removed everything that came back.
 *   3. THE KEY CANNOT SEE THAT LEAGUE AT ALL.
 *
 * It took three calls and a backwards probe into a past window to tell them apart.
 * A human reading that message at 9pm while a full board is live would reasonably
 * conclude the slate is empty and move on.
 *
 * ============================================================================
 * WHY IT MATTERS MORE HERE THAN IT WOULD ELSEWHERE: THE KEY SWAP
 * ============================================================================
 *
 * This account swaps between a ROOKIE key and a PRO key depending on the month.
 * SportsGameOdds gates LEAGUE ACCESS by tier, not merely rate limits. From their
 * pricing page: Amateur 8 leagues, Rookie 17, Pro 53, with the leagues doc saying
 * plainly "not all leagues may be available depending on your subscription plan."
 *
 * So a league added while the pro key is installed goes DARK when the rookie key
 * goes back in, and with the old message it goes dark as "no games found" - a
 * silent empty slate on a night with a full board. Silent wrong answers are the one
 * failure class this connector exists to refuse, so the fix belongs here rather
 * than in a runbook.
 *
 * ============================================================================
 * WHAT THIS FILE WILL AND WILL NOT CLAIM
 * ============================================================================
 *
 * It will NOT assert that a key lacks entitlement. SGO's behaviour for an
 * unentitled league has not been measured on this account - it may 403, or it may
 * return an empty list, and those are not distinguishable from an empty calendar
 * without a case where one is known to be true. Asserting "your key cannot see
 * this" on that evidence would be exactly the confident wrong answer being fixed.
 *
 * It WILL: name the three causes whenever a result is empty, say which tier the
 * league is documented under so the reader can check the installed key against it,
 * and give a probe that separates causes by looking at a window wide enough that an
 * in-season league cannot be empty in it.
 */

/** What SGO's published pricing page names for each plan. */
export type SgoTier = "amateur" | "rookie" | "pro" | "unlisted";

interface LeagueTierInfo {
  /** Lowest plan on which SGO's pricing page NAMES this league. */
  documentedFrom: SgoTier;
  /** Free-text nuance for the caller, where the tier alone is misleading. */
  note?: string;
}

/**
 * LEAGUE AVAILABILITY BY PLAN, as SGO's pricing page names it on 2026-09-14.
 *
 * READ THE `unlisted` ENTRIES CAREFULLY. SGO discloses a COUNT per plan and names
 * only some of them: Rookie says 17 leagues and names 10, Pro says 53 and names 12.
 * So "unlisted" means "this league is not in the published examples", NOT "this
 * league is unavailable". UFC is the case that matters here.
 */
const LEAGUE_TIERS: Record<SportKey, LeagueTierInfo> = {
  mlb: { documentedFrom: "amateur" },
  nfl: { documentedFrom: "amateur" },
  cfb: { documentedFrom: "amateur", note: "Named as College Football on the pricing page." },
  cbb: {
    documentedFrom: "amateur",
    note: "Named as College Basketball on the free plan, so NCAAB survives a swap back to the rookie key.",
  },
  ucl: {
    documentedFrom: "amateur",
    note: "Named as Champions League on the free plan, so it survives a swap back to the rookie key.",
  },
  epl: {
    documentedFrom: "rookie",
    note: "Premier League is named from the Rookie plan up, and is NOT on the free plan.",
  },
  wnba: {
    documentedFrom: "unlisted",
    note: "Not in any plan's published example list, but measured working on this account.",
  },
  atp: {
    documentedFrom: "unlisted",
    note: "Not in any published example list. MEASURED WORKING 2026-09-14: 81 events returned for Sep 1-13.",
  },
  wta: {
    documentedFrom: "unlisted",
    note: "Not in any published example list. MEASURED WORKING 2026-09-14: 24 events returned.",
  },
  ufc: {
    documentedFrom: "unlisted",
    note:
      "UFC appears in NO plan's published league list. Given Rookie names 10 of 17 and Pro names 12 of 53, it is most likely a Pro league, which would mean it goes dark on the rookie key. UNVERIFIED - worth one email to api@sportsgameodds.com.",
  },
};

export function leagueTierNote(sport: SportKey): string {
  const info = LEAGUE_TIERS[sport];
  const label = SPORT_CONFIG[sport].label;
  const tier =
    info.documentedFrom === "unlisted"
      ? `${label} is not named in ANY plan's published league list`
      : `${label} is documented from the ${info.documentedFrom.toUpperCase()} plan up`;
  return info.note ? `${tier}. ${info.note}` : `${tier}.`;
}

/**
 * THE MESSAGE AN EMPTY RESULT SHOULD CARRY.
 *
 * Deliberately names all three causes and refuses to pick one. `fetchedBeforeFilters`
 * is the discriminator the caller usually already has: if SGO returned events and
 * this connector's own filters removed them, that is knowable for certain and is
 * stated as fact rather than offered as a possibility.
 */
export function emptyResultExplanation(params: {
  sport: SportKey;
  /** How the window was described to the user, e.g. "the next 2 days". */
  windowDescription: string;
  /** Events SGO returned BEFORE this connector applied its own filters. */
  fetchedBeforeFilters?: number;
}): string {
  const label = SPORT_CONFIG[params.sport].label;
  const leagueID = SPORT_CONFIG[params.sport].sgoLeagueID;

  if (params.fetchedBeforeFilters && params.fetchedBeforeFilters > 0) {
    return (
      `SGO returned ${params.fetchedBeforeFilters} ${label} event(s) for ${params.windowDescription} ` +
      `and THIS CONNECTOR'S OWN FILTERS removed all of them. The league is reachable and the ` +
      `calendar is not empty: the filters are what produced this result. Re-run with the ` +
      `filters relaxed to see what came back.`
    );
  }

  return (
    `No ${label} events came back for ${params.windowDescription}. THREE DIFFERENT THINGS ` +
    `PRODUCE THIS SAME EMPTY RESULT and they are worth separating before acting on it:\n\n` +
    `  1. The calendar really is empty for that window. Common between tournaments, ` +
    `between rounds, and in an offseason.\n` +
    `  2. Lines are not posted yet for events that do exist.\n` +
    `  3. THE INSTALLED KEY CANNOT SEE THIS LEAGUE. SGO gates league access by plan ` +
    `(Amateur 8 leagues, Rookie 17, Pro 53), and this account swaps between a rookie key ` +
    `and a pro key.\n\n` +
    `${leagueTierNote(params.sport)}\n\n` +
    `TO TELL THEM APART, run tkb_check_league_access. It probes a window wide enough that ` +
    `an in-season league cannot be empty in it, and reports what each league actually ` +
    `returned. SGO leagueID for this sport is "${leagueID}".`
  );
}

export interface LeagueReachResult {
  sport: SportKey;
  label: string;
  leagueID: string;
  /** Events found looking BACK. The strongest evidence a key can see the league. */
  recentEvents: number;
  /** Events found looking FORWARD. Zero here is normal between seasons. */
  upcomingEvents: number;
  /** "reachable" | "no_events_either_direction" | "error" */
  verdict: "reachable" | "no_events_either_direction" | "error";
  /** Plain-language reading of the two counts. Never asserts entitlement. */
  reading: string;
  /** Present only when the probe itself failed. */
  error?: string;
}

/** The narrow slice of SGOClient this needs, so the logic is testable without one. */
export interface EventCounter {
  leagueIDFor(sport: SportKey): string;
  getAllEvents(params: {
    leagueID: string;
    startsAfter?: string;
    startsBefore?: string;
    limit?: number;
    oddIDs?: string;
  }): Promise<unknown[]>;
}

/**
 * Probe ONE league in both directions.
 *
 * LOOKING BACKWARD IS THE LOAD-BEARING HALF, and it is the step that would have
 * answered the ATP question in one call instead of three. A forward window is empty
 * for ordinary calendar reasons all the time; a 45-day backward window is empty only
 * if the league did not play, or cannot be seen.
 *
 * Costs two requests per league. `oddIDs` is passed for the reason recorded in
 * v2.8.8: it raises SGO's max page size and stops every odds market being
 * serialised into a response nobody reads. Billing is per EVENT OBJECT, so a probe
 * of ten leagues is cheap in requests and modest in objects.
 */
export async function probeLeagueReach(
  client: EventCounter,
  sport: SportKey,
  now: Date = new Date()
): Promise<LeagueReachResult> {
  const label = SPORT_CONFIG[sport].label;
  const leagueID = client.leagueIDFor(sport);
  const day = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();

  try {
    const [recent, upcoming] = await Promise.all([
      client.getAllEvents({
        leagueID,
        startsAfter: iso(now.getTime() - 45 * day),
        startsBefore: iso(now.getTime()),
        limit: 25,
        oddIDs: narrowingOddID(sport),
      }),
      client.getAllEvents({
        leagueID,
        startsAfter: iso(now.getTime()),
        startsBefore: iso(now.getTime() + 21 * day),
        limit: 25,
        oddIDs: narrowingOddID(sport),
      }),
    ]);

    const recentEvents = recent.length;
    const upcomingEvents = upcoming.length;

    if (recentEvents > 0 || upcomingEvents > 0) {
      return {
        sport,
        label,
        leagueID,
        recentEvents,
        upcomingEvents,
        verdict: "reachable",
        reading:
          upcomingEvents === 0
            ? `REACHABLE. ${recentEvents} event(s) in the last 45 days and none in the next 21, ` +
              `which is a CALENDAR GAP rather than an access problem - exactly the ATP case ` +
              `measured on 2026-09-14.`
            : `REACHABLE. ${recentEvents} recent and ${upcomingEvents} upcoming event(s).`,
      };
    }

    return {
      sport,
      label,
      leagueID,
      recentEvents: 0,
      upcomingEvents: 0,
      verdict: "no_events_either_direction",
      reading:
        `NOTHING IN EITHER DIRECTION across 66 days. If ${label} is OUT OF SEASON this is ` +
        `correct and expected. If it is in season, the installed key most likely cannot see ` +
        `this league. ${leagueTierNote(sport)}`,
    };
  } catch (err) {
    return {
      sport,
      label,
      leagueID,
      recentEvents: 0,
      upcomingEvents: 0,
      verdict: "error",
      reading: `The probe itself failed, so nothing is established about ${label} either way.`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Probe every configured league. Two requests each. */
export async function probeAllLeagues(
  client: EventCounter,
  sports: SportKey[] = SUPPORTED_SPORTS,
  now: Date = new Date()
): Promise<LeagueReachResult[]> {
  const out: LeagueReachResult[] = [];
  for (const sport of sports) {
    out.push(await probeLeagueReach(client, sport, now));
  }
  return out;
}
