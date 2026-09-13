import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { assessFinality, isAffirmativelyLive } from "../src/services/eventStatus.js";
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
