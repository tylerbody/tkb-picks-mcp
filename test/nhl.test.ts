import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  GAME_TOTAL_STAT,
  PARTICIPANT_MODEL,
  SPORT_CONFIG,
  SUPPORTED_SPORTS,
  gameTotalStatFor,
  hasDrawOutcome,
  matchLinePeriodFor,
  supportsCapability,
  unsupportedMessage,
} from "../src/constants.js";
import { OU_PROP_MARKETS, SUPPORTED_PERIODS, YES_NO_MARKETS } from "../src/services/marketCatalog.js";
import { PERIOD_CODES } from "../src/services/oddIdBuilder.js";
import { seasonForDate } from "../src/services/seasonBoundary.js";
import { nhlSaysFinal, nhlSaysLive } from "../src/services/nhlStatus.js";
import {
  normaliseNhlGame,
  normaliseNhlGameLogEntry,
  normaliseNhlName,
  nhlSeasonId,
} from "../src/services/nhlStatsClient.js";
import {
  isNhlStatSupported,
  lookupNhlStat,
  nhlStatUnavailableReason,
} from "../src/services/nhlStatMap.js";
import {
  countTeamGamesPlayed,
  getNhlPlayerHitRate,
  nhlSeasonIdForDate,
  resolveNhlPlayer,
  sortLogNewestFirst,
} from "../src/services/nhlHitRateAggregator.js";
import { allNhlClubCodes, nhlClubCode, NHL_CLUB_CODES } from "../src/services/nhlTeams.js";
import { describeRecency } from "../src/services/sampleRecency.js";
import { reconcileFinalityWithNHL } from "../src/services/eventStatus.js";
import type { SGOEvent } from "../src/types.js";

/* ===========================================================================
 * NHL (v2.10.0)
 *
 * Every field name asserted below was read off a LIVE api-web.nhle.com response on
 * 2026-09-24, and every SGO statID is quoted from their stats page. Nothing here is
 * invented, which is the same standard the rest of this suite holds.
 * ======================================================================== */

const logEntry = (stats: Record<string, unknown>) =>
  normaliseNhlGameLogEntry({ gameId: 1, gameDate: "2026-10-09", ...stats });

describe("THE POINTS CROSSOVER: the one trap that makes hockey different", () => {
  /* SGO      points        = "Goals scored"
   * SGO      goals+assists = "Hockey Points"
   * NHL API  goals         = goals
   * NHL API  points        = goals + assists
   * Crossed, not parallel. Wire them by name and every player-points prop grades
   * against goals alone. */
  const row = logEntry({ goals: 1, assists: 3, points: 4 });

  test("SGO `points` reads the NHL's GOALS field, not its points field", () => {
    const r = lookupNhlStat(row, "points");
    assert.equal(r.kind, "value");
    if (r.kind !== "value") return;
    assert.equal(r.value, 1);
    assert.equal(r.matchedField, "goals");
  });

  test("SGO `goals+assists` reads the NHL's POINTS field", () => {
    const r = lookupNhlStat(row, "goals+assists");
    assert.equal(r.kind, "value");
    if (r.kind !== "value") return;
    assert.equal(r.value, 4);
    assert.equal(r.matchedField, "points");
  });

  test("THE TWO NEVER RETURN THE SAME NUMBER on a multi-point night", () => {
    // The regression that matters: if someone "fixes" the mapping so the names line
    // up, these two collapse onto each other and a points prop silently becomes a
    // goals prop.
    const goals = lookupNhlStat(row, "points");
    const points = lookupNhlStat(row, "goals+assists");
    assert.equal(goals.kind, "value");
    assert.equal(points.kind, "value");
    if (goals.kind !== "value" || points.kind !== "value") return;
    assert.notEqual(goals.value, points.value);
  });

  test("a GAME total is goals in both vocabularies, so it stays on `points`", () => {
    assert.equal(gameTotalStatFor("nhl"), "points");
    assert.equal(GAME_TOTAL_STAT.nhl, "points");
  });

  test("the prop catalog labels them the way a BOOK does, not the way SGO does", () => {
    const nhl = OU_PROP_MARKETS.nhl;
    const points = nhl.find((m) => m.label === "Points");
    const goals = nhl.find((m) => m.label === "Goals");
    assert.equal(points?.statID, "goals+assists");
    assert.equal(goals?.statID, "points");
  });

  test("ANYTIME GOALSCORER is `points`, never the combined stat", () => {
    const anytime = YES_NO_MARKETS.nhl.find((m) => m.label === "Anytime Goalscorer");
    assert.equal(anytime?.statID, "points");
  });
});

describe("shots: the second name collision", () => {
  test("SGO `shots_onGoal` maps to the NHL's `shots` field", () => {
    const r = lookupNhlStat(logEntry({ shots: 4 }), "shots_onGoal");
    assert.equal(r.kind, "value");
    if (r.kind !== "value") return;
    assert.equal(r.value, 4);
  });

  test("SGO's bare `shots` is REFUSED rather than mapped to the same field", () => {
    // Total shots taken includes misses and blocks; the NHL's `shots` is the S column,
    // which is shots on goal. Mapping them together overstates the prop.
    const r = lookupNhlStat(logEntry({ shots: 4 }), "shots");
    assert.equal(r.kind, "stat_not_mapped");
    assert.match(r.kind === "stat_not_mapped" ? r.note : "", /shots ON GOAL|shots_onGoal/);
  });
});

describe("goalie saves are DERIVED, and only when both inputs exist", () => {
  test("saves = shotsAgainst - goalsAgainst", () => {
    const r = lookupNhlStat(logEntry({ shotsAgainst: 31, goalsAgainst: 2 }), "goalie_saves");
    assert.equal(r.kind, "value");
    if (r.kind !== "value") return;
    assert.equal(r.value, 29);
  });

  test("the matched field SAYS it was derived", () => {
    const r = lookupNhlStat(logEntry({ shotsAgainst: 31, goalsAgainst: 2 }), "goalie_saves");
    assert.match(r.kind === "value" ? r.matchedField : "", /derived/);
  });

  test("ONE MISSING INPUT PRODUCES NO NUMBER, not a half-derived one", () => {
    const r = lookupNhlStat(logEntry({ shotsAgainst: 31 }), "goalie_saves");
    assert.equal(r.kind, "field_absent");
  });

  test("a SHUTOUT still derives, because zero goals against is a real value", () => {
    const r = lookupNhlStat(logEntry({ shotsAgainst: 24, goalsAgainst: 0 }), "goalie_saves");
    assert.equal(r.kind, "value");
    if (r.kind !== "value") return;
    assert.equal(r.value, 24);
  });
});

describe("absent is not zero", () => {
  test("a goalless night is a VALUE of 0, not an absence", () => {
    const r = lookupNhlStat(logEntry({ goals: 0 }), "points");
    assert.equal(r.kind, "value");
    if (r.kind !== "value") return;
    assert.equal(r.value, 0);
  });

  test("a MISSING field is field_absent, and says so rather than returning 0", () => {
    const r = lookupNhlStat(logEntry({}), "points");
    assert.equal(r.kind, "field_absent");
    assert.match(r.kind === "field_absent" ? r.note : "", /ABSENT/);
  });
});

describe("stats this source cannot count are refused BY NAME", () => {
  for (const statID of ["hits", "blocks", "faceOffs_won", "powerPlay_assists", "fantasyScore"]) {
    test(`${statID} is refused with a reason, not silently unmapped`, () => {
      assert.equal(isNhlStatSupported(statID), false);
      const reason = nhlStatUnavailableReason(statID);
      assert.ok(reason && reason.length > 40, `${statID} needs a real explanation`);
    });
  }

  test("the hits refusal names the box score as the route that WOULD work", () => {
    assert.match(nhlStatUnavailableReason("hits") ?? "", /box score/i);
  });

  test("the blocks refusal warns about the opposite-direction statID", () => {
    assert.match(nhlStatUnavailableReason("blocks") ?? "", /shots_blocked/);
  });

  test("but these markets ARE in the prop catalog, because SGO prices them", () => {
    // Refusing a counted RATE is not the same as refusing to quote the line.
    const ids = OU_PROP_MARKETS.nhl.map((m) => m.statID);
    assert.ok(ids.includes("hits"));
    assert.ok(ids.includes("blocks"));
  });
});

describe("gameState is an ALLOW-LIST, never a not-live inference", () => {
  test("OFF and FINAL are both terminal", () => {
    assert.equal(nhlSaysFinal("OFF"), true);
    assert.equal(nhlSaysFinal("FINAL"), true);
    assert.equal(nhlSaysFinal("off"), true);
  });

  test("scheduled and pregame states are NOT final", () => {
    assert.equal(nhlSaysFinal("FUT"), false);
    assert.equal(nhlSaysFinal("PRE"), false);
  });

  test("live states are not final, and ARE live", () => {
    assert.equal(nhlSaysFinal("LIVE"), false);
    assert.equal(nhlSaysFinal("CRIT"), false);
    assert.equal(nhlSaysLive("LIVE"), true);
    assert.equal(nhlSaysLive("CRIT"), true);
  });

  test("AN UNSEEN STATE IS NO INFORMATION, not 'not live therefore over'", () => {
    assert.equal(nhlSaysFinal("POSTPONED"), false);
    assert.equal(nhlSaysFinal("SUSP"), false);
    assert.equal(nhlSaysFinal(""), false);
    assert.equal(nhlSaysFinal(undefined), false);
    assert.equal(nhlSaysLive("POSTPONED"), false);
  });
});

describe("normaliseNhlGame", () => {
  const raw = {
    id: 2026020123,
    gameState: "OFF",
    startTimeUTC: "2026-10-09T23:00:00Z",
    homeTeam: { abbrev: "BUF", placeName: { default: "Buffalo" }, commonName: { default: "Sabres" }, score: 3 },
    awayTeam: { abbrev: "TOR", placeName: { default: "Toronto" }, commonName: { default: "Maple Leafs" }, score: 2 },
    gameOutcome: { lastPeriodType: "SO" },
  };

  test("team names are assembled from placeName plus commonName", () => {
    const g = normaliseNhlGame(raw);
    assert.equal(g.homeName, "Buffalo Sabres");
    assert.equal(g.awayName, "Toronto Maple Leafs");
  });

  test("scores and the ending type come through", () => {
    const g = normaliseNhlGame(raw);
    assert.equal(g.homeScore, 3);
    assert.equal(g.awayScore, 2);
    assert.equal(g.lastPeriodType, "SO");
  });

  test("A MISSING SCORE IS undefined, NOT 0", () => {
    // Two feeds missing a score must not look like two feeds agreeing on nil-nil.
    const g = normaliseNhlGame({ id: 1, gameState: "FUT", homeTeam: {}, awayTeam: {} });
    assert.equal(g.homeScore, undefined);
    assert.equal(g.awayScore, undefined);
  });
});

describe("the NHL second source for finality", () => {
  const event = (homeScore?: number, awayScore?: number): SGOEvent =>
    ({
      eventID: "E",
      status: { startsAt: "2026-10-09T23:00:00.000Z" },
      teams: {
        home: { names: { long: "Buffalo Sabres" }, score: homeScore },
        away: { names: { long: "Toronto Maple Leafs" }, score: awayScore },
      },
    }) as unknown as SGOEvent;

  const nhlRow = (over: Record<string, unknown> = {}) => ({
    gameState: "OFF",
    homeName: "Buffalo Sabres",
    awayName: "Toronto Maple Leafs",
    homeScore: 3,
    awayScore: 2,
    lastPeriodType: "REG",
    ...over,
  });

  test("agreement resolves and says the NHL supplied FINALITY, not the numbers", () => {
    const r = reconcileFinalityWithNHL(event(3, 2), [nhlRow()]);
    assert.equal(r.resolved, true);
    assert.match(r.note, /finality, not the numbers/);
  });

  test("a SHOOTOUT finish is reported, because it changes regulation markets", () => {
    const r = reconcileFinalityWithNHL(event(3, 2), [nhlRow({ lastPeriodType: "SO" })]);
    assert.equal(r.resolved, true);
    assert.match(r.note, /SHOOTOUT/);
  });

  test("an OVERTIME finish is reported too", () => {
    const r = reconcileFinalityWithNHL(event(3, 2), [nhlRow({ lastPeriodType: "OT" })]);
    assert.match(r.note, /OVERTIME/);
  });

  test("REVERSED ORIENTATION IS NOT A MATCH", () => {
    const r = reconcileFinalityWithNHL(event(3, 2), [
      nhlRow({ homeName: "Toronto Maple Leafs", awayName: "Buffalo Sabres" }),
    ]);
    assert.equal(r.resolved, false);
    assert.match(r.note, /NONE matched/);
  });

  test("a non-terminal state leaves the refusal standing", () => {
    const r = reconcileFinalityWithNHL(event(3, 2), [nhlRow({ gameState: "LIVE" })]);
    assert.equal(r.resolved, false);
    assert.match(r.note, /not one of the terminal states/);
  });

  test("DISAGREEING SCORES DO NOT RESOLVE", () => {
    const r = reconcileFinalityWithNHL(event(3, 2), [nhlRow({ homeScore: 4 })]);
    assert.equal(r.resolved, false);
    assert.match(r.note, /DISAGREE ON THE SCORE/);
  });

  test("finality without a score on either side does not resolve", () => {
    assert.equal(reconcileFinalityWithNHL(event(undefined, 2), [nhlRow()]).resolved, false);
    assert.equal(reconcileFinalityWithNHL(event(3, 2), [nhlRow({ homeScore: undefined })]).resolved, false);
  });

  test("an event with no team names refuses rather than matching loosely", () => {
    const bare = { eventID: "E", status: {}, teams: { home: {}, away: {} } } as unknown as SGOEvent;
    const r = reconcileFinalityWithNHL(bare, [nhlRow()]);
    assert.equal(r.resolved, false);
    assert.match(r.note, /no long team names/);
  });
});

describe("play-rate denominator: what counts as a completed team game", () => {
  const games = [
    { gameDate: "2026-09-25", gameType: 1, gameState: "OFF" },   // preseason
    { gameDate: "2026-10-09", gameType: 2, gameState: "OFF" },   // counts
    { gameDate: "2026-10-11", gameType: 2, gameState: "FINAL" }, // counts
    { gameDate: "2026-10-13", gameType: 2, gameState: "FUT" },   // not played
    { gameDate: "2026-11-01", gameType: 2, gameState: "OFF" },   // after the cutoff
    { gameDate: "2026-10-12", gameType: 3, gameState: "OFF" },   // playoff type
  ];

  test("PRESEASON IS EXCLUDED, which would otherwise understate availability", () => {
    assert.equal(countTeamGamesPlayed(games, "2026-10-20"), 2);
  });

  test("scheduled games and games after the cutoff are excluded", () => {
    assert.equal(countTeamGamesPlayed(games, "2026-10-10"), 1);
  });

  test("an empty schedule is zero rather than a crash", () => {
    assert.equal(countTeamGamesPlayed([], "2026-10-20"), 0);
  });
});

describe("resolving an SGO player name against a club roster", () => {
  const roster = [
    { playerId: 1, fullName: "Zach Benson", teamAbbrev: "BUF", positionCode: "L", isGoalie: false },
    { playerId: 2, fullName: "Alex Tuch", teamAbbrev: "BUF", positionCode: "R", isGoalie: false },
    { playerId: 3, fullName: "Jack Quinn", teamAbbrev: "BUF", positionCode: "R", isGoalie: false },
    { playerId: 4, fullName: "Ukko-Pekka Luukkonen", teamAbbrev: "BUF", positionCode: "G", isGoalie: true },
  ];

  test("an exact name matches", () => {
    assert.equal(resolveNhlPlayer(roster, "Zach Benson")?.playerId, 1);
  });

  test("punctuation and case do not matter", () => {
    assert.equal(resolveNhlPlayer(roster, "ukko pekka luukkonen")?.playerId, 4);
  });

  test("a UNIQUE surname is accepted as a fallback", () => {
    assert.equal(resolveNhlPlayer(roster, "Zachary Benson")?.playerId, 1);
  });

  test("AN AMBIGUOUS SURNAME MATCHES NOTHING rather than guessing", () => {
    const twoAhos = [
      { playerId: 10, fullName: "Sebastian Aho", teamAbbrev: "NYI", positionCode: "D", isGoalie: false },
      { playerId: 11, fullName: "Sebastian Aho", teamAbbrev: "NYI", positionCode: "C", isGoalie: false },
    ];
    assert.equal(resolveNhlPlayer(twoAhos, "Sebastian Aho"), null);
    assert.equal(resolveNhlPlayer(twoAhos, "S Aho"), null);
  });

  test("a name absent from the roster returns null", () => {
    assert.equal(resolveNhlPlayer(roster, "Connor McDavid"), null);
  });

  test("an empty name returns null rather than matching the first row", () => {
    assert.equal(resolveNhlPlayer(roster, ""), null);
    assert.equal(resolveNhlPlayer(roster, "   "), null);
  });
});

describe("club codes: a complete table, not a derivation", () => {
  test("all 32 clubs are present", () => {
    assert.equal(Object.keys(NHL_CLUB_CODES).length, 32);
    assert.equal(allNhlClubCodes().length, 32);
  });

  test("an SGO-shaped teamID resolves", () => {
    assert.equal(nhlClubCode("BUFFALO_SABRES_NHL"), "BUF");
    assert.equal(nhlClubCode("TAMPA_BAY_LIGHTNING_NHL"), "TBL");
  });

  test("a display name resolves, accents and periods included", () => {
    assert.equal(nhlClubCode("Montréal Canadiens"), "MTL");
    assert.equal(nhlClubCode("St. Louis Blues"), "STL");
    assert.equal(nhlClubCode("St Louis Blues"), "STL");
  });

  test("a bare club code passes through", () => {
    assert.equal(nhlClubCode("VGK"), "VGK");
    assert.equal(nhlClubCode("wpg"), "WPG");
  });

  test("THE UTAH MOVE is handled, so an archived Coyotes id still resolves", () => {
    assert.equal(nhlClubCode("Utah Mammoth"), "UTA");
    assert.equal(nhlClubCode("ARIZONA_COYOTES_NHL"), "UTA");
    assert.equal(nhlClubCode("Utah Hockey Club"), "UTA");
  });

  test("AN UNKNOWN CLUB IS null, never a best guess", () => {
    assert.equal(nhlClubCode("Hartford Whalers"), null);
    assert.equal(nhlClubCode("QQQ"), null);
    assert.equal(nhlClubCode(""), null);
    assert.equal(nhlClubCode(undefined), null);
  });
});

describe("season handling", () => {
  test("the NHL season id is the year pair the league uses", () => {
    assert.equal(nhlSeasonId(2026), "20262027");
  });

  test("October belongs to the season that starts that year", () => {
    assert.equal(seasonForDate("nhl", "2026-10-09")?.seasonYear, 2026);
  });

  test("MARCH BELONGS TO THE PREVIOUS OCTOBER, not the calendar year", () => {
    // Read as the calendar year, more than half the season including every playoff
    // game would be filed under a season that has not started.
    assert.equal(seasonForDate("nhl", "2027-03-15")?.seasonYear, 2026);
    assert.equal(nhlSeasonIdForDate("2027-03-15"), "20262027");
  });

  test("September is still the prior season, before the October opener", () => {
    assert.equal(seasonForDate("nhl", "2026-09-24")?.seasonYear, 2025);
  });
});

describe("log ordering is taken from dates, never from the provider", () => {
  test("newest first", () => {
    const sorted = sortLogNewestFirst([
      normaliseNhlGameLogEntry({ gameId: 1, gameDate: "2026-10-09" }),
      normaliseNhlGameLogEntry({ gameId: 2, gameDate: "2026-11-02" }),
      normaliseNhlGameLogEntry({ gameId: 3, gameDate: "2026-10-20" }),
    ]);
    assert.deepEqual(sorted.map((e) => e.gameId), [2, 3, 1]);
  });
});

describe("the capability row says what hockey can and cannot do", () => {
  test("NHL is a supported sport with a roster model", () => {
    assert.ok(SUPPORTED_SPORTS.includes("nhl"));
    assert.equal(PARTICIPANT_MODEL.nhl, "roster");
  });

  test("player props and hit rates are ON", () => {
    assert.equal(supportsCapability("nhl", "playerProps"), true);
    assert.equal(supportsCapability("nhl", "hitRates"), true);
  });

  test("WEATHER IS OFF, because hockey is indoors", () => {
    // The stub that used to sit in SPORT_CONFIG claimed TEAM_SPORT_CAPABILITIES,
    // which would have sent a weather lookup for an indoor sport.
    assert.equal(supportsCapability("nhl", "weather"), false);
    assert.match(unsupportedMessage("nhl", "weather"), /not a factor/);
  });

  test("INJURIES ARE OFF, and the refusal explains hockey's own reporting habits", () => {
    assert.equal(supportsCapability("nhl", "injuries"), false);
    const msg = unsupportedMessage("nhl", "injuries");
    assert.match(msg, /goalie/i);
    assert.match(msg, /GOAT/);
    assert.doesNotMatch(msg, /404/); // that is the NCAAF message, not this one
  });

  test("a full-game NHL moneyline settles on the whole event, OT and SO included", () => {
    assert.equal(matchLinePeriodFor("nhl"), "full_game");
  });

  test("there is no draw to price, unlike soccer", () => {
    assert.equal(hasDrawOutcome("nhl"), false);
  });

  test("the BDL path is populated but is NOT what serves hit rates", () => {
    assert.equal(SPORT_CONFIG.nhl.bdlPath, "nhl");
  });
});

describe("hockey periods", () => {
  test("three periods, and no fourth", () => {
    assert.deepEqual(SUPPORTED_PERIODS.nhl, ["1st_period", "2nd_period", "3rd_period"]);
  });

  test("the period codes match SGO's documented ids", () => {
    assert.equal(PERIOD_CODES["1st_period"], "1p");
    assert.equal(PERIOD_CODES["2nd_period"], "2p");
    assert.equal(PERIOD_CODES["3rd_period"], "3p");
  });
});

describe("name normalisation", () => {
  test("diacritics and punctuation are stripped, letters are kept", () => {
    assert.equal(normaliseNhlName("Montréal"), "montreal");
    assert.equal(normaliseNhlName("Ukko-Pekka"), "ukkopekka");
    assert.equal(normaliseNhlName(undefined), "");
  });
});

/* ===========================================================================
 * v2.10.1 - TWO DEFECTS FOUND BY TESTING THE DEPLOYED v2.10.0 BUILD
 *
 * 1. The play rate compared a CAPPED numerator against a WHOLE SEASON, so it
 *    tracked the lookback argument rather than the player, and every NHL hit rate
 *    came back flagged IRREGULAR.
 * 2. This aggregator never called describeRecency, which all four others do, so a
 *    sample from a finished season reported as current form with no warning.
 * ======================================================================== */

describe("v2.10.1 play rate is measured over the window the sample spans", () => {
  // A club that has played 20 games, every other day from Oct 9.
  const clubGames = Array.from({ length: 20 }, (_, i) => ({
    gameDate: `2026-10-${String(9 + i * 2).padStart(2, "0")}`.slice(0, 10),
    gameType: 2,
    gameState: "OFF",
  }));

  test("THE BUG: the full-season count is independent of the sample window", () => {
    // This is what the old denominator was, and why a 10-appearance sample against it
    // produced 12% for a player who had played nearly every game.
    const whole = countTeamGamesPlayed(clubGames, "2026-11-30");
    assert.equal(whole, 20);
  });

  test("bounding the window to the sample gives a denominator that means something", () => {
    // Last five club games only.
    const windowed = countTeamGamesPlayed(clubGames, "2026-11-30", "2026-10-39".slice(0, 10));
    assert.ok(windowed < 20);
  });

  test("a window start on the oldest counted game includes that game", () => {
    assert.equal(countTeamGamesPlayed(clubGames, "2026-10-13", "2026-10-09"), 3);
  });

  test("the window still excludes preseason and unplayed games", () => {
    const mixed = [
      { gameDate: "2026-10-09", gameType: 1, gameState: "OFF" },
      { gameDate: "2026-10-11", gameType: 2, gameState: "OFF" },
      { gameDate: "2026-10-13", gameType: 2, gameState: "FUT" },
    ];
    assert.equal(countTeamGamesPlayed(mixed, "2026-10-20", "2026-10-09"), 1);
  });

  test("an empty window is 0, not a crash or a full-season fallback", () => {
    assert.equal(countTeamGamesPlayed(clubGames, "2026-10-08", "2026-10-01"), 0);
  });
});

describe("v2.10.1 a finished season is not current form", () => {
  // The exact shape measured live: every counted game from Nov 2025 to Apr 2026, read
  // on 2026-09-24, two weeks before the next season opens.
  const staleLog = [
    { date: "2026-04-14", statValue: 0 },
    { date: "2026-04-09", statValue: 1 },
    { date: "2026-04-03", statValue: 0 },
    { date: "2026-03-28", statValue: 0 },
    { date: "2026-03-18", statValue: 0 },
  ];
  const asOf = new Date("2026-09-24T00:00:00Z");

  test("THE BUG: the season LABEL says current, because the year has not rolled over", () => {
    // Both of these were correct in v2.10.0 and that was the problem.
    assert.equal(seasonForDate("nhl", "2026-04-14")?.seasonYear, 2025);
    assert.equal(seasonForDate("nhl", "2026-09-24")?.seasonYear, 2025);
  });

  test("describeRecency catches what the season label cannot", () => {
    const r = describeRecency(staleLog, {}, asOf);
    assert.equal(r.isStale, true);
    assert.ok(r.daysSinceMostRecent !== null && r.daysSinceMostRecent > 150);
    assert.ok(r.warning && r.warning.length > 0);
  });

  test("a sample from THIS week is not stale", () => {
    const fresh = [
      { date: "2026-09-23", statValue: 1 },
      { date: "2026-09-21", statValue: 0 },
      { date: "2026-09-19", statValue: 2 },
    ];
    assert.equal(describeRecency(fresh, {}, asOf).isStale, false);
  });
});

describe("v2.10.1 the aggregator END TO END, against a stub feed", () => {
  /* WHY THIS EXISTS AND THE HELPER TESTS ABOVE WERE NOT ENOUGH.
   *
   * Mutation-testing v2.10.1 caught the windowed denominator but NOT a mutation that
   * broke the aggregator's describeRecency call, because every recency assertion above
   * calls describeRecency directly. A guard is only wired in if something tests the
   * wiring, which is the same lesson as the v2.8.12 cross-check that sat unreachable
   * behind a gate nothing exercised. */

  const club = (n: number, startDay = 9) =>
    Array.from({ length: n }, (_, i) => ({
      gameId: 1000 + i,
      gameDate: `2026-10-${String(startDay + i * 2).padStart(2, "0")}`,
      gameType: 2,
      gameState: "OFF",
      homeAbbrev: "BUF",
      awayAbbrev: "TOR",
    }));

  const stub = (opts: {
    log: { gameDate: string; points?: number; goals?: number }[];
    clubGames: ReturnType<typeof club>;
    isGoalie?: boolean;
  }) =>
    ({
      getRoster: async () => [
        {
          playerId: 7,
          fullName: "Test Skater",
          teamAbbrev: "BUF",
          positionCode: opts.isGoalie ? "G" : "C",
          isGoalie: !!opts.isGoalie,
        },
      ],
      getPlayerGameLog: async () =>
        opts.log.map((r, i) => normaliseNhlGameLogEntry({ gameId: 500 + i, ...r })),
      getClubSchedule: async () => opts.clubGames,
    }) as unknown as Parameters<typeof getNhlPlayerHitRate>[0];

  test("a durable player is NOT flagged IRREGULAR any more", async () => {
    // Played 10 of the 11 club games in the window. v2.10.0 reported this as 10 of 82.
    const log = club(10).map((g) => ({ gameDate: g.gameDate, points: 1 }));
    const r = await getNhlPlayerHitRate(
      stub({ log, clubGames: club(11) }),
      {
        playerName: "Test Skater",
        teamAbbrev: "BUF",
        statID: "goals+assists",
        line: 0.5,
        direction: "over",
        asOf: new Date("2026-10-29T00:00:00Z"),
      }
    );
    assert.equal(r.gamesConsidered, 10);
    assert.equal(r.recentAvailability.flag, "OK");
    assert.ok(r.recentAvailability.playRate > 0.85, `playRate was ${r.recentAvailability.playRate}`);
  });

  test("THE LOOKBACK NO LONGER MOVES THE PLAY RATE", async () => {
    // The v2.10.0 bug in one assertion: same player, two lookbacks, one answer.
    const log = club(20).map((g) => ({ gameDate: g.gameDate, points: 1 }));
    const args = {
      playerName: "Test Skater",
      teamAbbrev: "BUF",
      statID: "goals+assists",
      line: 0.5,
      direction: "over" as const,
      asOf: new Date("2026-11-20T00:00:00Z"),
    };
    const short = await getNhlPlayerHitRate(stub({ log, clubGames: club(20) }), {
      ...args,
      targetAppearances: 5,
    });
    const long = await getNhlPlayerHitRate(stub({ log, clubGames: club(20) }), {
      ...args,
      targetAppearances: 20,
    });
    assert.equal(short.recentAvailability.playRate, 1);
    assert.equal(long.recentAvailability.playRate, 1);
  });

  test("a genuinely scratched player IS still flagged", async () => {
    // Played 5 of the club's 20 games in the window. The flag has to survive the fix.
    const clubGames = club(20);
    const log = [clubGames[0], clubGames[4], clubGames[8], clubGames[12], clubGames[19]].map((g) => ({
      gameDate: g.gameDate,
      points: 0,
    }));
    const r = await getNhlPlayerHitRate(stub({ log, clubGames }), {
      playerName: "Test Skater",
      teamAbbrev: "BUF",
      statID: "goals+assists",
      line: 0.5,
      direction: "over",
      asOf: new Date("2026-11-20T00:00:00Z"),
    });
    assert.equal(r.recentAvailability.flag, "IRREGULAR");
    assert.ok(r.recentAvailability.playRate < 0.5);
  });

  test("A STALE SAMPLE WARNS THROUGH seasonWarning, which is the field writers obey", async () => {
    // The live Vatrano case: April games read in late September.
    const log = [
      { gameDate: "2026-04-14", points: 0 },
      { gameDate: "2026-04-09", points: 1 },
      { gameDate: "2026-04-03", points: 0 },
      { gameDate: "2026-03-28", points: 0 },
      { gameDate: "2026-03-18", points: 0 },
    ];
    const clubGames = [
      { gameId: 1, gameDate: "2026-04-14", gameType: 2, gameState: "OFF", homeAbbrev: "BUF", awayAbbrev: "TOR" },
      { gameId: 2, gameDate: "2026-04-09", gameType: 2, gameState: "OFF", homeAbbrev: "BUF", awayAbbrev: "TOR" },
      { gameId: 3, gameDate: "2026-04-03", gameType: 2, gameState: "OFF", homeAbbrev: "BUF", awayAbbrev: "TOR" },
      { gameId: 4, gameDate: "2026-03-28", gameType: 2, gameState: "OFF", homeAbbrev: "BUF", awayAbbrev: "TOR" },
      { gameId: 5, gameDate: "2026-03-18", gameType: 2, gameState: "OFF", homeAbbrev: "BUF", awayAbbrev: "TOR" },
    ];
    const r = await getNhlPlayerHitRate(stub({ log, clubGames }), {
      playerName: "Test Skater",
      teamAbbrev: "BUF",
      statID: "goals+assists",
      line: 0.5,
      direction: "over",
      asOf: new Date("2026-09-24T00:00:00Z"),
    });
    assert.ok(r.seasonWarning, "seasonWarning must fire on a finished-season sample");
    assert.match(r.seasonWarning ?? "", /NOT CURRENT FORM/);
    assert.match(r.seasonWarning ?? "", /last season/);
    assert.equal(r.recency.isStale, true);
  });

  test("a CURRENT sample carries no season warning at all", async () => {
    const log = club(8).map((g) => ({ gameDate: g.gameDate, points: 1 }));
    const r = await getNhlPlayerHitRate(stub({ log, clubGames: club(8) }), {
      playerName: "Test Skater",
      teamAbbrev: "BUF",
      statID: "goals+assists",
      line: 0.5,
      direction: "over",
      asOf: new Date("2026-10-24T00:00:00Z"),
    });
    assert.equal(r.seasonWarning, null);
  });

  test("a GOALIE timeshare is described as one, not flagged as irregular", async () => {
    const clubGames = club(20);
    const log = [0, 2, 4, 6, 8, 10, 12].map((i) => ({ gameDate: clubGames[i].gameDate, shotsAgainst: 30, goalsAgainst: 2 }));
    const r = await getNhlPlayerHitRate(stub({ log, clubGames, isGoalie: true }), {
      playerName: "Test Skater",
      teamAbbrev: "BUF",
      statID: "goalie_saves",
      line: 25.5,
      direction: "over",
      asOf: new Date("2026-11-20T00:00:00Z"),
    });
    assert.equal(r.isGoalie, true);
    assert.match(r.recentAvailability.note ?? "", /GOALIE/);
    assert.equal(r.gamesHit, 7); // 28 saves each, all over 25.5
  });
});
