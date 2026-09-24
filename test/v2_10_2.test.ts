import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { extractOpeningFromBook, extractPricedLine, isBlockedBookmaker } from "../src/services/oddsPricing.js";
import { gameTotalStatFor } from "../src/constants.js";
import { readLiveStat } from "../src/tools/liveMonitor.js";
import { opponentNameFor } from "../src/tools/coverPlayer.js";

/* ===========================================================================
 * v2.10.2 - PRICING INTEGRITY
 *
 * Found by an audit prompted by one live observation: tkb_get_line_movement returned
 * an opening price of "-145" on an NHL event whose only two venues were polymarket
 * and kalshi, while correctly refusing the current price from the same event.
 * ======================================================================== */

const odd = (over: Record<string, unknown> = {}) =>
  ({
    oddID: "points-all-game-ou-over",
    statID: "points",
    ...over,
  }) as never;

describe("the OPENING price is held to the same rule as the current one", () => {
  test("THE BUG: a blocked venue is not an opening price source", () => {
    const r = extractOpeningFromBook(
      odd({ byBookmaker: { polymarket: { odds: "-150", openOdds: "-145" } } })
    );
    assert.equal(r.odds, undefined);
    assert.equal(r.bookmaker, undefined);
  });

  test("every blocked class is refused, not just prediction markets", () => {
    for (const venue of ["polymarket", "kalshi", "underdog", "prizepicks", "fliff", "bovada"]) {
      assert.equal(isBlockedBookmaker(venue), true, `${venue} should be blocked`);
      const r = extractOpeningFromBook(
        odd({ byBookmaker: { [venue]: { odds: "-150", openOdds: "-145" } } })
      );
      assert.equal(r.odds, undefined, `${venue} leaked an opening price`);
    }
  });

  test("a real book's open IS returned, with its name", () => {
    const r = extractOpeningFromBook(
      odd({ byBookmaker: { draftkings: { odds: "-115", openOdds: "-110", openOverUnder: "5.5" } } })
    );
    assert.equal(r.odds, "-110");
    assert.equal(r.line, "5.5");
    assert.equal(r.bookmaker, "draftkings");
  });

  test("IT PREFERS THE BOOK THE CURRENT PRICE CAME FROM, so a move is one venue's move", () => {
    const r = extractOpeningFromBook(
      odd({
        byBookmaker: {
          fanduel: { odds: "-120", openOdds: "-105", openOverUnder: "6.5" },
          draftkings: { odds: "-115", openOdds: "-110", openOverUnder: "5.5" },
        },
      }),
      "draftkings"
    );
    assert.equal(r.bookmaker, "draftkings");
    assert.equal(r.line, "5.5");
  });

  test("a blocked preferred book does not smuggle itself in via the preference", () => {
    const r = extractOpeningFromBook(
      odd({
        byBookmaker: {
          polymarket: { odds: "-150", openOdds: "-145" },
          draftkings: { odds: "-115", openOdds: "-110" },
        },
      }),
      "polymarket"
    );
    assert.equal(r.bookmaker, "draftkings");
    assert.equal(r.odds, "-110");
  });

  test("NO FALLBACK TO openBookOdds, which is a median across books", () => {
    // This is the precise shape of the live bug: top-level open fields present,
    // byBookmaker carrying only blocked venues.
    const r = extractOpeningFromBook(
      odd({
        openBookOdds: "-145",
        openOdds: "-145",
        byBookmaker: { polymarket: { odds: "-150", openOdds: "-145" } },
      })
    );
    assert.deepEqual(r, {});
  });

  test("an odd with no byBookmaker at all returns nothing rather than throwing", () => {
    assert.deepEqual(extractOpeningFromBook(odd({})), {});
    assert.deepEqual(extractOpeningFromBook(odd({ byBookmaker: {} })), {});
  });

  test("a book present but carrying no open fields is not a match", () => {
    const r = extractOpeningFromBook(
      odd({ byBookmaker: { draftkings: { odds: "-115" } } })
    );
    assert.deepEqual(r, {});
  });
});

describe("the LINE comes from the same book as the price", () => {
  test("THE BUG: a consensus line is no longer stamped with a book's name", () => {
    // draftkings quotes a price and no number; the top level carries a cross-book 4.5.
    // Publishing "OVER 4.5 (-115, DraftKings)" states a bet DraftKings is not offering.
    const r = extractPricedLine(
      odd({
        bookOverUnder: "4.5",
        byBookmaker: { draftkings: { odds: "-115", available: true } },
      }),
      { requireLine: true, marketDescription: "total over" }
    );
    assert.equal(r.priced, false);
    assert.match(r.reason ?? "", /NO LINE/);
  });

  test("the book's OWN line is used when it has one", () => {
    const r = extractPricedLine(
      odd({
        bookOverUnder: "4.5",
        byBookmaker: { draftkings: { odds: "-115", overUnder: "5.5", available: true } },
      }),
      { requireLine: true, marketDescription: "total over" }
    );
    assert.equal(r.priced, true);
    assert.equal(r.value?.line, "5.5");
    assert.equal(r.value?.bookmaker, "draftkings");
  });

  test("a MONEYLINE is unaffected, having no line by nature", () => {
    const r = extractPricedLine(
      odd({ byBookmaker: { fanduel: { odds: "+122", available: true } } }),
      { requireLine: false, marketDescription: "moneyline home" }
    );
    assert.equal(r.priced, true);
    assert.equal(r.value?.americanOdds, "+122");
  });
});

describe("a live TOTAL is only the score sum where the sport's total counts points", () => {
  test("the three sports whose totals are not points are known", () => {
    assert.equal(gameTotalStatFor("ufc"), "roundsCompleted");
    assert.equal(gameTotalStatFor("atp"), "games");
    assert.equal(gameTotalStatFor("wta"), "games");
  });

  test("and the ones that are", () => {
    for (const s of ["mlb", "nfl", "cfb", "cbb", "wnba", "epl", "ucl", "nhl"] as const) {
      assert.equal(gameTotalStatFor(s), "points", `${s} total should be points`);
    }
  });
});

describe("readLiveStat WIRING, not just the table it consults", () => {
  const ev = (home: number, away: number) =>
    ({
      eventID: "E",
      status: {},
      teams: { home: { score: home }, away: { score: away } },
    }) as never;

  const totalPick = { marketType: "total" as const, side: "over" as const, ref: "t" };

  test("an NHL total reads the score sum, because hockey goals ARE points", () => {
    assert.equal(readLiveStat("nhl", ev(3, 2), totalPick as never), 5);
  });

  test("MLB, NFL and basketball totals read the score sum", () => {
    for (const s of ["mlb", "nfl", "cfb", "wnba", "cbb"] as const) {
      assert.equal(readLiveStat(s, ev(4, 3), totalPick as never), 7);
    }
  });

  test("THE BUG: a UFC rounds total must NOT be read as a scorecard sum", () => {
    // A CLEARED verdict here is read as "safe to post as cashed".
    assert.equal(readLiveStat("ufc", ev(3, 2), totalPick as never), null);
  });

  test("a tennis games total must NOT be read as a set-score sum", () => {
    assert.equal(readLiveStat("atp", ev(2, 1), totalPick as never), null);
    assert.equal(readLiveStat("wta", ev(2, 0), totalPick as never), null);
  });

  test("a missing score is null, not a zero-sum total", () => {
    const missing = { eventID: "E", status: {}, teams: { home: {}, away: { score: 2 } } } as never;
    assert.equal(readLiveStat("nhl", missing, totalPick as never), null);
  });

  test("a non-match event is null rather than a throw", () => {
    const futures = { eventID: "F", status: {}, type: "futures" } as never;
    assert.equal(readLiveStat("nhl", futures, totalPick as never), null);
  });
});

describe("the cover-player opponent name, which was wrong for months", () => {
  const game = (homeID: string, awayID: string) =>
    ({
      eventID: "E",
      status: {},
      teams: {
        home: { teamID: homeID, names: { long: "Seattle Mariners" } },
        away: { teamID: awayID, names: { long: "Houston Astros" } },
      },
    }) as never;

  test("a HOME player's opponent is the away team", () => {
    assert.equal(opponentNameFor(game("SEA", "HOU"), "SEA"), "Houston Astros");
  });

  test("THE BUG: an AWAY player's opponent is the HOME team, not his own club", () => {
    // The old code compared a teamID to a playerID, always fell through, and returned
    // the away name - which for an away player is his own team.
    assert.equal(opponentNameFor(game("SEA", "HOU"), "HOU"), "Seattle Mariners");
  });

  test("a team that is on neither side yields NO opponent rather than a guess", () => {
    assert.equal(opponentNameFor(game("SEA", "HOU"), "NYY"), "");
  });

  test("a non-match event yields no opponent rather than throwing", () => {
    assert.equal(opponentNameFor({ eventID: "F", type: "futures" } as never, "SEA"), "");
  });
});

/* ===========================================================================
 * WIRING TESTS, using the captureServer harness test/toolWiring.test.ts established.
 *
 * Both seams below survived a mutation earlier in this release's own mutation run,
 * which is the whole argument that file makes: a perfect helper called in the wrong
 * place produces exactly the bug it was written to prevent.
 * ======================================================================== */

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

describe("tkb_get_line_movement never sources an open from a blocked venue", () => {
  // The live shape: an NHL moneyline whose only venues are polymarket and kalshi, with
  // top-level open fields populated.
  const EVENT = {
    eventID: "1kIsBNnatHS8omjztd4G",
    status: { startsAt: "2026-09-25T23:30:00.000Z", displayShort: "" },
    teams: {
      home: { teamID: "NEW_YORK_ISLANDERS_NHL", names: { long: "New York Islanders" } },
      away: { teamID: "NEW_YORK_RANGERS_NHL", names: { long: "New York Rangers" } },
    },
    odds: {
      "points-home-game-ml-home": {
        oddID: "points-home-game-ml-home",
        statID: "points",
        openBookOdds: "-145",
        openOdds: "-145",
        fairOdds: "+109",
        byBookmaker: {
          polymarket: { odds: "-150", openOdds: "-145", available: true },
          kalshi: { odds: "-148", openOdds: "-142", available: true },
        },
      },
    },
  };

  const fakeSgo = {
    leagueIDFor: () => "NHL",
    getAllEvents: async () => [EVENT],
    getEvents: async () => ({ data: [EVENT] }),
  } as never;

  test("THE BUG: openingOdds is null, where it used to report the Polymarket median", async () => {
    const { registerLineMovementTool } = await import("../src/tools/lineMovement.js");
    const { server, handlers } = captureServer();
    registerLineMovementTool(server as never, fakeSgo);
    const res = (await handlers["tkb_get_line_movement"]({
      sport: "nhl",
      eventID: "1kIsBNnatHS8omjztd4G",
      marketType: "moneyline",
      side: "home",
      preferredBookmakers: "all",
    } as never)) as { structuredContent?: Record<string, unknown> };

    // "all" disables the BOOK FILTER on the request, not the block list on pricing.
    assert.equal(res.structuredContent?.openingOdds ?? null, null);
    assert.equal(res.structuredContent?.openingBookmaker ?? null, null);
    assert.equal(res.structuredContent?.currentOdds ?? null, null);
  });

  test("a REAL book on the same event does yield an attributed open", async () => {
    const withBook = {
      ...EVENT,
      odds: {
        "points-home-game-ml-home": {
          ...EVENT.odds["points-home-game-ml-home"],
          byBookmaker: {
            polymarket: { odds: "-150", openOdds: "-145", available: true },
            draftkings: { odds: "-155", openOdds: "-135", available: true },
          },
        },
      },
    };
    const sgo2 = {
      leagueIDFor: () => "NHL",
      getAllEvents: async () => [withBook],
      getEvents: async () => ({ data: [withBook] }),
    } as never;
    const { registerLineMovementTool } = await import("../src/tools/lineMovement.js");
    const { server, handlers } = captureServer();
    registerLineMovementTool(server as never, sgo2);
    const res = (await handlers["tkb_get_line_movement"]({
      sport: "nhl",
      eventID: "E",
      marketType: "moneyline",
      side: "home",
      preferredBookmakers: "all",
    } as never)) as { structuredContent?: Record<string, unknown> };

    assert.equal(res.structuredContent?.openingOdds, "-135");
    assert.equal(res.structuredContent?.openingBookmaker, "draftkings");
  });
});

describe("tkb_scan_streaks reports staleness on every finding", () => {
  // Three games, all from May, read in September: "3 straight" is arithmetically true
  // and the sentence is false.
  const STALE_ROWS = [
    { game: { date: "2026-05-02", home_team_id: 1, visitor_team_id: 2 }, pts: 30, player: { id: 9 } },
    { game: { date: "2026-04-30", home_team_id: 1, visitor_team_id: 2 }, pts: 28, player: { id: 9 } },
    { game: { date: "2026-04-28", home_team_id: 1, visitor_team_id: 2 }, pts: 26, player: { id: 9 } },
  ];

  // The real method names, read off the tool: searchPlayers then getAllPlayerGameStats.
  const fakeBdl = {
    searchPlayers: async () => ({
      data: [{ id: 9, first_name: "Test", last_name: "Player", team: { id: 1 } }],
    }),
    getAllPlayerGameStats: async () => STALE_ROWS,
  } as never;

  const run = async () => {
    const { registerStreakScanTool } = await import("../src/tools/streakScan.js");
    const { server, handlers } = captureServer();
    registerStreakScanTool(server as never, fakeBdl);
    return (await handlers["tkb_scan_streaks"]({
      sport: "wnba",
      playerNames: ["Test Player"],
      statID: "points",
      threshold: 20,
      minStreak: 3,
      lookback: 10,
    } as never)) as { content: { text: string }[] };
  };

  test("THE HARNESS REALLY PRODUCES A FINDING, so the assertion below is not vacuous", async () => {
    // A conditional assertion on a tool that silently returned nothing is how a
    // mutation survives a test that looks like it covers it. This test exists to make
    // the next one meaningful.
    const text = (await run()).content?.[0]?.text ?? "";
    assert.match(text, /straight games/);
  });

  test("THE BUG: a streak from four months ago is flagged as not current", async () => {
    const text = (await run()).content?.[0]?.text ?? "";

    // ASSERT ON THE FIELD, NOT ON THE WORD. A first version of this matched /STALE/
    // anywhere in the response and passed even with staleWarning forced to null, because
    // the nested `recency.warning` string also contains "STALE SAMPLE". A mutation
    // survived a test that read as though it covered it - the same shape of mistake this
    // whole release is about.
    // The JSON block is followed by the stale note and the skip note, so slice to the
    // LAST bracket rather than to the end of the string.
    const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
    const findings = JSON.parse(json) as { staleWarning: string | null; headline: string }[];
    assert.ok(findings.length > 0, "harness produced no findings");
    assert.ok(
      findings[0].staleWarning && findings[0].staleWarning.length > 0,
      "staleWarning must be populated on a four-month-old streak"
    );
    assert.match(findings[0].staleWarning ?? "", /STALE SAMPLE/);
    assert.match(text, /STALE: 1 of 1 finding/);
  });
});
