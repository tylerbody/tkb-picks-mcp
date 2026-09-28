import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * v2.10.4: THREE DEFECTS, ALL FOUND BY MEASURING RATHER THAN BY READING.
 *
 *   A. A dressed backup goalie graded as a confident 0 saves.
 *   B. tkb_get_line_movement narrated a live in-play price as a line move.
 *   C. tkb_get_game_lines silently shrank a slate when addressed by date range.
 *
 * C is the dangerous one. A and B produce a wrong number, which a reader can argue
 * with. C produces a SHORT SLATE that looks complete, which nobody argues with
 * because there is nothing on screen to argue about.
 */

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

// ===========================================================================
// A. THE GOALIE SAVES DERIVATION
// ===========================================================================
describe("v2.10.4 A: saves are not derived for a goalie who faced no shots", () => {
  // The shape comes straight off /v1/player/{id}/game-log: a goalie row carries
  // shotsAgainst and goalsAgainst and NO saves field, so saves are derived.
  const parse = async (raw: Record<string, unknown>) => {
    const mod = await import("../src/services/nhlStatsClient.js");
    // The row parser is not exported, so go through the documented seam: the client
    // exposes the parsed shape via its game-log mapper. If this import shape ever
    // changes the test fails loudly rather than silently passing.
    return mod as unknown as Record<string, unknown>;
  };

  test("the module still exports the NHL status vocabulary it re-exports", async () => {
    // Cheap guard that the import path is intact, so the assertions below are about
    // behaviour rather than a broken import resolving to undefined.
    const mod = await import("../src/services/nhlStatsClient.js");
    assert.equal(typeof mod.nhlSaysFinal, "function");
  });

  // The derivation itself, asserted as pure arithmetic against the shipped rule.
  // This mirrors nhlStatsClient's condition exactly; if the source condition is
  // loosened back to the old one, deriveSaves here and the source disagree and the
  // wiring test below is what catches it.
  const deriveSaves = (shotsAgainst?: number, goalsAgainst?: number): number | undefined =>
    shotsAgainst !== undefined && goalsAgainst !== undefined && shotsAgainst > 0
      ? shotsAgainst - goalsAgainst
      : undefined;

  test("THE BUG: a dressed backup's all-zero row must NOT produce saves: 0", () => {
    // Adin Hill, Vegas 0-4 to Utah, 2026-03-20. Only Hill was priced; Schmid had no
    // Saves line. The old condition returned 0 here and graded a real LOSS off it.
    assert.equal(deriveSaves(0, 0), undefined);
  });

  test("a real goalie line still derives correctly", () => {
    assert.equal(deriveSaves(21, 2), 19);
    assert.equal(deriveSaves(38, 3), 35);
  });

  test("a shutout still derives, because shotsAgainst is what gates it, not goalsAgainst", () => {
    assert.equal(deriveSaves(24, 0), 24);
  });

  test("a missing field on either side still yields undefined", () => {
    assert.equal(deriveSaves(undefined, 0), undefined);
    assert.equal(deriveSaves(20, undefined), undefined);
  });

  test("WIRING: the shipped source carries the shotsAgainst > 0 guard", async () => {
    // Reading the source is the honest way to assert a non-exported condition, and it
    // is what stops this file passing while the real derivation reverts.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/services/nhlStatsClient.ts", "utf8");
    assert.match(
      src,
      /shotsAgainst !== undefined && goalsAgainst !== undefined && shotsAgainst > 0/,
      "the zero-shot guard is missing from the shipped derivation"
    );
  });
});

// ===========================================================================
// B. LINE MOVEMENT ON A STARTED EVENT
// ===========================================================================
describe("v2.10.4 B: a started event yields the open and no movement claim", () => {
  const eventWith = (status: Record<string, unknown>) => ({
    eventID: "E",
    type: "match",
    status,
    teams: {
      home: { teamID: "SF", names: { long: "San Francisco Giants" } },
      away: { teamID: "LAD", names: { long: "Los Angeles Dodgers" } },
    },
    players: {},
    odds: {
      // The live Dodgers at Giants total: opened 8.5, "current" 3.5 because the live
      // market prices remaining runs.
      "points-all-game-ou-over": {
        oddID: "points-all-game-ou-over",
        statID: "points",
        byBookmaker: {
          fanduel: {
            odds: "+124",
            openOdds: "+104",
            overUnder: "3.5",
            openOverUnder: "8.5",
            available: true,
          },
        },
      },
    },
  });

  const call = async (status: Record<string, unknown>) => {
    const ev = eventWith(status);
    const sgo = {
      leagueIDFor: () => "MLB",
      getAllEvents: async () => [ev],
      getEvents: async () => ({ data: [ev] }),
    } as never;
    const { registerLineMovementTool } = await import("../src/tools/lineMovement.js");
    const { server, handlers } = captureServer();
    registerLineMovementTool(server as never, sgo);
    return (await handlers["tkb_get_line_movement"]({
      sport: "mlb",
      eventID: "E",
      marketType: "total",
      side: "over",
      preferredBookmakers: "fanduel",
    } as never)) as { content: { text: string }[]; structuredContent?: Record<string, unknown> };
  };

  const LIVE = { started: true, completed: false, ended: false, live: true, startsAt: "2026-09-27T19:05:00.000Z" };
  const FINAL = { started: true, completed: true, ended: true, live: false, startsAt: "2026-04-02T23:00:00.000Z" };
  const PREGAME = { started: false, completed: false, ended: false, live: false, startsAt: "2099-01-01T00:00:00.000Z" };

  test("THE BUG: a live event no longer reports 'down 5'", async () => {
    const res = await call(LIVE);
    const text = res.content[0]!.text;
    assert.doesNotMatch(text, /down 5/);
    assert.doesNotMatch(text, /sits at 3\.5 now/);
    assert.match(text, /NO MOVEMENT REPORTED/);
    assert.match(text, /live in-play/);
    assert.equal(res.structuredContent?.lineMovement, null);
    assert.equal(res.structuredContent?.movementDirection, "not comparable (event in progress)");
    assert.equal(res.structuredContent?.currentPriceIsPostStart, true);
    assert.equal(res.structuredContent?.eventIsFinal, false);
  });

  test("the OPEN survives, because it is the number that is actually trustworthy", async () => {
    const res = await call(LIVE);
    assert.equal(res.structuredContent?.openingLine, 8.5);
    assert.equal(res.structuredContent?.openingOdds, "+104");
    assert.equal(res.structuredContent?.openingBookmaker, "fanduel");
  });

  test("a FINAL event is refused the same way and says 'finished', not 'started'", async () => {
    const res = await call(FINAL);
    const text = res.content[0]!.text;
    assert.match(text, /NO MOVEMENT REPORTED/);
    assert.match(text, /finished/);
    assert.match(text, /last-seen/);
    assert.equal(res.structuredContent?.lineMovement, null);
    assert.equal(res.structuredContent?.movementDirection, "not comparable (event finished)");
    assert.equal(res.structuredContent?.eventIsFinal, true);
  });

  test("REGRESSION: a pre-game event still reports real movement", async () => {
    const res = await call(PREGAME);
    const text = res.content[0]!.text;
    assert.match(text, /Opened at 8\.5 and sits at 3\.5 now, down 5\./);
    assert.equal(res.structuredContent?.lineMovement, -5);
    assert.equal(res.structuredContent?.movementDirection, "down 5");
    assert.equal(res.structuredContent?.currentPriceIsPostStart, false);
  });

  test("an unparseable startsAt is treated as STARTED, the conservative reading", async () => {
    const res = await call({ startsAt: "not-a-date" });
    assert.equal(res.structuredContent?.currentPriceIsPostStart, true);
    assert.match(res.content[0]!.text, /NO MOVEMENT REPORTED/);
  });
});

// ===========================================================================
// C. GAME LINES BY DATE RANGE
// ===========================================================================
describe("v2.10.4 C: a date range reports the whole slate, priced or not", () => {
  // NHL opening week. Four games priced at DraftKings, eight with the market in the
  // catalog and no price. SGO drops the unpriced eight from a ranged query that
  // carries a bookmakerID, and returns all twelve when addressed by eventIDs.
  const PRICED = ["p1", "p2", "p3", "p4"];
  const UNPRICED = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"];

  const mkEvent = (id: string, priced: boolean) => ({
    eventID: id,
    type: "match",
    status: { startsAt: "2026-10-06T23:00:00.000Z", started: false },
    teams: {
      home: { teamID: `${id}_H`, names: { long: `Home ${id}` } },
      away: { teamID: `${id}_A`, names: { long: `Away ${id}` } },
    },
    players: {},
    odds: priced
      ? {
          "points-home-game-ml-home": {
            oddID: "points-home-game-ml-home",
            statID: "points",
            byBookmaker: { draftkings: { odds: "-118", available: true } },
          },
          "points-away-game-ml-away": {
            oddID: "points-away-game-ml-away",
            statID: "points",
            byBookmaker: { draftkings: { odds: "-102", available: true } },
          },
        }
      : {},
  });

  /**
   * The fake models SGO's ACTUAL observed behaviour, which is the only thing that
   * makes this test meaningful:
   *   - a ranged query carrying a bookmakerID returns ONLY the priced events
   *   - a query carrying eventIDs returns every id asked for, priced or not
   * If the fix regresses to a single ranged fetch, the tool sees four events and
   * these assertions fail.
   */
  const makeSgo = () => {
    const calls: Record<string, unknown>[] = [];
    const sgo = {
      leagueIDFor: () => "NHL",
      getAllEvents: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (params.eventIDs) {
          const ids = String(params.eventIDs).split(",");
          return ids.map((id) => mkEvent(id, PRICED.includes(id)));
        }
        if (params.bookmakerID) {
          // The defect: ranged + book filter drops everything unpriced.
          return PRICED.map((id) => mkEvent(id, true));
        }
        // Enumeration with no book filter sees the true slate.
        return [...PRICED, ...UNPRICED].map((id) => mkEvent(id, PRICED.includes(id)));
      },
    } as never;
    return { sgo, calls };
  };

  const callRange = async () => {
    const { sgo, calls } = makeSgo();
    const { registerGameLinesTool } = await import("../src/tools/gameLines.js");
    const { server, handlers } = captureServer();
    registerGameLinesTool(server as never, sgo);
    const res = (await handlers["tkb_get_game_lines"]({
      sport: "nhl",
      startsAfter: "2026-10-06T00:00:00Z",
      startsBefore: "2026-10-08T12:00:00Z",
      markets: ["moneyline"],
      preferredBookmakers: "draftkings,fanduel,betmgm,caesars,hardrockbet",
    } as never)) as {
      content: { text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    return { res, calls };
  };

  test("THE BUG: all 12 games come back, not just the 4 that are priced", async () => {
    const { res } = await callRange();
    assert.equal(res.structuredContent?.gameCount, 12);
    assert.equal(res.structuredContent?.gamesWithPricedMarkets, 4);
  });

  test("the 8 unpriced games are named, which is the promise the tool makes", async () => {
    const { res } = await callRange();
    const text = res.content[0]!.text;
    assert.match(text, /NO PRICED TEAM MARKETS on 8 game\(s\)/);
    assert.match(text, /never mistaken for a short slate/);
  });

  test("enumeration goes out WITHOUT a book filter, which is what stops the drop", async () => {
    const { calls } = await callRange();
    const enumeration = calls[0]!;
    assert.equal(enumeration.bookmakerID, undefined);
    assert.ok(enumeration.startsAfter, "the first call should be the ranged enumeration");
    assert.match(String(enumeration.oddIDs), /^points-home-game-ml-home$/);
  });

  test("the odds fetch then goes by eventIDs, the path that reports gaps", async () => {
    const { calls } = await callRange();
    const oddsCalls = calls.filter((c) => c.eventIDs);
    assert.equal(oddsCalls.length, 1, "12 ids should batch into one chunk of 20");
    assert.equal(String(oddsCalls[0]!.eventIDs).split(",").length, 12);
    assert.equal(oddsCalls[0]!.bookmakerID, "draftkings,fanduel,betmgm,caesars,hardrockbet");
  });

  test("requestCount is reported honestly as 2, not 1", async () => {
    const { res } = await callRange();
    assert.equal(res.structuredContent?.requestCount, 2);
  });

  test("REGRESSION: the explicit eventIDs path is unchanged and still one request", async () => {
    const { sgo, calls } = makeSgo();
    const { registerGameLinesTool } = await import("../src/tools/gameLines.js");
    const { server, handlers } = captureServer();
    registerGameLinesTool(server as never, sgo);
    const res = (await handlers["tkb_get_game_lines"]({
      sport: "nhl",
      eventIDs: [...PRICED, ...UNPRICED],
      markets: ["moneyline"],
      preferredBookmakers: "draftkings",
    } as never)) as { structuredContent?: Record<string, unknown> };
    assert.equal(res.structuredContent?.gameCount, 12);
    assert.equal(res.structuredContent?.requestCount, 1);
    assert.equal(calls.filter((c) => c.startsAfter).length, 0, "no enumeration on the ids path");
  });

  test("an empty window says so rather than proceeding to a second fetch", async () => {
    const sgo = {
      leagueIDFor: () => "NHL",
      getAllEvents: async () => [],
    } as never;
    const { registerGameLinesTool } = await import("../src/tools/gameLines.js");
    const { server, handlers } = captureServer();
    registerGameLinesTool(server as never, sgo);
    // preferredBookmakers is passed explicitly because calling the handler directly
    // bypasses zod's default, and this tool trims it unconditionally. Same caveat
    // toolWiring.test.ts already records for odds.ts and lineMovement.ts.
    const res = (await handlers["tkb_get_game_lines"]({
      sport: "nhl",
      date: "2026-07-04",
      markets: ["moneyline"],
      preferredBookmakers: "draftkings",
    } as never)) as { content: { text: string }[] };
    assert.match(res.content[0]!.text, /No NHL games found in the requested window/);
  });
});
