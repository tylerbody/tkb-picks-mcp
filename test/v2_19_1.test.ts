import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { slateDayBounds, zonedMidnight, SLATE_TIME_ZONE } from "../src/services/slateDay.js";
import { registerScheduleTool } from "../src/tools/schedule.js";
import { registerGameLinesTool } from "../src/tools/gameLines.js";

/**
 * v2.19.1: `date` hid games. date=2026-10-28 was read as a UTC day, so NBA returned 6
 * games (missing the three tipping 9 PM Eastern or later) plus the previous night's
 * 8 PM Pacific Lakers game. Measured live 2026-10-28.
 */

describe("slateDayBounds: a date is a Pacific calendar day", () => {
  test("the zone is Pacific", () => assert.equal(SLATE_TIME_ZONE, "America/Los_Angeles"));

  test("a PDT day is 07:00Z to 06:59:59Z the next day", () => {
    const w = slateDayBounds("2026-10-28");
    assert.equal(w.startsAfter, "2026-10-28T07:00:00.000Z");
    assert.equal(w.startsBefore, "2026-10-29T06:59:59.000Z");
  });

  test("a PST day is 08:00Z to 07:59:59Z", () => {
    const w = slateDayBounds("2026-12-25");
    assert.equal(w.startsAfter, "2026-12-25T08:00:00.000Z");
    assert.equal(w.startsBefore, "2026-12-26T07:59:59.000Z");
  });

  test("the day DST ends (Nov 1 2026) is 25 hours long", () => {
    const w = slateDayBounds("2026-11-01");
    assert.equal(w.startsAfter, "2026-11-01T07:00:00.000Z");
    assert.equal(w.startsBefore, "2026-11-02T07:59:59.000Z");
  });

  test("the day DST starts (Mar 8 2026) is 23 hours long", () => {
    const w = slateDayBounds("2026-03-08");
    assert.equal(w.startsAfter, "2026-03-08T08:00:00.000Z");
    assert.equal(w.startsBefore, "2026-03-09T06:59:59.000Z");
  });

  test("month and year rollovers", () => {
    assert.equal(slateDayBounds("2026-10-31").startsBefore, "2026-11-01T06:59:59.000Z");
    assert.equal(slateDayBounds("2026-12-31").startsBefore, "2027-01-01T07:59:59.000Z");
  });

  test("the measured games land on the right day", () => {
    const inside = (iso: string, d: string) => {
      const w = slateDayBounds(d);
      return iso >= w.startsAfter && iso <= w.startsBefore;
    };
    // Lakers @ Clippers 02:30Z Oct 29 = 7:30 PM Pacific Oct 28: an Oct 28 game.
    assert.ok(inside("2026-10-29T02:30:00.000Z", "2026-10-28"));
    // Blazers @ Lakers 03:00Z Oct 28 = 8 PM Pacific Oct 27: NOT an Oct 28 game.
    assert.ok(!inside("2026-10-28T03:00:00.000Z", "2026-10-28"));
    assert.ok(inside("2026-10-28T03:00:00.000Z", "2026-10-27"));
    // A 7 PM Hawaii kickoff (05:00Z next day) still belongs to its own date.
    assert.ok(inside("2026-10-25T05:00:00.000Z", "2026-10-24"));
    // A 4:30 AM Pacific EPL kickoff belongs to that date.
    assert.ok(inside("2026-10-24T11:30:00.000Z", "2026-10-24"));
  });

  test("a malformed date is refused, not guessed", () => {
    assert.throws(() => zonedMidnight("10/28/2026", SLATE_TIME_ZONE), /YYYY-MM-DD/);
  });
});

/* ---- wiring: what the tools actually ask SGO for ---- */
const capture = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; structuredContent?: any }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } } as never,
    handlers,
  };
};
const recordingSgo = (calls: any[]) =>
  ({
    leagueIDFor: () => "NBA",
    lastFetchTruncated: false,
    getAllEvents: async (q: any) => { calls.push(q); return []; },
    getEvents: async (q: any) => { calls.push(q); return { data: [] }; },
  }) as never;

describe("tools use the Pacific day for `date`", () => {
  test("tkb_get_schedule date=2026-10-28 asks SGO for the Pacific window", async () => {
    const calls: any[] = [];
    const { server, handlers } = capture();
    registerScheduleTool(server, recordingSgo(calls));
    await handlers["tkb_get_schedule"]({ sport: "nba", date: "2026-10-28" } as never);
    assert.equal(calls[0].startsAfter, "2026-10-28T07:00:00.000Z");
    assert.equal(calls[0].startsBefore, "2026-10-29T06:59:59.000Z");
  });

  test("explicit startsAfter/startsBefore are passed through EXACTLY (what every scheduled run uses)", async () => {
    const calls: any[] = [];
    const { server, handlers } = capture();
    registerScheduleTool(server, recordingSgo(calls));
    await handlers["tkb_get_schedule"]({
      sport: "nhl",
      startsAfter: "2026-10-28T15:00:00Z",
      startsBefore: "2026-10-29T12:00:00Z",
    } as never);
    assert.equal(calls[0].startsAfter, "2026-10-28T15:00:00Z");
    assert.equal(calls[0].startsBefore, "2026-10-29T12:00:00Z");
  });

  test("tkb_get_game_lines date=2026-10-28 asks SGO for the Pacific window", async () => {
    const calls: any[] = [];
    const { server, handlers } = capture();
    registerGameLinesTool(server, recordingSgo(calls));
    await handlers["tkb_get_game_lines"]({
      sport: "nba",
      date: "2026-10-28",
      markets: ["moneyline"],
      preferredBookmakers: "draftkings",
    } as never);
    const ranged = calls.find((c) => c.startsAfter);
    assert.ok(ranged, "a ranged fetch was made");
    assert.equal(ranged.startsAfter, "2026-10-28T07:00:00.000Z");
    assert.equal(ranged.startsBefore, "2026-10-29T06:59:59.000Z");
  });
});
