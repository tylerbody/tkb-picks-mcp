import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { enumerateSlate } from "../src/services/slateEvents.js";
import { cleanName, sanitizeEventNames } from "../src/services/sgoClient.js";
import { registerScheduleTool } from "../src/tools/schedule.js";

/**
 * v2.20.2: NCAAB games hidden from every slate tool (2026-10-30). SGO returned 24
 * NCAAB events for Nov 1-12 while ESPN's Division I board lists Nov 2 games SGO
 * never returned. Every ranged fetch carried one moneyline oddID filter.
 */

const ev = (id: string, startsAt: string, extra: Record<string, unknown> = {}) => ({
  eventID: id,
  status: { startsAt },
  teams: { home: { teamID: `H_${id}`, names: { long: `Home ${id}` } }, away: { teamID: `A_${id}`, names: { long: `Away ${id}` } } },
  odds: { big: "payload" },
  players: { P: { name: "x" } },
  ...extra,
});

/* A fake SGO that DROPS events lacking the filtered oddID, the behaviour the
 * live NCAAB board suggests. */
const fakeSgo = (all: ReturnType<typeof ev>[], withLine: Set<string>, calls: any[] = [], opts: { failUnfiltered?: boolean } = {}) => ({
  lastFetchTruncated: false,
  leagueIDFor: () => "NCAAB",
  getAllEvents: async (q: any) => {
    calls.push({ kind: "filtered", ...q });
    return all.filter((e) => withLine.has(e.eventID)).map((e) => ({ ...e }));
  },
  getEvents: async (q: any) => {
    calls.push({ kind: "unfiltered", ...q });
    if (opts.failUnfiltered) throw new Error("SGO 500");
    // Two pages of 2, to prove paging.
    const start = q.cursor ? Number(q.cursor) : 0;
    const page = all.slice(start, start + 2).map((e) => ({ ...e }));
    const next = start + 2 < all.length ? String(start + 2) : undefined;
    return { data: page, nextCursor: next };
  },
}) as never;

const ALL = [ev("G1", "2026-11-02T16:00:00Z"), ev("G2", "2026-11-02T23:00:00Z"), ev("G3", "2026-11-03T00:00:00Z"), ev("G4", "2026-11-03T02:00:00Z")];

describe("enumerateSlate unions filtered and unfiltered passes", () => {
  test("games without the filtered line are FOUND, counted, and odds-stripped", async () => {
    const r = await enumerateSlate(fakeSgo(ALL, new Set(["G1"])), {
      leagueID: "NCAAB", startsAfter: "a", startsBefore: "b", oddIDs: "points-home-game-ml-home",
    });
    assert.deepEqual(r.events.map((e) => e.eventID), ["G1", "G2", "G3", "G4"]);
    assert.equal(r.filteredCount, 1);
    assert.equal(r.unfilteredCount, 4);
    assert.deepEqual(r.onlyUnfiltered.sort(), ["G2", "G3", "G4"]);
    const g2 = r.events.find((e) => e.eventID === "G2") as any;
    assert.deepEqual(g2.odds, {}, "unfiltered payload odds are stripped");
    const g1 = r.events.find((e) => e.eventID === "G1") as any;
    assert.deepEqual(g1.odds, { big: "payload" }, "filtered events keep their odds");
  });

  test("the unfiltered pass pages, never sends an oddIDs filter", async () => {
    const calls: any[] = [];
    await enumerateSlate(fakeSgo(ALL, new Set(), calls), { leagueID: "NCAAB", oddIDs: "x" });
    const unf = calls.filter((c) => c.kind === "unfiltered");
    assert.equal(unf.length, 2, "two pages");
    assert.ok(unf.every((c) => c.oddIDs === undefined));
  });

  test("an unfiltered failure keeps the filtered result and REPORTS the failure", async () => {
    const r = await enumerateSlate(fakeSgo(ALL, new Set(["G1"]), [], { failUnfiltered: true }), { leagueID: "NCAAB", oddIDs: "x" });
    assert.equal(r.events.length, 1);
    assert.match(r.unfilteredError!, /SGO 500/);
  });
});

describe("tkb_get_schedule shows the hidden games and says so", () => {
  test("4 games, 3 found only without the filter, and the note names it", async () => {
    const handlers: Record<string, (p: never) => Promise<any>> = {};
    registerScheduleTool({ registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h; } } as never, fakeSgo(ALL, new Set(["G1"])));
    const r = await handlers["tkb_get_schedule"]({ sport: "cbb", startsAfter: "2026-11-02T07:00:00Z", startsBefore: "2026-11-03T08:00:00Z" } as never);
    const text = r.content[0].text as string;
    assert.match(text, /Found 4 CBB game/);
    assert.match(text, /3 of these were returned ONLY by the unfiltered pass/);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    assert.equal(json.enumeration.foundOnlyWithoutFilter, 3);
  });
});

describe("team and player names are cleaned at the source", () => {
  test("the measured TAB is collapsed", () => {
    assert.equal(cleanName("Notre Dame of Maryland\tGators"), "Notre Dame of Maryland Gators");
    assert.equal(cleanName("  A \n B  "), "A B");
    assert.equal(cleanName(7), 7);
  });
  test("sanitizeEventNames cleans every name variant and player names", () => {
    const e: any = { teams: { home: { names: { long: "X\tY", short: "X\t" } }, away: { names: { long: "Z" } } }, players: { P: { name: "Cade\tCunningham" } } };
    sanitizeEventNames(e);
    assert.equal(e.teams.home.names.long, "X Y");
    assert.equal(e.teams.home.names.short, "X");
    assert.equal(e.players.P.name, "Cade Cunningham");
  });
});
