import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { gradeSoccerMoneyline, gradeMoneyline, DRAW_CONVENTION } from "../src/services/pickGrader.js";
import { matchLinePeriodFor, hasDrawOutcome, REGULATION_MATCH_LINE_SPORTS } from "../src/constants.js";
import { buildOddID, PERIOD_CODES } from "../src/services/oddIdBuilder.js";

/**
 * SOCCER BREAKS TWO ASSUMPTIONS THIS CONNECTOR HELD EVERYWHERE ELSE:
 * that a level score means no action, and that a full-event market lives on the
 * `game` period. Both are asserted here rather than trusted.
 */

describe("the pre-existing grader is WRONG for soccer, which is why the new one exists", () => {
  test("gradeMoneyline calls a 1-1 draw a PUSH", () => {
    // Not a bug in gradeMoneyline: correct for every sport that cannot end level,
    // and the reason a soccer pick must never be routed through it.
    assert.equal(gradeMoneyline({ side: "home", homeScore: 1, awayScore: 1 }), "PUSH");
  });

  test("the soccer grader calls the same scoreline a LOSS on a three-way price", () => {
    const g = gradeSoccerMoneyline({ side: "home", homeScore: 1, awayScore: 1, threeWay: true });
    assert.equal(g.kind, "graded");
    if (g.kind !== "graded") return;
    assert.equal(g.result, "LOSS");
    assert.match(g.explanation, /THREE-WAY/);
  });
});

describe("gradeSoccerMoneyline - three-way", () => {
  test("home wins", () => {
    const g = gradeSoccerMoneyline({ side: "home", homeScore: 2, awayScore: 0, threeWay: true });
    assert.equal(g.kind === "graded" && g.result, "WIN");
  });

  test("away wins", () => {
    const g = gradeSoccerMoneyline({ side: "away", homeScore: 0, awayScore: 3, threeWay: true });
    assert.equal(g.kind === "graded" && g.result, "WIN");
  });

  test("away side loses when the home side wins", () => {
    const g = gradeSoccerMoneyline({ side: "away", homeScore: 2, awayScore: 1, threeWay: true });
    assert.equal(g.kind === "graded" && g.result, "LOSS");
  });

  test("the draw selection WINS on a level score", () => {
    const g = gradeSoccerMoneyline({ side: "draw", homeScore: 0, awayScore: 0, threeWay: true });
    assert.equal(g.kind === "graded" && g.result, "WIN");
  });

  test("the draw selection LOSES on a decided match", () => {
    const g = gradeSoccerMoneyline({ side: "draw", homeScore: 3, awayScore: 1, threeWay: true });
    assert.equal(g.kind === "graded" && g.result, "LOSS");
  });

  test("0-0 is not treated as missing data", () => {
    const g = gradeSoccerMoneyline({ side: "home", homeScore: 0, awayScore: 0, threeWay: true });
    assert.equal(g.kind, "graded");
  });
});

describe("gradeSoccerMoneyline - two-way, where the draw is genuinely ambiguous", () => {
  test("A DRAWN MATCH ON A TWO-WAY PRICE IS REFUSED, not guessed", () => {
    const g = gradeSoccerMoneyline({ side: "home", homeScore: 1, awayScore: 1, threeWay: false });
    assert.equal(g.kind, "refused");
    if (g.kind !== "refused") return;
    // The refusal has to name BOTH products, or the reader cannot act on it.
    assert.match(g.reason, /DRAW NO BET/);
    assert.match(g.reason, /PUSH/);
    assert.match(g.reason, /LOSS/);
    assert.match(g.reason, /moneyline_3way/);
  });

  test("a DECIDED match on a two-way price grades normally", () => {
    const win = gradeSoccerMoneyline({ side: "away", homeScore: 0, awayScore: 1, threeWay: false });
    assert.equal(win.kind === "graded" && win.result, "WIN");
    const loss = gradeSoccerMoneyline({ side: "home", homeScore: 0, awayScore: 1, threeWay: false });
    assert.equal(loss.kind === "graded" && loss.result, "LOSS");
  });

  test("side='draw' on a two-way price is refused as a mis-logged pick", () => {
    const g = gradeSoccerMoneyline({ side: "draw", homeScore: 1, awayScore: 1, threeWay: false });
    assert.equal(g.kind, "refused");
    if (g.kind !== "refused") return;
    assert.match(g.reason, /only.*three-way|three-way.*only/i);
  });

  test("the convention string names the rule both ways round", () => {
    assert.match(DRAW_CONVENTION, /three-way/i);
    assert.match(DRAW_CONVENTION, /two-way/i);
  });
});

describe("the period split - soccer match lines are NOT on the game period", () => {
  test("EPL and UCL resolve to regulation, everyone else to full_game", () => {
    assert.equal(matchLinePeriodFor("epl"), "regulation");
    assert.equal(matchLinePeriodFor("ucl"), "regulation");
    for (const s of ["mlb", "nfl", "cfb", "cbb", "wnba", "ufc", "atp", "wta"] as const) {
      assert.equal(matchLinePeriodFor(s), "full_game", `${s} must stay on the game period`);
    }
  });

  test("an EPL moneyline builds SGO's documented oddID exactly", () => {
    // Quoted verbatim from SGO's EPL page: "the full-match moneyline is
    // points-home-reg-ml-home".
    assert.equal(
      buildOddID({
        statID: "points",
        entity: "home",
        period: matchLinePeriodFor("epl"),
        betType: "ml",
        side: "home",
      }),
      "points-home-reg-ml-home"
    );
  });

  test("an EPL PLAYER PROP stays on the game period, per the same page", () => {
    assert.equal(
      buildOddID({
        statID: "shots_onGoal",
        entity: "MOHAMED_SALAH_1_EPL",
        period: "full_game",
        betType: "ou",
        side: "over",
      }),
      "shots_onGoal-MOHAMED_SALAH_1_EPL-game-ou-over"
    );
  });

  test("hasDrawOutcome and the regulation list stay in step", () => {
    for (const s of REGULATION_MATCH_LINE_SPORTS) {
      assert.equal(hasDrawOutcome(s), true, `${s} settles on regulation so it must have draws`);
    }
    assert.equal(hasDrawOutcome("nfl"), false);
    assert.equal(hasDrawOutcome("cbb"), false);
  });
});

describe("period codes added in v2.9.0 match SGO's published table", () => {
  test("regulation is reg, not game", () => {
    assert.equal(PERIOD_CODES["regulation"], "reg");
    assert.notEqual(PERIOD_CODES["regulation"], PERIOD_CODES["full_game"]);
  });

  test("UFC rounds are 1r through 5r", () => {
    assert.equal(PERIOD_CODES["1st_round"], "1r");
    assert.equal(PERIOD_CODES["5th_round"], "5r");
  });

  test("a UFC rounds total builds SGO's documented example exactly", () => {
    // Quoted verbatim from SGO's UFC page.
    assert.equal(
      buildOddID({
        statID: "roundsCompleted",
        entity: "all",
        period: "full_game",
        betType: "ou",
        side: "over",
      }),
      "roundsCompleted-all-game-ou-over"
    );
  });

  test("halves are 1h/2h, NOT the glossary's h1/h2", () => {
    // SGO's own glossary contradicts its markets table here. Four sources to one,
    // and this is the side the table is on.
    assert.equal(PERIOD_CODES["1st_half"], "1h");
    assert.equal(PERIOD_CODES["2nd_half"], "2h");
  });
});
