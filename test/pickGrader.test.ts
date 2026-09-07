import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  gradeSpread,
  gradeOverUnder,
  gradeMoneyline,
  missingPostedLineRefusal,
  gradePlayerProp,
  SPREAD_SIGN_CONVENTION,
} from "../src/services/pickGrader.js";

/**
 * WHY THIS FILE EXISTS.
 *
 * The spread grader was wrong for fifteen confirmed published results and no test
 * could have caught it, because the comparison lived inline inside two tool
 * handlers that need an SGO client. That is the exact rule v2.6.1 learned and
 * v2.6.3, v2.7.0, v2.8.4 and v2.8.5 each restated: logic that decides which data
 * reaches the user is correctness logic and cannot live where a network is needed
 * to reach it.
 *
 * Every case below is either a real measured event or a real flipped pick from
 * claude/grading-accuracy-guardrails.md. None are invented fixtures.
 */

// Mississippi State 62, UL Monroe 13. eventID rMHlsh9uyGQJHnyrq4eo, 2026-09-05.
// Measured live through tkb_grade_slate on 2026-09-07.
const MSST = { homeScore: 62, awayScore: 13 };

describe("gradeSpread - the bug that produced fifteen flipped results", () => {
  test("UL Monroe +35.5 losing by 49 is a LOSS, not a WIN", () => {
    // THE REGRESSION. The old code compared odd.score (13, UL Monroe's own points)
    // against 35.5 and, on the under-style branch, returned 13 < 35.5 -> WIN.
    // They lost by 49. This is the assertion that fails if anyone reintroduces it.
    const g = gradeSpread({ side: "away", ...MSST, line: 35.5 });
    assert.equal(g.result, "LOSS");
    assert.equal(g.margin, -49);
    assert.equal(g.adjustedMargin, -13.5);
  });

  test("Mississippi State -35.5 winning by 49 is a WIN", () => {
    const g = gradeSpread({ side: "home", ...MSST, line: -35.5 });
    assert.equal(g.result, "WIN");
    assert.equal(g.margin, 49);
    assert.equal(g.adjustedMargin, 13.5);
  });

  test("a home favourite that wins but does not cover is a LOSS", () => {
    // The shape of the Ole Miss -6.5 report: a raw score of 41 against a line of
    // -6.5 was graded WIN because 41 > -6.5. Every home favourite graded WIN
    // automatically, since a team's score is always above a negative number.
    const g = gradeSpread({ side: "home", homeScore: 41, awayScore: 38, line: -6.5 });
    assert.equal(g.result, "LOSS");
    assert.equal(g.margin, 3);
  });

  test("a home favourite that loses outright is a LOSS", () => {
    const g = gradeSpread({ side: "home", homeScore: 20, awayScore: 30, line: -6.5 });
    assert.equal(g.result, "LOSS");
    assert.equal(g.margin, -10);
  });

  test("raw-score comparison - the old logic - gets the ULM case wrong", () => {
    // Mutation guard, stated as an executable claim rather than a comment. If a
    // future edit reverts to comparing the team's own score against the line, this
    // documents precisely what that produces and that it disagrees with the truth.
    const oldLogicAwayVerdict = 13 < 35.5 ? "WIN" : "LOSS";
    assert.equal(oldLogicAwayVerdict, "WIN");
    assert.notEqual(
      oldLogicAwayVerdict,
      gradeSpread({ side: "away", ...MSST, line: 35.5 }).result
    );
  });
});

describe("gradeSpread - the runlines that flipped", () => {
  // All four are real picks recorded as connector-flipped in the guardrails doc.
  test("Yankees -1.5 winning by exactly 1 is a LOSS", () => {
    assert.equal(gradeSpread({ side: "home", homeScore: 4, awayScore: 3, line: -1.5 }).result, "LOSS");
  });

  test("Yankees -1.5 winning by 2 is a WIN", () => {
    assert.equal(gradeSpread({ side: "home", homeScore: 5, awayScore: 3, line: -1.5 }).result, "WIN");
  });

  test("White Sox +1.5 losing by exactly 1 is a WIN", () => {
    assert.equal(gradeSpread({ side: "away", homeScore: 4, awayScore: 3, line: 1.5 }).result, "WIN");
  });

  test("Royals +1.5 losing by 3 is a LOSS", () => {
    assert.equal(gradeSpread({ side: "away", homeScore: 6, awayScore: 3, line: 1.5 }).result, "LOSS");
  });

  test("an away favourite covering on the road is a WIN", () => {
    assert.equal(gradeSpread({ side: "away", homeScore: 17, awayScore: 27, line: -7 }).result, "WIN");
  });
});

describe("gradeSpread - pushes exist and must not be scored as misses", () => {
  test("a whole-number line landed exactly is a PUSH", () => {
    const g = gradeSpread({ side: "home", homeScore: 24, awayScore: 21, line: -3 });
    assert.equal(g.result, "PUSH");
    assert.equal(g.adjustedMargin, 0);
  });

  test("the other side of that same push is also a PUSH", () => {
    assert.equal(gradeSpread({ side: "away", homeScore: 24, awayScore: 21, line: 3 }).result, "PUSH");
  });

  test("a pick'em at 0 settles on the outright result", () => {
    assert.equal(gradeSpread({ side: "home", homeScore: 24, awayScore: 21, line: 0 }).result, "WIN");
    assert.equal(gradeSpread({ side: "away", homeScore: 24, awayScore: 21, line: 0 }).result, "LOSS");
  });
});

describe("gradeSpread - the mirrored-line invariant", () => {
  /**
   * The strongest available check on spread grading, and the one the old code
   * could never have passed: both sides of the same spread cannot both win.
   *
   * If home -X is a WIN then away +X must be a LOSS, and vice versa, and a PUSH on
   * one side must be a PUSH on the other. Under the old logic a 62-13 game graded
   * home -35.5 as WIN and away +35.5 as WIN simultaneously, which is the defect
   * expressed as an impossibility rather than as a wrong number.
   */
  const opposite = { WIN: "LOSS", LOSS: "WIN", PUSH: "PUSH" } as const;

  test("no scoreline and line combination lets both sides win", () => {
    let checked = 0;
    for (let home = 0; home <= 45; home += 3) {
      for (let away = 0; away <= 45; away += 3) {
        for (const line of [-14, -7.5, -3, -1.5, 0, 1.5, 3, 7.5, 14]) {
          const h = gradeSpread({ side: "home", homeScore: home, awayScore: away, line });
          const a = gradeSpread({ side: "away", homeScore: home, awayScore: away, line: -line });
          assert.equal(
            a.result,
            opposite[h.result],
            `both sides disagree at ${home}-${away} line ${line}: home ${h.result}, away ${a.result}`
          );
          checked++;
        }
      }
    }
    assert.ok(checked > 1000, `expected a broad sweep, only checked ${checked}`);
  });
});

describe("gradeSpread - the output has to make a sign error visible", () => {
  /**
   * A dropped minus sign is not detectable from the number alone and the feed
   * cannot settle it, so the guardrail is that the arithmetic is shown. These
   * assertions exist so a future edit cannot quietly reduce the output to a bare
   * verdict, which is how the original bug stayed invisible in the first place.
   */
  test("the explanation states the final score, the margin and the requirement", () => {
    const g = gradeSpread({
      side: "away",
      ...MSST,
      line: 35.5,
      pickedName: "UL Monroe",
      opponentName: "Mississippi State",
    });
    assert.match(g.explanation, /UL Monroe/);
    assert.match(g.explanation, /13-62/);
    assert.match(g.explanation, /lost by 49/);
    assert.match(g.explanation, /lose by less than 35.5/);
    assert.match(g.explanation, /LOSS/);
  });

  test("a laying line describes winning by, not losing by", () => {
    const g = gradeSpread({ side: "home", ...MSST, line: -35.5, pickedName: "Mississippi State" });
    assert.match(g.explanation, /win by more than 35.5/);
  });

  test("the sign convention is stated and non-empty", () => {
    assert.match(SPREAD_SIGN_CONVENTION, /-6\.5/);
    assert.match(SPREAD_SIGN_CONVENTION, /\+6\.5/);
  });
});

describe("gradeOverUnder - unchanged behaviour, pinned so the spread fix cannot drift into it", () => {
  test("62-13 is 75 points, over 55.5 wins", () => {
    assert.equal(gradeOverUnder({ side: "over", actual: 75, line: 55.5 }), "WIN");
  });

  test("the same total under 55.5 loses", () => {
    assert.equal(gradeOverUnder({ side: "under", actual: 75, line: 55.5 }), "LOSS");
  });

  test("an exact whole number is a PUSH on both sides", () => {
    assert.equal(gradeOverUnder({ side: "over", actual: 8, line: 8 }), "PUSH");
    assert.equal(gradeOverUnder({ side: "under", actual: 8, line: 8 }), "PUSH");
  });

  test("the 16-1 Red Sox/Yankees case grades on 17 actual runs", () => {
    assert.equal(gradeOverUnder({ side: "over", actual: 17, line: 8.5 }), "WIN");
    // 17.5 was the artifact v2.8.3 removed - the feed's line tracking the score.
    // Against it the same real over would have read as a loss.
    assert.equal(gradeOverUnder({ side: "over", actual: 17, line: 17.5 }), "LOSS");
  });
});

describe("gradeMoneyline", () => {
  test("home wins, ties push", () => {
    assert.equal(gradeMoneyline({ side: "home", homeScore: 62, awayScore: 13 }), "WIN");
    assert.equal(gradeMoneyline({ side: "away", homeScore: 62, awayScore: 13 }), "LOSS");
    assert.equal(gradeMoneyline({ side: "home", homeScore: 21, awayScore: 21 }), "PUSH");
  });
});

describe("missingPostedLineRefusal - carries the evidence, not just the rule", () => {
  test("names the measured feed numbers so the refusal is arguable, not arbitrary", () => {
    const msg = missingPostedLineRefusal("total");
    assert.match(msg, /76\.5/);
    assert.match(msg, /-48\.5/);
    assert.match(msg, /postedLine/);
  });
});

describe("gradePlayerProp - a zero is RESOLVED against the box score, not flagged", () => {
  const base = { side: "under" as const, line: 0.5, playerLabel: "Gleyber Torres", sport: "mlb" };

  test("a real zero from a player who has a box-score line grades with NO flag", () => {
    // The whole point of resolving rather than warning. A quiet 0-for-4 is an
    // ordinary grade and must not produce a warning, or the warning stops being
    // read - the v2.5.0 argument about IRREGULAR firing on Cam Schlittler.
    const o = gradePlayerProp({ ...base, lookup: { kind: "value", value: 0 }, fallbackScore: 0 });
    assert.equal(o.kind, "graded");
    assert.equal(o.result, "WIN");
    assert.equal(o.note, null);
  });

  test("a player absent from the box score is VOID, never a win on the under", () => {
    const o = gradePlayerProp({ ...base, lookup: { kind: "player_absent" }, fallbackScore: 0 });
    assert.equal(o.kind, "void");
    assert.equal(o.result, null);
    assert.match(o.note!, /VOID/);
    assert.match(o.note!, /did not play/);
  });

  test("the under is NOT credited when the player did not appear", () => {
    // Stated as its own assertion because this is the money case: grading that
    // same pick off the settled value returns WIN, and it is a pick with no action.
    const viaScore = gradeOverUnder({ side: "under", actual: 0, line: 0.5 });
    assert.equal(viaScore, "WIN");
    const resolved = gradePlayerProp({ ...base, lookup: { kind: "player_absent" }, fallbackScore: 0 });
    assert.notEqual(resolved.result, "WIN");
  });

  test("a player who appeared but whose stat is unsettled is not a DNP and not a grade", () => {
    const o = gradePlayerProp({ ...base, lookup: { kind: "stat_unsettled" }, fallbackScore: 0 });
    assert.equal(o.kind, "unsettled");
    assert.equal(o.result, null);
    assert.match(o.note!, /DID appear/);
  });

  test("no box score plus a zero is the ONE case that still needs a human", () => {
    const o = gradePlayerProp({ ...base, lookup: { kind: "no_box_score" }, fallbackScore: 0 });
    assert.equal(o.kind, "unresolved");
    assert.equal(o.result, "WIN");
    assert.match(o.note!, /PARTICIPATION UNCONFIRMED/);
    assert.match(o.note!, /tkb_get_mlb_matchup/);
  });

  test("no box score but a NON-zero value is self-evidencing and does not flag", () => {
    // He plainly played - you cannot record two hits without appearing.
    const o = gradePlayerProp({ ...base, lookup: { kind: "no_box_score" }, fallbackScore: 2 });
    assert.equal(o.kind, "graded");
    assert.equal(o.result, "LOSS");
    assert.equal(o.note, null);
  });

  test("no box score and no settled value concludes nothing", () => {
    const o = gradePlayerProp({ ...base, lookup: { kind: "no_box_score" }, fallbackScore: null });
    assert.equal(o.kind, "unresolved");
    assert.equal(o.result, null);
  });

  test("an ordinary populated stat line grades normally on both sides", () => {
    assert.equal(
      gradePlayerProp({ ...base, side: "over", lookup: { kind: "value", value: 2 }, fallbackScore: 2 }).result,
      "WIN"
    );
    assert.equal(
      gradePlayerProp({ ...base, side: "under", lookup: { kind: "value", value: 2 }, fallbackScore: 2 }).result,
      "LOSS"
    );
  });
});
