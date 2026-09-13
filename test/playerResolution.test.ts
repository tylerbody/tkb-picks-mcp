import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { diagnosePlayerIdMiss, nameFromPlayerID } from "../src/services/playerResolution.js";
import type { SGOEvent } from "../src/types.js";

/**
 * Built from the real 2026-09-13 roster on Bears @ Panthers
 * (eventID Nw0i5lD1IafZ0HlX842y), where tkb_get_players returned exactly:
 *
 *   playerID: CHRIS_WILLIAMS_1_NFL   name: "Caleb Williams"
 *
 * Right display name, wrong ID stem, passing line posted at 229.5 the whole time.
 */
const ev = (players: Record<string, { playerID: string; name: string; teamID?: string }>): SGOEvent =>
  ({ eventID: "Nw0i5lD1IafZ0HlX842y", players, teams: { home: {}, away: {} } }) as unknown as SGOEvent;

const BEARS = ev({
  CHRIS_WILLIAMS_1_NFL: { playerID: "CHRIS_WILLIAMS_1_NFL", name: "Caleb Williams", teamID: "CHICAGO_BEARS_NFL" },
  DJ_MOORE_1_NFL: { playerID: "DJ_MOORE_1_NFL", name: "DJ Moore", teamID: "CHICAGO_BEARS_NFL" },
  BRYCE_YOUNG_1_NFL: { playerID: "BRYCE_YOUNG_1_NFL", name: "Bryce Young", teamID: "CAROLINA_PANTHERS_NFL" },
});

describe("nameFromPlayerID", () => {
  test("strips the numeric index and league suffix", () => {
    assert.equal(nameFromPlayerID("CALEB_WILLIAMS_1_NFL"), "caleb williams");
    assert.equal(nameFromPlayerID("ELLY_DE_LA_CRUZ_1_MLB"), "elly de la cruz");
  });
});

describe("diagnosePlayerIdMiss - the Caleb Williams case", () => {
  test("THE BUG: a guessed ID finds the real one by surname", () => {
    const d = diagnosePlayerIdMiss(BEARS, "CALEB_WILLIAMS_1_NFL", "Passing Yards");
    assert.equal(d.playerOnEvent, false);
    assert.equal(d.candidates.length, 1);
    assert.equal(d.candidates[0].playerID, "CHRIS_WILLIAMS_1_NFL");
    assert.equal(d.candidates[0].name, "Caleb Williams");
    assert.match(d.message, /WRONG ID/);
    assert.match(d.message, /CHRIS_WILLIAMS_1_NFL/);
  });

  test("it REPORTS and never substitutes", () => {
    // v2.8.2 took three releases to learn that a silent correction which is itself
    // wrong is worse than the error. The message must hand the decision back.
    const d = diagnosePlayerIdMiss(BEARS, "CALEB_WILLIAMS_1_NFL", "Passing Yards");
    assert.match(d.message, /does NOT substitute/);
  });

  test("a CORRECT id on the event is diagnosed as a MARKET gap, not an ID problem", () => {
    // The two need opposite next actions. Collapsing them is how a correct ID gets
    // doubted and an unposted market gets retried forever.
    const d = diagnosePlayerIdMiss(BEARS, "DJ_MOORE_1_NFL", "Receiving Yards");
    assert.equal(d.playerOnEvent, true);
    assert.equal(d.candidates.length, 0);
    assert.match(d.message, /IS attached to this event/);
    assert.match(d.message, /market gap, not a lookup failure/);
  });
});

describe("surname matching is exact, never containment", () => {
  test("Williams must NOT match Williamson", () => {
    // The v8.5 Miami / Miami (OH) trade, running the same direction: a false
    // positive here points confidently at the wrong player.
    const e = ev({
      JOE_WILLIAMSON_1_NFL: { playerID: "JOE_WILLIAMSON_1_NFL", name: "Joe Williamson" },
    });
    const d = diagnosePlayerIdMiss(e, "CALEB_WILLIAMS_1_NFL", "Passing Yards");
    assert.equal(d.candidates.length, 0);
    assert.match(d.message, /no player on it shares that surname/);
  });

  test("two players sharing a surname are BOTH reported, not guessed between", () => {
    const e = ev({
      A_1_NFL: { playerID: "A_1_NFL", name: "Caleb Williams" },
      B_1_NFL: { playerID: "B_1_NFL", name: "Mike Williams" },
    });
    const d = diagnosePlayerIdMiss(e, "CALEB_WILLIAMS_1_NFL", "Passing Yards");
    assert.equal(d.candidates.length, 2);
  });
});

describe("accents and empty rosters", () => {
  test("accent-insensitive, per the v2.4.0 Suarez case", () => {
    const e = ev({ X_1_MLB: { playerID: "X_1_MLB", name: "Eugenio Suárez" } });
    const d = diagnosePlayerIdMiss(e, "EUGENIO_SUAREZ_1_MLB", "Hits");
    assert.equal(d.candidates.length, 1);
    assert.equal(d.candidates[0].playerID, "X_1_MLB");
  });

  test("an empty roster says props are not posted yet, not that the ID is wrong", () => {
    const d = diagnosePlayerIdMiss(ev({}), "CALEB_WILLIAMS_1_NFL", "Passing Yards");
    assert.equal(d.candidates.length, 0);
    assert.match(d.message, /NO players at all/);
    assert.match(d.message, /not posted yet/);
  });

  test("a roster with others but no surname match reports the real count", () => {
    const d = diagnosePlayerIdMiss(BEARS, "PATRICK_MAHOMES_1_NFL", "Passing Yards");
    assert.equal(d.candidates.length, 0);
    assert.match(d.message, /3 player\(s\) are attached/);
  });
});
