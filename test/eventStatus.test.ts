import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  assessFinality,
  isAffirmativelyLive,
  reconcileFinalityWithBDL,
  crossCheckFinality,
} from "../src/services/eventStatus.js";
import type { SGOEvent } from "../src/types.js";

/**
 * Every status string below was observed live on 2026-09-12 in a single
 * tkb_get_schedule response over one CFB Saturday. None are invented.
 *
 * The case this file exists for: Pittsburgh @ UCF, eventID sGMmL4WzMWVl5eoshB7N,
 * read "4th" in the schedule and graded as a final 12-7 in the same minute.
 */
const ev = (status: Record<string, unknown>): SGOEvent =>
  ({ eventID: "E", status, teams: { home: {}, away: {} } }) as unknown as SGOEvent;

describe("assessFinality - the grader must not settle a live game", () => {
  test("THE BUG: a 4th-quarter game is NOT final", () => {
    const v = assessFinality(ev({ displayShort: "4th", started: true, completed: false, live: true }));
    assert.equal(v.final, false);
    assert.equal(v.label, "4th");
    assert.match(v.reason, /STILL IN PROGRESS/);
    assert.match(v.reason, /tkb_monitor_live_picks/);
  });

  test("a finished game is final", () => {
    assert.equal(assessFinality(ev({ displayShort: "F", completed: true })).final, true);
  });

  test("a game finished in overtime is final", () => {
    // Observed as literally "F (OT)" on Purdue/Wake Forest.
    assert.equal(assessFinality(ev({ displayShort: "F (OT)", completed: true })).final, true);
  });

  test("every in-progress label observed that Saturday is refused", () => {
    for (const d of ["1st", "2nd", "3rd", "4th", "HT"]) {
      assert.equal(assessFinality(ev({ displayShort: d })).final, false, `${d} must not grade`);
    }
  });

  test("UNKNOWN IS NOT FINAL. This is the asymmetry, stated as a test.", () => {
    // Grading a live game publishes a wrong result; refusing a finished one costs
    // a retry. Those are not comparable errors, so a missing status refuses.
    const v = assessFinality(ev({}));
    assert.equal(v.final, false);
    assert.equal(v.label, "unknown");
    assert.match(v.reason, /request rather than a guarantee|REQUEST rather than a guarantee/);
  });

  test("a cancelled event is refused and named as Void, not as a loss", () => {
    const v = assessFinality(ev({ cancelled: true }));
    assert.equal(v.final, false);
    assert.match(v.reason, /CANCELLED/);
    assert.match(v.reason, /Void/);
  });

  test("completed:true wins over a stale in-progress label", () => {
    // SGO's ingest lags the whistle by minutes. If the booleans have caught up,
    // trust them rather than the display string.
    assert.equal(assessFinality(ev({ displayShort: "4th", completed: true })).final, true);
  });

  test("displayShort alone is enough when the booleans are absent", () => {
    assert.equal(assessFinality(ev({ displayShort: "Final" })).final, true);
  });
});

describe("isAffirmativelyLive - the client-layer guard is deliberately looser", () => {
  test("drops what the feed says is live", () => {
    assert.equal(isAffirmativelyLive(ev({ live: true })), true);
    assert.equal(isAffirmativelyLive(ev({ displayShort: "2nd" })), true);
    assert.equal(isAffirmativelyLive(ev({ started: true, ended: false })), true);
  });

  test("KEEPS an unknown status, unlike the grader", () => {
    // The whole reason the two thresholds differ. Silently dropping games on a
    // status string this code does not recognise would shrink every hit-rate
    // sample for a reason nobody could see, which is worse than the leak.
    assert.equal(isAffirmativelyLive(ev({})), false);
    assert.equal(isAffirmativelyLive(ev({ displayShort: "Postponed" })), false);
  });

  test("keeps finished games, including OT", () => {
    assert.equal(isAffirmativelyLive(ev({ displayShort: "F", completed: true })), false);
    assert.equal(isAffirmativelyLive(ev({ displayShort: "F (OT)" })), false);
  });

  test("the two thresholds genuinely differ on unknown", () => {
    const unknown = ev({});
    assert.equal(isAffirmativelyLive(unknown), false, "client keeps it");
    assert.equal(assessFinality(unknown).final, false, "grader refuses it");
  });
});

describe("no containment matching on status strings", () => {
  test("a label merely starting with the letter f is not a final", () => {
    // v2.8.5 learned this with "Miami" vs "Miami (OH)". A loose match on "F"
    // would settle a game at the end of the first half.
    assert.equal(assessFinality(ev({ displayShort: "First Half" })).final, false);
    assert.equal(assessFinality(ev({ displayShort: "Forfeit pending" })).final, false);
  });
});

/**
 * v2.8.12 - the BALLDONTLIE second-source check.
 *
 * The event below is the real stuck shape: a finalized-only fetch returned it with
 * scores present and NO status the connector can read. Before this, that was a flat
 * refusal and the user re-ran the grader until SGO caught up.
 */
const stuck = (homeScore: number, awayScore: number): SGOEvent =>
  ({
    eventID: "E",
    status: { startsAt: "2026-09-12T23:30:00Z" },
    teams: {
      home: { teamID: "UCF_NCAAF", names: { long: "UCF Knights" }, score: homeScore },
      away: { teamID: "PITTSBURGH_NCAAF", names: { long: "Pittsburgh Panthers" }, score: awayScore },
    },
  }) as unknown as SGOEvent;

const bdlRow = (over: Record<string, unknown> = {}) => ({
  status: "Final",
  home_team: { full_name: "UCF Knights" },
  visitor_team: { full_name: "Pittsburgh Panthers" },
  home_team_score: 7,
  visitor_team_score: 12,
  ...over,
});

describe("reconcileFinalityWithBDL - a second feed may only ever ADD finality", () => {
  test("all three conditions hold: resolved", () => {
    const r = reconcileFinalityWithBDL(stuck(7, 12), [bdlRow()]);
    assert.equal(r.resolved, true);
    assert.match(r.note, /SECOND SOURCE/);
    // The note must say where the numbers came from, not just that it resolved.
    assert.match(r.note, /BDL supplied the finality, not the numbers/);
  });

  test("scores disagree: REFUSED, and both are reported", () => {
    const r = reconcileFinalityWithBDL(stuck(7, 12), [bdlRow({ home_team_score: 14 })]);
    assert.equal(r.resolved, false);
    assert.match(r.note, /DISAGREE ON THE SCORE/);
    assert.match(r.note, /12-14/);
    assert.match(r.note, /12-7/);
  });

  test("BDL status is not an affirmative final: refused", () => {
    for (const status of ["4th", "InProgress", "Scheduled", "", "Postponed"]) {
      const r = reconcileFinalityWithBDL(stuck(7, 12), [bdlRow({ status })]);
      assert.equal(r.resolved, false, `"${status}" must not resolve`);
    }
  });

  test("an unrecognised status resolves NOTHING rather than guessing", () => {
    const r = reconcileFinalityWithBDL(stuck(7, 12), [bdlRow({ status: "ST_FIN_2" })]);
    assert.equal(r.resolved, false);
    assert.match(r.note, /ST_FIN_2/);
  });

  test("a missing score on either side is not enough", () => {
    assert.equal(
      reconcileFinalityWithBDL(stuck(7, 12), [bdlRow({ home_team_score: undefined })]).resolved,
      false
    );
    assert.equal(reconcileFinalityWithBDL(stuck(7, undefined as never), [bdlRow()]).resolved, false);
  });

  test("BOTH teams must match, and in the right orientation", () => {
    // Home and away swapped. Same two schools, different game entirely.
    const swapped = bdlRow({
      home_team: { full_name: "Pittsburgh Panthers" },
      visitor_team: { full_name: "UCF Knights" },
    });
    assert.equal(reconcileFinalityWithBDL(stuck(7, 12), [swapped]).resolved, false);

    // One team right, one wrong.
    const half = bdlRow({ visitor_team: { full_name: "Pittsburgh Steelers" } });
    assert.equal(reconcileFinalityWithBDL(stuck(7, 12), [half]).resolved, false);
  });

  test("THE v2.8.5 LESSON: partial name agreement is not a match", () => {
    const ev = {
      eventID: "E",
      status: { startsAt: "2026-09-12T23:30:00Z" },
      teams: {
        home: { names: { long: "Miami (OH) RedHawks" }, score: 20 },
        away: { names: { long: "Toledo Rockets" }, score: 17 },
      },
    } as unknown as SGOEvent;
    const wrongMiami = {
      status: "Final",
      home_team: { full_name: "Miami Hurricanes" },
      visitor_team: { full_name: "Toledo Rockets" },
      home_team_score: 20,
      visitor_team_score: 17,
    };
    assert.equal(reconcileFinalityWithBDL(ev, [wrongMiami]).resolved, false);
  });

  test("punctuation and diacritics do not block a real match", () => {
    const ev = {
      eventID: "E",
      status: { startsAt: "2026-09-12T23:30:00Z" },
      teams: {
        home: { names: { long: "San Jose State Spartans" }, score: 24 },
        away: { names: { long: "Texas A&M Aggies" }, score: 31 },
      },
    } as unknown as SGOEvent;
    const row = {
      status: "final",
      home_team: { full_name: "San José State Spartans" },
      visitor_team: { full_name: "Texas A and M Aggies", display_name: "Texas A&M Aggies" },
      home_team_score: 24,
      visitor_team_score: 31,
    };
    assert.equal(reconcileFinalityWithBDL(ev, [row]).resolved, true);
  });

  test("an ABBREVIATION is not a name: 'MIA' must never match", () => {
    // MIA is Miami (FL) and Miami (OH) and the Miami Marlins. Accepting it as a
    // team identity is the same containment mistake in a shorter string.
    const row = {
      status: "Final",
      home_team: { abbreviation: "UCF" },
      visitor_team: { abbreviation: "PITT" },
      home_team_score: 7,
      visitor_team_score: 12,
    };
    assert.equal(reconcileFinalityWithBDL(stuck(7, 12), [row]).resolved, false);
  });

  test("no games at all: says so, does not throw", () => {
    const r = reconcileFinalityWithBDL(stuck(7, 12), []);
    assert.equal(r.resolved, false);
    assert.match(r.note, /0 game\(s\)/);
  });
});

describe("crossCheckFinality - the fetch wrapper never throws and never fails a grade", () => {
  test("a BDL 404 degrades to 'could not confirm' rather than an error", async () => {
    const bdl = {
      getGames: async () => {
        throw new Error("BALLDONTLIE has no ncaaf games endpoint (404)");
      },
    };
    const r = await crossCheckFinality(bdl, "cfb", stuck(7, 12));
    assert.equal(r.resolved, false);
    assert.match(r.note, /could not run/);
    assert.match(r.note, /404/);
  });

  test("no client at all is a note, not a crash", async () => {
    const r = await crossCheckFinality(undefined, "cfb", stuck(7, 12));
    assert.equal(r.resolved, false);
  });

  test("an event with no startsAt has no date to query with", async () => {
    const noDate = { eventID: "E", status: {}, teams: { home: {}, away: {} } } as unknown as SGOEvent;
    let called = false;
    const bdl = {
      getGames: async () => {
        called = true;
        return { data: [] };
      },
    };
    const r = await crossCheckFinality(bdl, "cfb", noDate);
    assert.equal(r.resolved, false);
    assert.equal(called, false, "must not spend a request with no date");
  });

  test("asks for the UTC day AND the next one, in ONE request", async () => {
    const seen: unknown[] = [];
    const bdl = {
      getGames: async (_sport: string, params: { dates?: string[] }) => {
        seen.push(params.dates);
        return { data: [bdlRow()] };
      },
    };
    const r = await crossCheckFinality(bdl, "cfb", stuck(7, 12));
    assert.equal(seen.length, 1, "one request per stuck event, never two");
    assert.deepEqual(seen[0], ["2026-09-12", "2026-09-13"]);
    assert.equal(r.resolved, true);
  });
});

/**
 * v2.9.2 - SOCCER WRITES "FT", AND THIS FILE COULD NOT READ IT.
 *
 * Measured live 2026-09-14 across EPL and UCL, every status string on a finished
 * match: "FT" for a normal result, "F (ET)" for one decided in extra time. The
 * second already matched on the "f " prefix. The first matched nothing.
 *
 * It did not break grading on the day, because SGO also set completed: true on
 * those events. That is exactly why it is worth a test: `completed` is the field
 * this whole file exists because SGO was measured LAGGING, on 2026-09-12. On a
 * soccer match where it lagged, the status string would have been the only evidence
 * the match had ended, and it was unreadable.
 */
describe("soccer status strings - measured live on EPL and UCL", () => {
  test('"FT" IS FINAL, on the status string alone with no completed flag', () => {
    const v = assessFinality(ev({ displayShort: "FT" }));
    assert.equal(v.final, true, "FT is how soccer says the match is over");
  });

  test('"F (ET)" is final too', () => {
    assert.equal(assessFinality(ev({ displayShort: "F (ET)" })).final, true);
  });

  test("AET is final", () => {
    assert.equal(assessFinality(ev({ displayShort: "AET" })).final, true);
  });

  test("the match is ALSO final when SGO sets completed, as it did on the day", () => {
    assert.equal(assessFinality(ev({ displayShort: "FT", completed: true })).final, true);
  });

  test("a soccer match in progress is still refused", () => {
    // Half-time on a soccer feed reads "HT", which the in-progress matcher already
    // catches. The FT addition must not widen into it.
    assert.equal(assessFinality(ev({ displayShort: "HT" })).final, false);
    assert.equal(assessFinality(ev({ displayShort: "1st" })).final, false);
  });

  test("ANCHORED, not containment: a status merely CONTAINING ft is not final", () => {
    // The v2.8.5 lesson applied to a two-letter token, where it bites hardest.
    assert.equal(assessFinality(ev({ displayShort: "Draft" })).final, false);
    assert.equal(assessFinality(ev({ displayShort: "Forfeit pending" })).final, false);
  });
});
