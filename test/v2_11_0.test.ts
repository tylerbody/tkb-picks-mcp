import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  YES_NO_MARKETS,
  OU_PROP_MARKETS,
  yesNoGradingFor,
} from "../src/services/marketCatalog.js";
import {
  buildYesNoRows,
  crossCheckYesNo,
  lineMatches,
  americanIsLonger,
  buildBoardRows,
  type YesNoPricedSide,
  type PricedSide,
} from "../src/tools/propBoard.js";

/**
 * v2.11.0: yes/no markets on the board, the mapping cross-check, the line-shopping
 * bug, and yes/no grading.
 */

// ---------------------------------------------------------------------------
// 1. Gradeability is DERIVED, so it cannot drift from the over/under catalog.
// ---------------------------------------------------------------------------

describe("v2.11.0 yes/no gradeability", () => {
  test("gradeable exactly when the statID has an over/under counterpart", () => {
    for (const sport of Object.keys(YES_NO_MARKETS) as (keyof typeof YES_NO_MARKETS)[]) {
      for (const m of YES_NO_MARKETS[sport]) {
        const hasOU = OU_PROP_MARKETS[sport].some((o) => o.statID === m.statID);
        assert.equal(
          yesNoGradingFor(sport, m.statID).gradeable,
          hasOU,
          `${sport} ${m.label}`
        );
      }
    }
  });

  /* THE SET THIS LANDS ON, pinned. These are the markets that genuinely cannot be
   * settled from a stat total, and the derivation reaching exactly them is the evidence
   * that the rule is the right rule rather than a convenient one. */
  test("every ordering, composite and outcome market is refused", () => {
    const refused = [
      ["mlb", "First Home Run"],
      ["mlb", "Pitching Win"],
      ["wnba", "Double-Double"],
      ["wnba", "Triple-Double"],
      ["wnba", "First Basket"],
      ["cbb", "Double-Double"],
      ["cbb", "Triple-Double"],
      ["cbb", "First Basket"],
      ["nfl", "First Touchdown"],
      ["nfl", "Last Touchdown"],
      ["cfb", "First Touchdown"],
      ["cfb", "Last Touchdown"],
      ["epl", "First To Score"],
      ["epl", "Last To Score"],
      ["epl", "Both Teams To Score"],
      ["ufc", "Win By Decision"],
      ["ufc", "Win By Knockout / TKO"],
      ["ufc", "Win By Submission"],
    ] as const;
    for (const [sport, label] of refused) {
      const m = YES_NO_MARKETS[sport].find((x) => x.label === label)!;
      assert.ok(m, `${sport} has no ${label}`);
      assert.equal(yesNoGradingFor(sport, m.statID).gradeable, false, `${sport} ${label}`);
    }
  });

  test("and every NHL yes/no market IS gradeable, which is the release's claim", () => {
    for (const m of YES_NO_MARKETS.nhl) {
      assert.equal(yesNoGradingFor("nhl", m.statID).gradeable, true, m.label);
    }
  });

  /* The two countable-but-unmapped markets get their OWN reason, because "this is an
   * ordering market" would be a wrong explanation for a yellow card. */
  test("countable-but-unmapped markets say why they are really refused", () => {
    const yc = yesNoGradingFor("epl", "yellowCards");
    assert.equal(yc.gradeable, false);
    assert.match((yc as { reason: string }).reason, /no stat map/);
    const sf = yesNoGradingFor("nfl", "defense_safeties");
    assert.match((sf as { reason: string }).reason, /no stat map/);
    // While a true ordering market gets the other explanation.
    const fb = yesNoGradingFor("wnba", "firstBasket");
    assert.match((fb as { reason: string }).reason, /ordering, composite or outcome/);
  });

  test("a sport with no yes/no catalog resolves without throwing", () => {
    assert.deepEqual(YES_NO_MARKETS.atp, []);
    assert.equal(yesNoGradingFor("atp", "points").gradeable, false);
  });
});

// ---------------------------------------------------------------------------
// 2. The line-shopping bug.
// ---------------------------------------------------------------------------

describe("v2.11.0 betterPriceAvailable is confined to the row's line", () => {
  const side = (over: Partial<PricedSide> = {}): PricedSide => ({
    playerID: "P",
    statID: "rebounds",
    side: "over",
    line: 4.5,
    americanOdds: "-164",
    bookmaker: "draftkings",
    ...over,
  });
  const resolve = {
    playerName: () => "Courtney Williams",
    team: () => "Minnesota Lynx",
    marketLabel: () => "Rebounds",
  };

  /* THE MEASURED CASE, 2026-09-29. The row was under 4.5 at -164 and the board said a
   * better price of +120 was available. That +120 was Caesars quoting 3.5. Shopping on
   * it means taking a different bet believing you found 284 cents. */
  test("a longer price at another line is NOT reported as a better price", () => {
    const rows = buildBoardRows(
      [
        side({
          allBooks: [
            { bookmaker: "caesars", americanOdds: "+120", line: "3.5" },
            { bookmaker: "draftkings", americanOdds: "-164", line: "4.5" },
          ],
        }),
      ],
      resolve
    );
    assert.equal(rows[0].over!.betterPriceAvailable, false);
    assert.equal(rows[0].over!.bestPrice!.bookmaker, "draftkings");
    assert.equal(rows[0].over!.bestPrice!.line, "4.5");
  });

  test("it is reported SEPARATELY, labelled as a different bet", () => {
    const rows = buildBoardRows(
      [
        side({
          allBooks: [
            { bookmaker: "caesars", americanOdds: "+120", line: "3.5" },
            { bookmaker: "draftkings", americanOdds: "-164", line: "4.5" },
          ],
        }),
      ],
      resolve
    );
    const off = rows[0].over!.betterPriceAtDifferentLine!;
    assert.equal(off.bookmaker, "caesars");
    assert.equal(off.line, "3.5");
    assert.match(off.note, /DIFFERENT BET/);
    assert.match(off.note, /not 4\.5/);
  });

  test("a genuinely better price AT the row's line is still reported", () => {
    const rows = buildBoardRows(
      [
        side({
          allBooks: [
            { bookmaker: "fanduel", americanOdds: "-114", line: "4.5" },
            { bookmaker: "draftkings", americanOdds: "-164", line: "4.5" },
          ],
        }),
      ],
      resolve
    );
    assert.equal(rows[0].over!.betterPriceAvailable, true);
    assert.equal(rows[0].over!.bestPrice!.bookmaker, "fanduel");
    assert.equal(rows[0].over!.betterPriceAtDifferentLine, null);
  });

  test("bookCountAtLine separates the field on this bet from the field overall", () => {
    const rows = buildBoardRows(
      [
        side({
          allBooks: [
            { bookmaker: "caesars", americanOdds: "+120", line: "3.5" },
            { bookmaker: "fanduel", americanOdds: "-120", line: "4.5" },
            { bookmaker: "draftkings", americanOdds: "-164", line: "4.5" },
          ],
        }),
      ],
      resolve
    );
    assert.equal(rows[0].over!.bookCount, 3);
    assert.equal(rows[0].over!.bookCountAtLine, 2);
  });

  test("an entry with no line is not assumed to match", () => {
    assert.equal(lineMatches(undefined, 4.5), false);
    assert.equal(lineMatches("4.5", 4.5), true);
    assert.equal(lineMatches("3.5", 4.5), false);
    assert.equal(lineMatches("not a number", 4.5), false);
  });

  test("longer is better on either side of an over/under", () => {
    assert.equal(americanIsLonger("+120", "-164"), true);
    assert.equal(americanIsLonger("-110", "-120"), true);
    assert.equal(americanIsLonger("-120", "-110"), false);
  });
});

// ---------------------------------------------------------------------------
// 3. The cross-check, and the false alarm it must not raise.
// ---------------------------------------------------------------------------

describe("v2.11.0 the yes/no cross-check is book-pinned", () => {
  const yesSide = {
    americanOdds: "+1800",
    roundedOdds: "+1800",
    bookmaker: "fanduel",
    allBooks: [
      { bookmaker: "fanduel", americanOdds: "+1800" },
      { bookmaker: "espnbet", americanOdds: "+750" },
    ],
  };

  /* THE EXACT FALSE ALARM I REPEATED AS FACT FOR SEVERAL TURNS. FanDuel prices Carrier
   * anytime goalscorer at +1800; the board showed +750 from ESPN Bet, which is the only
   * book with a 0.5 goals line on him. Unpinned that reads as a broken mapping. Pinned,
   * ESPN Bet's two numbers agree exactly. */
  test("it compares within one book and finds agreement, not a phantom mismatch", () => {
    const cc = crossCheckYesNo(yesSide, [
      { bookmaker: "espnbet", americanOdds: "+750", line: "0.5" },
    ]);
    assert.equal(cc.status, "agrees");
    assert.equal(cc.book, "espnbet");
    assert.equal(cc.yesPrice, "+750");
    assert.equal(cc.overPrice, "+750");
  });

  test("a real mismatch inside one book IS reported and says do not post", () => {
    const cc = crossCheckYesNo(yesSide, [
      { bookmaker: "fanduel", americanOdds: "+400", line: "0.5" },
    ]);
    assert.equal(cc.status, "mismatch");
    assert.equal(cc.book, "fanduel");
    assert.match(cc.detail, /MISMATCH at fanduel/);
    assert.match(cc.detail, /do not post/i);
  });

  test("no shared book means no verdict, never a cross-book comparison", () => {
    const cc = crossCheckYesNo(yesSide, [
      { bookmaker: "betmgm", americanOdds: "+900", line: "0.5" },
    ]);
    assert.equal(cc.status, "no_comparable_line");
    assert.equal(cc.book, null);
    assert.match(cc.detail, /false mapping alarm/);
  });

  test("no 0.5 market at all is reported as such, not as agreement", () => {
    const cc = crossCheckYesNo(yesSide, []);
    assert.equal(cc.status, "no_comparable_line");
  });

  test("no yes price means nothing to check", () => {
    const cc = crossCheckYesNo(null, [
      { bookmaker: "fanduel", americanOdds: "+400", line: "0.5" },
    ]);
    assert.equal(cc.status, "no_comparable_line");
    assert.equal(cc.yesPrice, null);
  });
});

// ---------------------------------------------------------------------------
// 4. buildYesNoRows.
// ---------------------------------------------------------------------------

describe("v2.11.0 buildYesNoRows", () => {
  const mk = (over: Partial<YesNoPricedSide>): YesNoPricedSide => ({
    playerID: "CARRIER",
    statID: "points",
    side: "yes",
    americanOdds: "+750",
    bookmaker: "espnbet",
    ...over,
  });
  const resolve = {
    playerName: () => "Alexandre Carrier",
    team: () => "Montreal Canadiens",
    marketLabel: (statID: string) =>
      statID === "points" ? "Anytime Goalscorer" : statID === "firstBasket" ? "First Basket" : undefined,
    grading: (statID: string) => yesNoGradingFor("nhl", statID),
    overAtHalf: () => [{ bookmaker: "espnbet", americanOdds: "+750", line: "0.5" }],
  };

  test("both sides collapse into one row", () => {
    const rows = buildYesNoRows(
      [mk({}), mk({ side: "no", americanOdds: "-1100", bookmaker: "espnbet" })],
      resolve
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sidesPriced, 2);
    assert.equal(rows[0].yes!.americanOdds, "+750");
    assert.equal(rows[0].no!.americanOdds, "-1100");
  });

  test("a yes-only market is KEPT, same rule as a one-sided over/under", () => {
    const rows = buildYesNoRows([mk({})], resolve);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sidesPriced, 1);
    assert.equal(rows[0].no, null);
  });

  test("the row carries gradeability, so an ungradeable pick is visible before posting", () => {
    const rows = buildYesNoRows([mk({})], resolve);
    assert.equal(rows[0].gradeable, true);
    assert.equal(rows[0].gradingNote, null);
  });

  test("and names the reason when it cannot be graded", () => {
    const rows = buildYesNoRows(
      [mk({ statID: "firstBasket" })],
      { ...resolve, grading: (s: string) => yesNoGradingFor("wnba", s) }
    );
    assert.equal(rows[0].gradeable, false);
    assert.match(rows[0].gradingNote!, /ordering, composite or outcome/);
  });

  test("the cross-check is attached per row", () => {
    const rows = buildYesNoRows([mk({})], resolve);
    assert.equal(rows[0].crossCheck!.status, "agrees");
  });

  test("a statID with no label falls back to the statID rather than undefined", () => {
    const rows = buildYesNoRows([mk({ statID: "mystery" })], resolve);
    assert.equal(rows[0].market, "mystery");
  });

  test("rows are ordered deterministically", () => {
    const rows = buildYesNoRows(
      [
        mk({ playerID: "B", statID: "assists" }),
        mk({ playerID: "A", statID: "points" }),
      ],
      {
        ...resolve,
        playerName: (id: string) => id,
        marketLabel: (s: string) => s,
      }
    );
    assert.deepEqual(rows.map((r) => r.playerName), ["A", "B"]);
  });
});

// ---------------------------------------------------------------------------
// 5. THE WIRING. Pure logic passing is not the same as the tool working - that is
// exactly how v2.10.5 shipped a bug that the first live call caught. These drive the
// registered handlers.
// ---------------------------------------------------------------------------

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

const PID = "AUSTON_MATTHEWS_1_NHL";
const bk = (odds: string, ou?: string) => ({
  byBookmaker: { draftkings: { odds, ...(ou ? { overUnder: ou } : {}), available: true } },
});

const NHL_EVENT = {
  eventID: "yUMfLBPE969Sg5mb5R1B",
  type: "match",
  status: { started: false, startsAt: "2026-09-30T23:00:00.000Z" },
  teams: {
    home: { teamID: "TORONTO_MAPLE_LEAFS_NHL", names: { long: "Toronto Maple Leafs" } },
    away: { teamID: "MONTREAL_CANADIENS_NHL", names: { long: "Montreal Canadiens" } },
  },
  players: {
    [PID]: { playerID: PID, name: "Auston Matthews", teamID: "TORONTO_MAPLE_LEAFS_NHL" },
  },
  odds: {
    // Over/under at 0.5, which is what the cross-check compares against.
    [`points-${PID}-game-ou-over`]: bk("+120", "0.5"),
    [`points-${PID}-game-ou-under`]: bk("-150", "0.5"),
    // The same bet as a yes/no. Same book, same price: must cross-check as agreeing.
    [`points-${PID}-game-yn-yes`]: bk("+120"),
    [`points-${PID}-game-yn-no`]: bk("-150"),
    // A yes/no market that cannot be graded. NHL has no such market, so this one is
    // not in the NHL yes/no catalog at all and must land in notInCatalog.
    [`firstBasket-${PID}-game-yn-yes`]: bk("+400"),
    // A yes/no on a period, which the full-game board must not take.
    [`points-${PID}-1p-yn-yes`]: bk("+900"),
    // A moneyline, which belongs to otherBetTypes.
    ["points-home-game-ml-home"]: bk("-130"),
  },
};

const callNhlBoard = async (extra: Record<string, unknown> = {}) => {
  const sgo = { leagueIDFor: () => "NHL", getAllEvents: async () => [NHL_EVENT] } as never;
  const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
  const { server, handlers } = captureServer();
  registerPropBoardTool(server as never, sgo);
  const res = (await handlers["tkb_get_prop_board"]({
    sport: "nhl",
    eventID: "yUMfLBPE969Sg5mb5R1B",
    preferredBookmakers: "draftkings",
    includeUnpriced: false,
    includeAllBooks: false,
    includeAltLines: false,
    includeYesNo: false,
    ...extra,
  } as never)) as { structuredContent?: Record<string, unknown>; content: { text: string }[] };
  return res;
};

describe("v2.11.0 yes/no markets reach the board handler", () => {
  test("they are BUILT even when not requested, so the count is never a guess", async () => {
    const res = await callNhlBoard();
    assert.equal(res.structuredContent?.yesNoRowsBuilt, 1);
    assert.equal(res.structuredContent?.yesNoRowsReturned, 0);
    assert.equal(res.structuredContent?.yesNoRows, undefined);
  });

  test("and the summary text tells you they are there", async () => {
    const res = await callNhlBoard();
    assert.match(res.content[0].text, /1 YES\/NO milestone market\(s\) are priced/);
    assert.match(res.content[0].text, /Pass includeYesNo/);
  });

  test("includeYesNo returns them as their own array, not mixed into rows", async () => {
    const res = await callNhlBoard({ includeYesNo: true });
    const ou = res.structuredContent!.rows as { market: string }[];
    const yn = res.structuredContent!.yesNoRows as { market: string; statID: string }[];
    assert.equal(yn.length, 1);
    assert.equal(yn[0].market, "Anytime Goalscorer");
    // The over/under section is untouched: `points` there is labelled Goals.
    assert.deepEqual(ou.map((r) => r.market), ["Goals"]);
  });

  test("both yes/no sides are carried", async () => {
    const res = await callNhlBoard({ includeYesNo: true });
    const yn = res.structuredContent!.yesNoRows as {
      yes: { americanOdds: string } | null;
      no: { americanOdds: string } | null;
      sidesPriced: number;
    }[];
    assert.equal(yn[0].sidesPriced, 2);
    assert.equal(yn[0].yes!.americanOdds, "+120");
    assert.equal(yn[0].no!.americanOdds, "-150");
  });

  /* THE END-TO-END MAPPING CHECK. The fixture prices anytime goalscorer and goals over
   * 0.5 identically at one book, which is what the same bet must do. */
  test("the cross-check runs through the handler and agrees", async () => {
    const res = await callNhlBoard({ includeYesNo: true });
    const yn = res.structuredContent!.yesNoRows as { crossCheck: { status: string; book: string } }[];
    assert.equal(yn[0].crossCheck.status, "agrees");
    assert.equal(yn[0].crossCheck.book, "draftkings");
    const cov = res.structuredContent!.coverage as {
      yesNo: { crossCheck: { agrees: number; mismatch: number } };
    };
    assert.equal(cov.yesNo.crossCheck.agrees, 1);
    assert.equal(cov.yesNo.crossCheck.mismatch, 0);
  });

  test("a yes/no statID outside this sport's catalog is named as drift, not silent", async () => {
    const res = await callNhlBoard();
    const cov = res.structuredContent!.coverage as {
      yesNo: { dropped: Record<string, number>; statIDsNotInCatalog: Record<string, number> };
    };
    assert.equal(cov.yesNo.dropped.notInCatalog, 1);
    assert.equal(cov.yesNo.statIDsNotInCatalog["firstBasket"], 1);
  });

  test("period yes/no markets are dropped from a full-game board and counted", async () => {
    const res = await callNhlBoard();
    const cov = res.structuredContent!.coverage as {
      yesNo: { dropped: Record<string, number>; nonGamePeriodsSeen: Record<string, number> };
    };
    assert.equal(cov.yesNo.dropped.nonGamePeriod, 1);
    assert.equal(cov.yesNo.nonGamePeriodsSeen["1p"], 1);
  });

  test("moneylines are named rather than lumped into one notOverUnder figure", async () => {
    const res = await callNhlBoard();
    const cov = res.structuredContent!.coverage as {
      otherBetTypes: { count: number; betTypesSeen: Record<string, number> };
    };
    assert.equal(cov.otherBetTypes.count, 1);
    assert.equal(cov.otherBetTypes.betTypesSeen["ml"], 1);
  });

  /* RECONCILIATION ACROSS BOTH SECTIONS. The whole point of the coverage block is that
   * it adds up; with a second section it has to add up across both. */
  test("unaccounted is zero with a yes/no section in play", async () => {
    for (const extra of [{}, { includeYesNo: true }]) {
      const res = await callNhlBoard(extra);
      const cov = res.structuredContent!.coverage as {
        seenOdds: number;
        unaccounted: number;
        unparsableOddID: number;
        otherBetTypes: { count: number };
        overUnder: { sidesAccepted: number; dropped: Record<string, number> };
        yesNo: { sidesAccepted: number; dropped: Record<string, number> };
      };
      assert.equal(cov.unaccounted, 0, JSON.stringify(cov, null, 2));
      const sum =
        cov.overUnder.sidesAccepted +
        cov.yesNo.sidesAccepted +
        cov.unparsableOddID +
        cov.otherBetTypes.count +
        Object.values(cov.overUnder.dropped).reduce((a, b) => a + b, 0) +
        Object.values(cov.yesNo.dropped).reduce((a, b) => a + b, 0);
      assert.equal(sum, cov.seenOdds);
    }
  });

  test("an event with ONLY yes/no markets still returns a board", async () => {
    const onlyYN = {
      ...NHL_EVENT,
      odds: { [`points-${PID}-game-yn-yes`]: bk("+120") },
    };
    const sgo = { leagueIDFor: () => "NHL", getAllEvents: async () => [onlyYN] } as never;
    const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
    const { server, handlers } = captureServer();
    registerPropBoardTool(server as never, sgo);
    const res = (await handlers["tkb_get_prop_board"]({
      sport: "nhl",
      eventID: "E",
      preferredBookmakers: "draftkings",
      includeUnpriced: false,
      includeAllBooks: false,
      includeAltLines: false,
      includeYesNo: true,
    } as never)) as { structuredContent?: Record<string, unknown>; content: { text: string }[] };
    // The old empty-board early return would have fired here and reported nothing.
    assert.equal(res.structuredContent?.yesNoRowsBuilt, 1);
    assert.doesNotMatch(res.content[0].text, /NO PRICED PROPS/);
  });

  test("the markets filter accepts a yes/no label", async () => {
    const res = await callNhlBoard({
      includeYesNo: true,
      markets: ["Anytime Goalscorer"],
    });
    const yn = res.structuredContent!.yesNoRows as unknown[];
    const ou = res.structuredContent!.rows as unknown[];
    assert.equal(yn.length, 1);
    assert.equal(ou.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. The grader accepts yes/no picks and refuses the ungradeable ones.
// ---------------------------------------------------------------------------

const callGrade = async (params: Record<string, unknown>) => {
  const sgo = {
    leagueIDFor: () => "NHL",
    getAllEvents: async () => [
      {
        eventID: "E",
        type: "match",
        status: { completed: true, finalized: true, displayShort: "Final" },
        teams: {
          home: { teamID: "H", names: { long: "Home" }, score: 3 },
          away: { teamID: "A", names: { long: "Away" }, score: 2 },
        },
        players: { [PID]: { playerID: PID, name: "Auston Matthews", teamID: "H" } },
        results: { game: { [PID]: { points: 1 } } },
        odds: {
          [`points-${PID}-game-yn-yes`]: { score: 1 },
          [`points-${PID}-game-yn-no`]: { score: 1 },
          [`points-${PID}-game-ou-over`]: { score: 1 },
        },
      },
    ],
  } as never;
  const { registerGradePicksTool } = await import("../src/tools/gradePicks.js");
  const { server, handlers } = captureServer();
  registerGradePicksTool(server as never, sgo);
  return (await handlers["tkb_grade_pick"](params as never)) as {
    content: { text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
};

describe("v2.11.0 yes/no picks are gradeable", () => {
  test("an ungradeable market is refused BY NAME, never settled from a guess", async () => {
    const res = await callGrade({
      sport: "wnba",
      eventID: "E",
      marketType: "player_yes_no",
      side: "yes",
      marketLabel: "First Basket",
      playerID: "P",
    });
    assert.match(res.content[0].text, /CANNOT GRADE "First Basket"/);
    assert.match(res.content[0].text, /ordering, composite or outcome/);
    // And it says the odds are still usable, so this is not read as "market broken".
    assert.match(res.content[0].text, /still pullable and postable/);
  });

  test("an unknown label lists the sport's real yes/no options", async () => {
    const res = await callGrade({
      sport: "nhl",
      eventID: "E",
      marketType: "player_yes_no",
      side: "yes",
      marketLabel: "Hat Trick",
      playerID: PID,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not a recognized yes\/no market/);
    assert.match(res.content[0].text, /Anytime Goalscorer/);
  });

  test("NO postedLine is required, because the market has no line", async () => {
    const res = await callGrade({
      sport: "nhl",
      eventID: "E",
      marketType: "player_yes_no",
      side: "yes",
      marketLabel: "Anytime Goalscorer",
      playerID: PID,
      playerName: "Auston Matthews",
    });
    assert.doesNotMatch(res.content[0].text, /postedLine/);
    assert.equal(res.structuredContent?.result, "WIN");
  });

  test("it grades as over/under at 0.5 and says so, not as a posted line", async () => {
    const res = await callGrade({
      sport: "nhl",
      eventID: "E",
      marketType: "player_yes_no",
      side: "yes",
      marketLabel: "Anytime Goalscorer",
      playerID: PID,
    });
    assert.equal(res.structuredContent?.lineGradedAgainst, 0.5);
    assert.equal(res.structuredContent?.yesNoThreshold, 0.5);
    // The honesty flag: nothing was graded against a line the user posted.
    assert.equal(res.structuredContent?.gradedAgainstPostedLine, false);
  });

  test("the no side inverts, so one goal is a LOSS for no", async () => {
    const res = await callGrade({
      sport: "nhl",
      eventID: "E",
      marketType: "player_yes_no",
      side: "no",
      marketLabel: "Anytime Goalscorer",
      playerID: PID,
    });
    assert.equal(res.structuredContent?.result, "LOSS");
    assert.equal(res.structuredContent?.side, "no");
  });

  test("the side vocabulary is guarded BOTH ways", async () => {
    const wrongWay = await callGrade({
      sport: "nhl",
      eventID: "E",
      marketType: "player_yes_no",
      side: "over",
      marketLabel: "Anytime Goalscorer",
      playerID: PID,
      postedLine: 0.5,
    });
    assert.equal(wrongWay.isError, true);
    assert.match(wrongWay.content[0].text, /sided by YES\/NO/);

    const otherWay = await callGrade({
      sport: "nhl",
      eventID: "E",
      marketType: "player_prop",
      side: "yes",
      marketLabel: "Goals",
      playerID: PID,
      postedLine: 0.5,
    });
    assert.equal(otherWay.isError, true);
    assert.match(otherWay.content[0].text, /only valid with/);
  });

  test("marketLabel and playerID are still both required", async () => {
    const res = await callGrade({
      sport: "nhl",
      eventID: "E",
      marketType: "player_yes_no",
      side: "yes",
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /requires both marketLabel and playerID/);
  });
});

// ---------------------------------------------------------------------------
// 7. v2.11.1: a stale client schema sends "true" instead of true.
//
// Measured minutes after v2.11.0 deployed: includeYesNo was rejected on every live call
// with "Expected boolean, received string", from a client that had just been told the
// parameter existed. MCP clients cache tool definitions and a refresh diffs tool NAMES,
// so a tool that gained a parameter looks unchanged. Every scheduled task holds its own
// client session, so this is the general shape of "adding a parameter breaks a schedule
// silently", not a one-off.
// ---------------------------------------------------------------------------

describe("v2.11.1 string-spelled booleans and numbers are accepted", () => {
  test("includeYesNo as the string \"true\" works", async () => {
    const res = await callNhlBoard({ includeYesNo: "true" });
    assert.equal((res.structuredContent!.yesNoRows as unknown[]).length, 1);
  });

  test("and \"false\" is respected rather than read as truthy", async () => {
    const res = await callNhlBoard({ includeYesNo: "false" });
    assert.equal(res.structuredContent!.yesNoRows, undefined);
    assert.equal(res.structuredContent!.yesNoRowsBuilt, 1);
  });

  test("a numeric string cap is honoured, not ignored", async () => {
    const res = await callNhlBoard({ includeYesNo: "true", maxYesNoRows: "5" });
    assert.equal(res.structuredContent!.maxRowsApplied !== undefined, true);
    assert.equal((res.structuredContent!.yesNoRows as unknown[]).length, 1);
  });

  /* WIDENS THE SPELLING, DOES NOT WEAKEN VALIDATION. A parameter that guesses what the
   * caller meant is how a board silently includes something nobody asked for. */
  test("garbage is still rejected", async () => {
    const { flexBoolean, flexIntOptional, flexNumberOptional } = await import(
      "../src/services/flexibleInput.js"
    );
    const b = flexBoolean(false);
    assert.equal(b.parse(undefined), false);
    assert.equal(b.parse("TRUE "), true);
    assert.equal(b.parse(" False"), false);
    for (const bad of ["yes", "1", "on", "", "maybe", 1]) {
      assert.throws(() => b.parse(bad), `accepted ${JSON.stringify(bad)}`);
    }
    const n = flexIntOptional(5, 600);
    assert.equal(n.parse("42"), 42);
    assert.equal(n.parse(undefined), undefined);
    for (const bad of ["", "12abc", "4", "601", "7.5", "NaN"]) {
      assert.throws(() => n.parse(bad), `accepted ${JSON.stringify(bad)}`);
    }
    // postedLine takes decimals, so this one must NOT reject 7.5.
    assert.equal(flexNumberOptional().parse("7.5"), 7.5);
    assert.equal(flexNumberOptional().parse("-6.5"), -6.5);
  });

  test("the grader accepts a string postedLine", async () => {
    const res = await callGrade({
      sport: "nhl",
      eventID: "E",
      marketType: "player_prop",
      side: "over",
      marketLabel: "Goals",
      playerID: PID,
      postedLine: "0.5",
    });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent?.lineGradedAgainst, 0.5);
  });
});

// ---------------------------------------------------------------------------
// 8. v2.11.2: the cross-check's own false-positive bug.
// ---------------------------------------------------------------------------

describe("v2.11.2 the 0.5 index is period-scoped", () => {
  /* THE BUG. The index tested only `side === "over"`, which put it ahead of the period
   * filter, so a hockey FIRST-PERIOD "points over 0.5" overwrote the full-game one and
   * the cross-check compared a full-game yes/no price against a one-period line. It
   * produced 25 mismatches on Montreal at Toronto, 2026-09-29, all false, each phrased
   * "do not post off it". A verification tool that cries wolf is worse than none.
   *
   * The fixture is that event in miniature: DraftKings' real full-game goals+assists
   * over 0.5 on Kreider is +125 and its yes/no is +125, while his FIRST-PERIOD 0.5 line
   * is +500. Agreement is the correct verdict. */
  const KR = "CHRIS_KREIDER_1_NHL";
  const EV = {
    eventID: "E",
    type: "match",
    status: { started: false, startsAt: "2026-09-30T23:00:00.000Z" },
    teams: {
      home: { teamID: "TOR", names: { long: "Toronto Maple Leafs" } },
      away: { teamID: "MTL", names: { long: "Montreal Canadiens" } },
    },
    players: { [KR]: { playerID: KR, name: "Chris Kreider", teamID: "MTL" } },
    odds: {
      /* THE PERIOD ODD IS LISTED FIRST, DELIBERATELY. An earlier version of this test
       * put the full-game odd first and passed even with the period scope removed,
       * because the same fix also made the index first-write-wins and the good entry
       * happened to arrive first. A mutation run caught that the test was not isolating
       * the bug it claimed to. Object key order is insertion order, so putting the
       * one-period line first is what reproduces the real failure. */
      [`goals+assists-${KR}-1p-ou-over`]: bk("+500", "0.5"),
      [`goals+assists-${KR}-game-ou-over`]: bk("+125", "0.5"),
      [`goals+assists-${KR}-game-yn-yes`]: bk("+125"),
    },
  };
  const call = async () => {
    const sgo = { leagueIDFor: () => "NHL", getAllEvents: async () => [EV] } as never;
    const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
    const { server, handlers } = captureServer();
    registerPropBoardTool(server as never, sgo);
    return (await handlers["tkb_get_prop_board"]({
      sport: "nhl",
      eventID: "E",
      preferredBookmakers: "draftkings",
      includeUnpriced: false,
      includeAllBooks: false,
      includeAltLines: false,
      includeYesNo: true,
    } as never)) as { structuredContent?: Record<string, unknown> };
  };

  test("a period 0.5 line does NOT become the full-game comparison", async () => {
    const res = await call();
    const yn = res.structuredContent!.yesNoRows as {
      crossCheck: { status: string; overPrice: string };
    }[];
    assert.equal(yn[0].crossCheck.status, "agrees");
    assert.equal(yn[0].crossCheck.overPrice, "+125");
  });

  test("and the board reports zero mismatches, not one", async () => {
    const res = await call();
    assert.equal(res.structuredContent!.yesNoCrossCheckMismatches, 0);
  });

  /* THE OTHER HALF OF THE FIX, isolated. Two full-game odds on the same market, which
   * is what an alt-line ladder produces. Last-write-wins would let the second one
   * replace a book's price; first-write-wins keeps it and adds only new books. */
  test("a second full-game odd cannot replace a book's price in the index", async () => {
    const withLadder = {
      ...EV,
      odds: {
        [`goals+assists-${KR}-game-ou-over`]: bk("+125", "0.5"),
        [`goals+assists-${KR}-game-yn-yes`]: bk("+125"),
      },
    };
    // Two books on one odd, one of them at another line, plus a duplicate rung.
    (withLadder.odds as Record<string, unknown>)[`goals+assists-${KR}-game-ou-over`] = {
      byBookmaker: {
        draftkings: { odds: "+125", overUnder: "0.5", available: true },
        fanduel: { odds: "+900", overUnder: "2.5", available: true },
      },
    };
    const sgo = { leagueIDFor: () => "NHL", getAllEvents: async () => [withLadder] } as never;
    const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
    const { server, handlers } = captureServer();
    registerPropBoardTool(server as never, sgo);
    const res = (await handlers["tkb_get_prop_board"]({
      sport: "nhl",
      eventID: "E",
      preferredBookmakers: "draftkings,fanduel",
      includeUnpriced: false,
      includeAllBooks: false,
      includeAltLines: true,
      includeYesNo: true,
    } as never)) as { structuredContent?: Record<string, unknown> };
    const yn = res.structuredContent!.yesNoRows as {
      crossCheck: { status: string; book: string; overPrice: string };
    }[];
    // The 2.5 book must not be treated as a 0.5 comparison.
    assert.equal(yn[0].crossCheck.status, "agrees");
    assert.equal(yn[0].crossCheck.book, "draftkings");
    assert.equal(yn[0].crossCheck.overPrice, "+125");
  });

  test("unparsable oddIDs are NAMED now, not just counted", async () => {
    const sgo = {
      leagueIDFor: () => "NHL",
      getAllEvents: async () => [
        { ...EV, odds: { ...EV.odds, "not-a-valid-oddid-at-all-x-y-z": bk("-110", "1.5") } },
      ],
    } as never;
    const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
    const { server, handlers } = captureServer();
    registerPropBoardTool(server as never, sgo);
    const res = (await handlers["tkb_get_prop_board"]({
      sport: "nhl",
      eventID: "E",
      preferredBookmakers: "draftkings",
      includeUnpriced: false,
      includeAllBooks: false,
      includeAltLines: false,
      includeYesNo: true,
    } as never)) as { structuredContent?: Record<string, unknown> };
    const cov = res.structuredContent!.coverage as {
      unparsableOddID: number;
      unparsableOddIDsSeen: string[];
    };
    assert.equal(cov.unparsableOddID, 1);
    assert.deepEqual(cov.unparsableOddIDsSeen, ["not-a-valid-oddid-at-all-x-y-z"]);
  });
});
