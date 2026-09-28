import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * v2.10.3: THE SIDE VOCABULARY IS PER MARKET TYPE.
 *
 * ============================================================================
 * THE DEFECT
 * ============================================================================
 *
 * `tkb_get_line_movement` takes one `side` parameter for four market types whose
 * side vocabularies are not the same. A total and a player prop are sided
 * over/under. A moneyline and a spread are sided by TEAM. The schema default is
 * "over", and `entity` is derived from `side` for ml and sp, so a moneyline call
 * that omitted `side` built the oddID `points-over-game-ml-over`.
 *
 * SGO has no such market, so it answered "No market found for
 * points-over-game-ml-over". That sentence names an oddID, but a caller reads it
 * as "this event has no moneyline" and moves on. The data was there the whole
 * time.
 *
 * MEASURED 2026-09-28 on NHL Boston at Florida, eventID QRDNo27CIPW3UiHjAzAV, a
 * finalized 2026-04-02 event reachable because the SGO key is now on the Pro plan:
 *
 *   marketType="moneyline", no side   -> "No market found for points-over-game-ml-over"
 *   marketType="moneyline", side=home -> openingOdds +120, openingBookmaker draftkings
 *
 * SPREAD HAD THE SAME DEFECT and was never reported, because a spread is the market
 * a caller is most likely to pass a side to by hand. It is fixed by the same guard.
 *
 * ============================================================================
 * WHY A GUARD AND NOT A SMARTER DEFAULT
 * ============================================================================
 *
 * Defaulting a moneyline to "home" would answer a question nobody asked. On a
 * two-sided market that is a coin flip wearing an answer's clothes, and this repo
 * refuses rather than returning a plausible wrong answer. Naming the valid values
 * costs the caller one retry and costs the reader nothing.
 *
 * NOTE ON WHAT IS **NOT** CHANGED HERE. The oddID construction is untouched. SGO's
 * llms.txt shows a spread example as `points-home-game-sp-ov` while this connector
 * builds `points-home-game-sp-home`, which is what gameLines.ts has used against
 * live data since v2.8.x. That discrepancy is real and unresolved, and this release
 * deliberately does not act on it: the guard rejects bad arguments before the oddID
 * is built, so the question stays open rather than being silently decided.
 */

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

// Boston at Florida, 2026-04-02, final 2-1 Florida. The moneyline really is present
// under points-home-game-ml-home, which is the whole point: the old default could not
// reach it.
const EVENT = {
  eventID: "QRDNo27CIPW3UiHjAzAV",
  type: "match",
  status: { displayShort: "F", started: true, completed: true, ended: true, live: false, startsAt: "2026-04-02T23:00:00.000Z" },
  teams: {
    home: { teamID: "FLORIDA_PANTHERS_NHL", names: { long: "Florida Panthers" } },
    away: { teamID: "BOSTON_BRUINS_NHL", names: { long: "Boston Bruins" } },
  },
  players: {},
  odds: {
    "points-home-game-ml-home": {
      oddID: "points-home-game-ml-home",
      statID: "points",
      byBookmaker: {
        draftkings: { odds: "-20000", openOdds: "+120", available: true },
      },
    },
    "points-all-game-ou-over": {
      oddID: "points-all-game-ou-over",
      statID: "points",
      byBookmaker: {
        draftkings: { odds: "-110", openOdds: "-105", overUnder: "6.5", openOverUnder: "6", available: true },
      },
    },
  },
};

const fakeSgo = {
  leagueIDFor: () => "NHL",
  getAllEvents: async () => [EVENT],
  getEvents: async () => ({ data: [EVENT] }),
} as never;

const callTool = async (params: Record<string, unknown>) => {
  const { registerLineMovementTool } = await import("../src/tools/lineMovement.js");
  const { server, handlers } = captureServer();
  registerLineMovementTool(server as never, fakeSgo);
  return (await handlers["tkb_get_line_movement"]({
    sport: "nhl",
    eventID: "QRDNo27CIPW3UiHjAzAV",
    preferredBookmakers: "draftkings",
    ...params,
  } as never)) as {
    isError?: boolean;
    content: { text: string }[];
    structuredContent?: Record<string, unknown>;
  };
};

describe("v2.10.3 side vocabulary is validated against marketType", () => {
  test("THE BUG: a moneyline with the defaulted side is refused, and the message blames the argument", async () => {
    const res = await callTool({ marketType: "moneyline", side: "over" });
    assert.equal(res.isError, true);
    const text = res.content[0]!.text;
    assert.match(text, /sided by TEAM/);
    assert.match(text, /side must be 'home' or 'away'/);
    // The caller has to be told this is their argument, not a missing market.
    assert.match(text, /NOT evidence that the event lacks a moneyline/);
    // And that "over" specifically is the schema default, so they know why they hit it.
    assert.match(text, /schema default/);
    // It must NOT have reached SGO and reported a missing market.
    assert.doesNotMatch(text, /No market found/);
  });

  test("the same moneyline with side=home returns the real attributed open", async () => {
    const res = await callTool({ marketType: "moneyline", side: "home" });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent?.openingOdds, "+120");
    assert.equal(res.structuredContent?.openingBookmaker, "draftkings");
  });

  test("SPREAD had the same defect and is refused the same way", async () => {
    const res = await callTool({ marketType: "spread", side: "over" });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /marketType='spread' is sided by TEAM/);
    assert.match(res.content[0]!.text, /NOT evidence that the event lacks a spread/);
  });

  test("moneyline accepts away as well as home", async () => {
    const res = await callTool({ marketType: "moneyline", side: "away" });
    // No refusal. Whether a market exists for that side is a data question, not an
    // argument question, and this event only carries the home side.
    assert.notEqual(res.isError, true);
  });

  test("the guard runs in BOTH directions: a total sided by team is refused", async () => {
    const res = await callTool({ marketType: "total", side: "home" });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /sided by OVER\/UNDER/);
    assert.match(res.content[0]!.text, /side must be 'over' or 'under'/);
    assert.match(res.content[0]!.text, /NOT evidence that the event lacks a total/);
  });

  test("a player_prop sided by team is refused before the marketLabel lookup", async () => {
    const res = await callTool({
      marketType: "player_prop",
      side: "away",
      marketLabel: "Shots On Goal",
      playerID: "DAVID_PASTRNAK_1_NHL",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /sided by OVER\/UNDER/);
  });

  test("REGRESSION: a total on the default side still works untouched", async () => {
    const res = await callTool({ marketType: "total", side: "over" });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent?.openingOdds, "-105");
    assert.equal(res.structuredContent?.openingLine, 6);
  });

  test("the player_prop argument guard still fires and is not shadowed by the side guard", async () => {
    // side is valid here, so the refusal must come from the missing marketLabel.
    const res = await callTool({ marketType: "player_prop", side: "over" });
    assert.equal(res.isError, true);
    assert.match(res.content[0]!.text, /requires both marketLabel and playerID/);
  });
});
