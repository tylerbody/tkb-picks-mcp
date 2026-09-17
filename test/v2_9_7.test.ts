import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { assessFinality } from "../src/services/eventStatus.js";
import { readMatchTeams, isReadableMatch } from "../src/services/eventShape.js";
import type { SGOEvent } from "../src/types.js";

/* ===========================================================================
 * v2.9.7 - TWO DEFECTS REPORTED FROM LIVE USE ON 2026-09-17
 * ===========================================================================
 *
 * 1. tkb_get_players threw "Cannot read properties of undefined" on an event,
 *    which named nothing and blocked prop grading mid-game.
 * 2. tkb_grade_pick returned VOID / statusLabel "DNP" for a WTA match that had
 *    not started yet. An agent caught it and overrode to NOT_FINAL by hand.
 *    Left alone, unplayed matches post as voids.
 *
 * Both are guarded here. Every fixture below is the shape actually observed,
 * not an invented one.
 * ======================================================================== */

const ev = (status: Record<string, unknown>): SGOEvent =>
  ({ eventID: "E", status, teams: { home: {}, away: {} } }) as unknown as SGOEvent;

const HOUR = 3600 * 1000;
const future = () => new Date(Date.now() + 6 * HOUR).toISOString();
const past = () => new Date(Date.now() - 6 * HOUR).toISOString();

describe("DEFECT 2: a cancelled flag before the scheduled start is a HOLD, not a VOID", () => {
  /* The reported event verbatim: WTA, Marta Kostyuk vs Taylor Townsend,
   * YTzyDTwE4oBWSmdN3LNT, startTimeISO 2026-09-16T23:00:00.000Z, status "DNP",
   * cancelled true, results {} and players {} both empty. */
  const unplayed = () => ev({ cancelled: true, displayShort: "DNP", startsAt: future() });

  test("THE BUG: it is not reported as cancelled, because cancelled drives VOID", () => {
    assert.equal(assessFinality(unplayed()).cancelled, undefined);
  });

  test("it is not final either - the pick is held, not settled in any direction", () => {
    assert.equal(assessFinality(unplayed()).final, false);
  });

  test("the reason says to hold it and says why a void would be unrecoverable", () => {
    const v = assessFinality(unplayed());
    assert.match(v.reason, /HOLD THIS ONE/);
    assert.match(v.reason, /NOT PASSED/);
    assert.match(v.reason, /terminal/);
    assert.match(v.reason, /re-grade|Re-run/i);
  });

  test("the reader is told WHEN to try again, not just that it failed", () => {
    // A refusal with no retry condition produces the same indefinite polling the
    // tennis roster message was fixed for in an earlier release.
    assert.match(assessFinality(unplayed()).reason, /after the scheduled start time/i);
  });

  test("no second source is consulted for a match that has not started", () => {
    assert.equal(assessFinality(unplayed()).crossCheckable, false);
  });

  test("the observed status label is preserved, so DNP still reads as DNP", () => {
    assert.equal(assessFinality(unplayed()).label, "DNP");
  });

  test("ONCE THE START TIME PASSES the same flag DOES produce a void", () => {
    // This is the half that must not regress: a genuinely cancelled match still
    // has to reach the tracker as a void rather than being held forever.
    const v = assessFinality(ev({ cancelled: true, displayShort: "DNP", startsAt: past() }));
    assert.equal(v.cancelled, true);
    assert.match(v.reason, /Void/);
  });

  test("a cancelled event with NO start time still voids - absence is not a future", () => {
    // Refusing to guess is the house rule everywhere else in this file, but here
    // guessing "not started" would hold every startsAt-less cancellation forever.
    assert.equal(assessFinality(ev({ cancelled: true })).cancelled, true);
  });

  test("an UNPLAYED match with no cancelled flag is untouched by this branch", () => {
    const v = assessFinality(ev({ displayShort: "", startsAt: future() }));
    assert.equal(v.cancelled, undefined);
    assert.match(v.reason, /NOT STARTED YET/);
    assert.equal(v.crossCheckable, false);
  });

  test("a FINISHED game is unaffected - the new branch cannot swallow a final", () => {
    assert.equal(assessFinality(ev({ finalized: true, displayShort: "F", startsAt: past() })).final, true);
  });
});

describe("DEFECT 1: a non-match event is refused by name, never by TypeError", () => {
  test("THE BUG: an event with no teams object does not throw", () => {
    assert.doesNotThrow(() => readMatchTeams({ eventID: "F1", type: "futures" }));
  });

  test("the refusal names the event and its type, which a TypeError never did", () => {
    const r = readMatchTeams({ eventID: "F1", type: "futures" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /F1/);
    assert.match(r.reason, /futures/);
    assert.match(r.reason, /FUTURES AND OUTRIGHT/);
  });

  test("a HALF-formed match names which half is missing", () => {
    const r = readMatchTeams({ eventID: "E", teams: { home: { teamID: "H" } } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /missing its away side/);
  });

  test("a missing HOME side is named as home, not as away", () => {
    const r = readMatchTeams({ eventID: "E", teams: { away: { teamID: "A" } } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.reason, /missing its home side/);
  });

  test("null and undefined are answers, not crashes", () => {
    assert.equal(readMatchTeams(null).ok, false);
    assert.equal(readMatchTeams(undefined).ok, false);
  });

  test("a real match reads both sides with their names", () => {
    const r = readMatchTeams({
      eventID: "E",
      teams: {
        home: { teamID: "NYY", names: { long: "New York Yankees" } },
        away: { teamID: "BOS", names: { long: "Boston Red Sox" } },
      },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.teams.homeName, "New York Yankees");
    assert.equal(r.teams.awayName, "Boston Red Sox");
    assert.equal(r.teams.homeID, "NYY");
    assert.equal(r.teams.awayID, "BOS");
  });

  test("a NAMELESS side never renders as the string 'undefined'", () => {
    // "undefined @ undefined" is its own bug report, and these strings are
    // user-facing in every tool that calls this.
    const r = readMatchTeams({ eventID: "E", teams: { home: { teamID: "H" }, away: { teamID: "A" } } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.teams.homeName, "H");
    assert.equal(r.teams.awayName, "A");
  });

  test("a side with neither name nor id still falls back to a readable word", () => {
    const r = readMatchTeams({ eventID: "E", teams: { home: {}, away: {} } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.teams.homeName, "home");
    assert.equal(r.teams.awayName, "away");
  });

  test("THE AGGREGATOR FORM skips a bad row instead of aborting the scan", () => {
    const rows = [
      { eventID: "1", teams: { home: { teamID: "H" }, away: { teamID: "A" } } },
      { eventID: "2", type: "futures" },
      { eventID: "3", teams: { home: { teamID: "H" }, away: { teamID: "A" } } },
    ];
    assert.equal(rows.filter(isReadableMatch).length, 2);
  });

  test("the SIDE OBJECTS come back as themselves, not copies", () => {
    // Callers read scores off these, so they must be the same objects.
    const home = { teamID: "H", score: 4 };
    const r = readMatchTeams({ eventID: "E", teams: { home, away: { teamID: "A", score: 2 } } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.teams.home, home);
    assert.equal(r.teams.home.score, 4);
  });
});
