import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  resolveEspnStat,
  readEspnStat,
  espnStatUnavailableReason,
  isEspnStatSupported,
} from "../src/services/espnStatMap.js";
import {
  normaliseEspnName,
  normaliseEspnTeamName,
  resolveEspnAthlete,
  resolveEspnTeam,
  extractTeams,
} from "../src/services/espnPlayerResolution.js";
import {
  espnSeasonsToFetch,
  extractEventMeta,
  getEspnPlayerHitRate,
  espnRowSeasonYear,
  EspnRefusal,
} from "../src/services/espnHitRateAggregator.js";
import { ESPN_LEAGUE_PATHS } from "../src/services/espnClient.js";

/**
 * v2.17.0: ESPN becomes the primary hit-rate source for NBA, NFL, WNBA, EPL and UCL.
 *
 * THE TEST THAT MATTERS MOST is "defense_sacks pointed at a quarterback REFUSES".
 * Everything else here is ordinary coverage; that one is the whole reason the witness
 * mechanism exists.
 *
 * Measured 2026-10-05: ESPN uses the column NAME "sacks" for sacks TAKEN on a
 * quarterback's log and sacks MADE on a defender's, and the NAME "interceptions" for
 * thrown on a passer and caught on a defender. So mapping on `names` - which is
 * correct, and which the probe itself recommends - is NOT sufficient. Without a shape
 * witness a pass rusher's sack prop grades against a quarterback's sacks-taken
 * column and returns a complete, plausible, wrong hit rate.
 *
 * Every `names` array below is copied verbatim from a live probe response.
 */

/* ---- MEASURED COLUMN SHAPES. Do not "tidy" these; they are evidence. ---- */
const NFL_QB = [
  "completions", "passingAttempts", "passingYards", "completionPct",
  "yardsPerPassAttempt", "passingTouchdowns", "interceptions", "longPassing",
  "sacks", "QBRating", "adjQBR", "rushingAttempts", "rushingYards",
  "yardsPerRushAttempt", "rushingTouchdowns", "longRushing",
];
const NFL_SKILL = [
  "receptions", "receivingTargets", "receivingYards", "yardsPerReception",
  "receivingTouchdowns", "longReception", "rushingAttempts", "rushingYards",
  "yardsPerRushAttempt", "longRushing", "rushingTouchdowns", "fumbles",
  "fumblesLost", "fumblesForced", "kicksBlocked",
];
const NFL_DEF = [
  "totalTackles", "soloTackles", "assistTackles", "sacks", "stuffs", "stuffYards",
  "fumbles", "fumblesLost", "fumblesForced", "fumblesRecovered", "kicksBlocked",
  "interceptions", "interceptionYards", "avgInterceptionYards",
  "interceptionTouchdowns", "longInterception", "passesDefended",
];
const NBA = [
  "minutes", "fieldGoalsMade-fieldGoalsAttempted", "fieldGoalPct",
  "threePointFieldGoalsMade-threePointFieldGoalsAttempted", "threePointPct",
  "freeThrowsMade-freeThrowsAttempted", "freeThrowPct", "totalRebounds", "assists",
  "blocks", "steals", "fouls", "turnovers", "points",
];
const SOCCER_OUT = [
  "totalGoals", "goalAssists", "totalShots", "shotsOnTarget", "foulsCommitted",
  "foulsSuffered", "offsides", "yellowCards", "redCards",
];
const SOCCER_GK = [
  "cleanSheet", "saves", "goalsConceded", "totalGoals", "goalAssists",
  "foulsCommitted", "foulsSuffered", "yellowCards", "redCards",
];

/* Josh Allen's real 2025 postseason row, verbatim from the probe. */
const QB_ROW = ["25","39","283","64.1","7.3","3","2","46","3","90.0","47.6","12","66","5.5","0","26"];
/* Greg Rousseau's real row. sacks = 0 at index 3, totalTackles = 2 at index 0. */
const DEF_ROW = ["2","0","2","0","0","0","-","-","0","0","0","0","0","0.0","0","0","1"];
/* Luka's real row: FG "7-18", 3PT "2-8", FT "12-15", PTS 28. */
const NBA_ROW = ["40","7-18","38.9","2-8","25.0","12-15","80.0","7","9","0","1","4","2","28"];

const read = (sport: string, statID: string, names: string[], row: string[]) => {
  const r = resolveEspnStat(sport as never, statID);
  assert.ok(r, `no resolver for ${sport}/${statID}`);
  return readEspnStat(r!, names, row);
};

describe("v2.17.0 THE COLLISION: ESPN reuses one name for opposite stats", () => {
  test("defense_sacks on a QUARTERBACK log REFUSES, it does not return sacks-taken", () => {
    const out = read("nfl", "defense_sacks", NFL_QB, QB_ROW);
    assert.equal(out.ok, false, "a QB's sacks-TAKEN column was accepted as sacks MADE");
    if (!out.ok) {
      assert.equal(out.wrongShape, true);
      assert.match(out.reason, /totalTackles/);
      assert.match(out.reason, /sacks TAKEN|sacks MADE/);
    }
  });

  test("defense_sacks on a DEFENDER log resolves, and to the right column", () => {
    const out = read("nfl", "defense_sacks", NFL_DEF, DEF_ROW);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.value, 0, "should read index 3 (0), not index 0 (2 tackles)");
  });

  test("passing_interceptions on a DEFENDER log REFUSES, it does not return INTs caught", () => {
    const out = read("nfl", "passing_interceptions", NFL_DEF, DEF_ROW);
    assert.equal(out.ok, false);
    if (!out.ok) assert.match(out.reason, /passingAttempts/);
  });

  test("passing_interceptions on a QB log resolves to interceptions THROWN", () => {
    const out = read("nfl", "passing_interceptions", NFL_QB, QB_ROW);
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.value, 2);
  });

  test("defense_interceptions on a QB log REFUSES", () => {
    const out = read("nfl", "defense_interceptions", NFL_QB, QB_ROW);
    assert.equal(out.ok, false);
  });

  /* PROOF THE WITNESS IS DOING THE WORK and not an index coincidence: the two shapes
   * put "sacks" at DIFFERENT indexes, 8 on a QB and 3 on a defender. An index-keyed
   * map would read index 8 on a defender, which is "fumblesForced". */
  test("the two shapes put the same name at different indexes, so index is unusable", () => {
    assert.equal(NFL_QB.indexOf("sacks"), 8);
    assert.equal(NFL_DEF.indexOf("sacks"), 3);
    assert.equal(NFL_DEF[8], "fumblesForced");
    assert.equal(NFL_QB.indexOf("interceptions"), 6);
    assert.equal(NFL_DEF.indexOf("interceptions"), 11);
  });
});

describe("v2.17.0 unambiguous NFL columns resolve on whichever shape carries them", () => {
  test("passing_yards off a QB row", () => {
    const out = read("nfl", "passing_yards", NFL_QB, QB_ROW);
    assert.equal(out.ok && out.value, 283);
  });

  test("rushing_yards resolves on BOTH QB and skill shapes - same meaning, no witness", () => {
    const qb = read("nfl", "rushing_yards", NFL_QB, QB_ROW);
    assert.equal(qb.ok && qb.value, 66);
    const skill = read("nfl", "rushing_yards", NFL_SKILL, new Array(15).fill("0"));
    assert.equal(skill.ok, true, "over-witnessing would refuse a log that can answer");
  });

  test("defensive tackle markets resolve off the defender shape", () => {
    assert.equal(read("nfl", "defense_combinedTackles", NFL_DEF, DEF_ROW).ok && true, true);
    const solo = read("nfl", "defense_soloTackles", NFL_DEF, DEF_ROW);
    assert.equal(solo.ok && solo.value, 0);
    const ast = read("nfl", "defense_assistedTackles", NFL_DEF, DEF_ROW);
    assert.equal(ast.ok && ast.value, 2);
  });

  test("a combo refuses WHOLE when one leg is missing, never partially", () => {
    // passing+rushing_yards needs the QB shape; a skill log has no passingYards.
    const out = read("nfl", "passing+rushing_yards", NFL_SKILL, new Array(15).fill("1"));
    assert.equal(out.ok, false, "a combo missing a leg returned a smaller number");
  });

  /* ---- THIS TEST EXISTS BECAUSE THE ONE ABOVE PASSED FOR THE WRONG REASON ----
   *
   * Mutation M4 removed the refusal inside the COMPONENT loop, so a combo silently
   * summed only the legs it could find - and the suite still went green. The test
   * above could not see it: passing+rushing_yards carries a WITNESS, so a skill-shape
   * log is refused at the witness gate before the component loop is ever reached.
   * It was proving the witness worked, not that partial sums are impossible.
   *
   * Basketball combos carry NO witness, so this one reaches the component loop. If
   * the partial-sum guard is removed, points+rebounds returns 28 instead of refusing.
   */
  test("a WITNESS-FREE combo also refuses whole, reaching the component guard", () => {
    const namesMinusRebounds = NBA.filter((n) => n !== "totalRebounds");
    const rowMinusRebounds = NBA_ROW.filter((_, i) => i !== NBA.indexOf("totalRebounds"));
    const r = resolveEspnStat("nba" as never, "points+rebounds");
    assert.ok(r);
    assert.equal(r!.witness, undefined, "this test is only meaningful without a witness");

    const out = readEspnStat(r!, namesMinusRebounds, rowMinusRebounds);
    assert.equal(out.ok, false, "the combo summed only the legs it found");
    if (!out.ok) assert.match(out.reason, /totalRebounds/);
  });

  test("a combo sums its legs when all are present", () => {
    const out = read("nfl", "passing+rushing_yards", NFL_QB, QB_ROW);
    assert.equal(out.ok && out.value, 283 + 66);
  });
});

describe("v2.17.0 basketball paired columns: one column holds made AND attempted", () => {
  test("fieldGoalsMade takes the LEFT side of 7-18", () => {
    const out = read("nba", "fieldGoalsMade", NBA, NBA_ROW);
    assert.equal(out.ok && out.value, 7);
  });

  test("fieldGoalsAttempted takes the RIGHT side of the SAME column", () => {
    const out = read("nba", "fieldGoalsAttempted", NBA, NBA_ROW);
    assert.equal(out.ok && out.value, 18);
  });

  test("threePointersMade and freeThrowsAttempted do the same", () => {
    assert.equal(read("nba", "threePointersMade", NBA, NBA_ROW).ok && read("nba", "threePointersMade", NBA, NBA_ROW).value, 2);
    const fta = read("nba", "freeThrowsAttempted", NBA, NBA_ROW);
    assert.equal(fta.ok && fta.value, 15);
  });

  test("plain counts and a PRA combo", () => {
    assert.equal(read("nba", "points", NBA, NBA_ROW).ok && read("nba", "points", NBA, NBA_ROW).value, 28);
    assert.equal(read("nba", "rebounds", NBA, NBA_ROW).ok && read("nba", "rebounds", NBA, NBA_ROW).value, 7);
    const pra = read("nba", "points+rebounds+assists", NBA, NBA_ROW);
    assert.equal(pra.ok && pra.value, 28 + 7 + 9);
  });

  test("minutesPlayed maps for basketball but NOT for soccer", () => {
    assert.equal(isEspnStatSupported("nba" as never, "minutesPlayed"), true);
    assert.equal(isEspnStatSupported("epl" as never, "minutesPlayed"), false);
  });

  test("wnba shares the basketball resolvers - ONE BASKETBALL STAT NAMESPACE", () => {
    assert.equal(isEspnStatSupported("wnba" as never, "points"), true);
    assert.equal(isEspnStatSupported("wnba" as never, "rebounds"), true);
  });
});

describe("v2.17.0 soccer, two shapes", () => {
  test("shots_onGoal and shots resolve off an outfielder", () => {
    const row = ["1","0","3","1","0","0","1","1","0"];
    assert.equal(read("epl", "shots_onGoal", SOCCER_OUT, row).ok && read("epl", "shots_onGoal", SOCCER_OUT, row).value, 1);
    assert.equal(read("epl", "shots", SOCCER_OUT, row).ok && read("epl", "shots", SOCCER_OUT, row).value, 3);
  });

  test("goals+assists sums, because that statID names its own definition", () => {
    const row = ["2","1","4","3","0","0","0","0","0"];
    const out = read("epl", "goals+assists", SOCCER_OUT, row);
    assert.equal(out.ok && out.value, 3);
  });

  test("goalie_saves REFUSES on an outfielder and resolves on a keeper", () => {
    const outfield = read("epl", "goalie_saves", SOCCER_OUT, ["1","0","3","1","0","0","1","1","0"]);
    assert.equal(outfield.ok, false, "an outfielder has no saves column");
    const keeper = read("epl", "goalie_saves", SOCCER_GK, ["1","4","0","0","0","0","0","0","0"]);
    assert.equal(keeper.ok && keeper.value, 4);
  });

  test("ucl shares the soccer resolvers", () => {
    assert.equal(isEspnStatSupported("ucl" as never, "shots_onGoal"), true);
  });
});

describe("v2.17.0 named refusals, never an empty rate", () => {
  const cases: [string, string, RegExp][] = [
    ["nfl", "fieldGoals_made", /EMPTY FOR KICKERS|ZERO game rows/],
    ["nfl", "punting_numPunts", /EMPTY FOR KICKERS|ZERO game rows/],
    ["nfl", "touchdowns", /AMBIGUOUS DEFINITION/],
    ["nfl", "turnovers", /AMBIGUOUS DEFINITION/],
    ["nba", "offensiveRebounds", /ONLY "totalRebounds"/],
    ["epl", "minutesPlayed", /NO MINUTES COLUMN/],
    ["epl", "tackles", /nine ?columns|Not present/],
    ["epl", "points", /UNVERIFIED CROSSOVER/],
  ];
  for (const [sport, statID, pattern] of cases) {
    test(`${sport} ${statID} refuses by name`, () => {
      const reason = espnStatUnavailableReason(sport as never, statID);
      assert.ok(reason, `${statID} has no named refusal`);
      assert.match(reason!, pattern);
      assert.equal(isEspnStatSupported(sport as never, statID), false);
    });
  }

  test("the soccer minutes refusal carries the ROTATION warning, not just a gap note", () => {
    const r = espnStatUnavailableReason("epl" as never, "minutesPlayed")!;
    assert.match(r, /rotation risk|Rotation risk/i);
    assert.match(r, /20-minute/);
  });

  test("the kicker refusal names what was measured, so it is checkable", () => {
    const r = espnStatUnavailableReason("nfl" as never, "fieldGoals_made")!;
    assert.match(r, /3917232/);
    assert.match(r, /200/);
  });
});

describe('v2.17.0 "-" IS NOT ZERO', () => {
  test("an absent cell refuses rather than counting as 0", () => {
    // Rousseau's FUM column is "-". fumbles is not mapped, so use a shape where an
    // absent value lands on a MAPPED column: blank out passingYards on a QB row.
    const row = [...QB_ROW];
    row[NFL_QB.indexOf("passingYards")] = "-";
    const out = read("nfl", "passing_yards", NFL_QB, row);
    assert.equal(out.ok, false, '"-" was silently read as 0');
    if (!out.ok) assert.match(out.reason, /NOT zero|not substituted/);
  });
});

describe("v2.17.0 season param convention differs by sport, and is measured", () => {
  test("NBA uses the END year: October 2026 is season 2027", () => {
    const s = espnSeasonsToFetch("nba" as never, new Date("2026-10-05T00:00:00Z"));
    assert.equal(s[0], 2027);
    assert.equal(s[1], 2026, "prior season reached by default, because it is free here");
  });

  test("NBA in April stays on the season that started last autumn", () => {
    const s = espnSeasonsToFetch("nba" as never, new Date("2026-04-05T00:00:00Z"));
    assert.equal(s[0], 2026);
  });

  test("NFL uses the START year: October 2026 is season 2026", () => {
    const s = espnSeasonsToFetch("nfl" as never, new Date("2026-10-05T00:00:00Z"));
    assert.equal(s[0], 2026);
  });

  test("an NFL January playoff game belongs to the PRIOR start year", () => {
    const s = espnSeasonsToFetch("nfl" as never, new Date("2027-01-15T00:00:00Z"));
    assert.equal(s[0], 2026);
  });

  test("WNBA is a single calendar year", () => {
    const s = espnSeasonsToFetch("wnba" as never, new Date("2026-07-01T00:00:00Z"));
    assert.equal(s[0], 2026);
  });

  /* SOCCER IS DELIBERATELY EMPTY. The numeric convention was never measured, so the
   * aggregator fetches ESPN's default instead of passing an integer that might
   * silently select a different year than intended. */
  test("soccer returns NO seasons, so the caller fetches the default instead of guessing", () => {
    assert.deepEqual(espnSeasonsToFetch("epl" as never, new Date("2026-10-05T00:00:00Z")), []);
    assert.deepEqual(espnSeasonsToFetch("ucl" as never, new Date("2026-10-05T00:00:00Z")), []);
  });

  test("allowPriorSeasons false narrows to one", () => {
    const s = espnSeasonsToFetch("nba" as never, new Date("2026-10-05T00:00:00Z"), {
      allowPriorSeasons: false,
    });
    assert.equal(s.length, 1);
  });
});

describe("v2.17.0 dates come from the events map, or the row is dropped", () => {
  const log = {
    names: NBA,
    events: {
      "401768058": {
        id: "401768058",
        gameDate: "2025-05-01T02:00:00.000+00:00",
        atVs: "vs",
        opponent: { abbreviation: "MIN", displayName: "Minnesota Timberwolves" },
      },
      "401768057": {
        id: "401768057",
        gameDate: "2025-04-27T19:50:00.000+00:00",
        atVs: "@",
        opponent: { abbreviation: "MIN" },
      },
      "999": { id: "999", atVs: "vs" }, // NO gameDate
      "998": { id: "998", gameDate: "not a date" },
    },
  };

  test("gameDate, atVs and opponent are all read", () => {
    const m = extractEventMeta(log as never);
    const a = m.get("401768058")!;
    assert.equal(a.dateISO, new Date("2025-05-01T02:00:00.000+00:00").toISOString());
    assert.equal(a.isHome, true);
    assert.equal(a.opponent, "MIN");
    assert.equal(m.get("401768057")!.isHome, false, '"@" is an away game');
  });

  /* THE v2.7.1 LESSON. A row with no usable date must be DROPPED, not stamped with a
   * synthetic one. A synthetic date made summarizeSeasons and describeRecency inert
   * and they reported a clean result over fifteen prior-season games. */
  test("a row with no gameDate, or an unparseable one, is NOT given a synthetic date", () => {
    const m = extractEventMeta(log as never);
    assert.equal(m.has("999"), false, "a dateless row was kept");
    assert.equal(m.has("998"), false, "an unparseable date was kept");
    assert.equal(m.size, 2);
  });

  test("no events map at all yields an empty map rather than throwing", () => {
    assert.equal(extractEventMeta({ names: NBA } as never).size, 0);
  });
});

describe("v2.17.0 seasonYear comes from the DATE, not from ESPN's season param", () => {
  /* FOUND ON A LIVE DEPLOY. Luka's March/April 2026 games were fetched under ESPN
   * season=2026 and the rows were stamped seasonYear 2026, while summarizeSeasons in
   * the SAME response reported seasonsRepresented [2025] and "EVERY game is from a
   * PRIOR season". types.ts defines seasonYear as "the year the season STARTED", and
   * ESPN's param is the END year for NBA. Echoing the provider's param into a field
   * with a different contract is the NHL season-label bug again. */
  test("an NBA April game belongs to the season that STARTED the prior autumn", () => {
    assert.equal(espnRowSeasonYear("nba" as never, "2026-04-03T01:30:00.000Z"), 2025);
  });

  test("an NBA December game belongs to that same season", () => {
    assert.equal(espnRowSeasonYear("nba" as never, "2025-12-09T01:30:00.000Z"), 2025);
  });

  test("an NFL January playoff game belongs to the prior start year", () => {
    assert.equal(espnRowSeasonYear("nfl" as never, "2026-01-17T21:30:00.000Z"), 2025);
  });

  test("an NFL October game belongs to the current start year", () => {
    assert.equal(espnRowSeasonYear("nfl" as never, "2026-10-04T17:00:00.000Z"), 2026);
  });

  /* THE INVARIANT THAT MATTERS: whatever the per-row label is, it must agree with
   * seasonsRepresented, which summarizeSeasons derives from the same dates. Two
   * conventions in one response is the defect, so the test is agreement rather than
   * any particular number. */
  test("every row's seasonYear appears in seasonsRepresented", async () => {
    const TEAMS = {
      sports: [{ leagues: [{ teams: [
        { team: { id: "13", displayName: "Los Angeles Lakers", abbreviation: "LAL" } },
      ] }] }],
    };
    const ROSTER = { athletes: [{ id: "3945274", displayName: "Luka Doncic", firstName: "Luka" }] };
    const dates = ["2026-04-03T01:30:00.000Z", "2026-03-28T02:30:00.000Z"];
    const log = {
      names: NBA,
      labels: NBA,
      seasonTypes: [{
        displayName: "2025-26 Regular Season",
        categories: [{
          displayName: "april",
          events: dates.map((_, i) => ({ eventId: `E${i}`, stats: NBA_ROW })),
        }],
      }],
      events: Object.fromEntries(
        dates.map((d, i) => [`E${i}`, { id: `E${i}`, gameDate: d, atVs: "vs", opponent: { abbreviation: "OKC" } }])
      ),
    };
    const espn = {
      fetchTeams: async () => ({ ok: true, data: TEAMS, elapsedMs: 1, url: "t" }),
      fetchRoster: async () => ({ ok: true, data: ROSTER, elapsedMs: 1, url: "r" }),
      fetchGamelog: async () => ({ ok: true, data: log, elapsedMs: 1, url: "g" }),
    } as never;

    const r = await getEspnPlayerHitRate(espn, {
      sport: "nba" as never,
      playerName: "Luka Doncic",
      teamName: "Los Angeles Lakers",
      statID: "points",
      line: 20.5,
      direction: "over",
      allowPriorSeasons: false,
    });

    assert.ok(r.log.length > 0);
    for (const row of r.log) {
      assert.ok(
        row.seasonYear !== undefined,
        `a row carried no seasonYear (${row.date})`
      );
      assert.ok(
        (r.seasonsRepresented as number[]).includes(row.seasonYear!),
        `row labelled season ${row.seasonYear} but seasonsRepresented is ` +
          `${JSON.stringify(r.seasonsRepresented)} - two conventions in one response`
      );
    }
    assert.equal(r.log[0].seasonYear, 2025, "an April 2026 NBA game is the 2025 season");
  });
});

describe("v2.17.0 the ID bridge refuses ambiguity", () => {
  test("accents fold: SGO and ESPN disagree on diacritics", () => {
    assert.equal(normaliseEspnName("Luka Doncic"), normaliseEspnName("Luka Dončić"));
    assert.equal(normaliseEspnName("Ronald Araujo"), normaliseEspnName("Ronald Araújo"));
    assert.equal(normaliseEspnName("Jeremie Frimpong"), normaliseEspnName("Jérémie Frimpong"));
  });

  test("suffixes and punctuation fold", () => {
    assert.equal(normaliseEspnName("James Cook III"), normaliseEspnName("James Cook"));
    assert.equal(normaliseEspnName("Jedrick Wills Jr."), normaliseEspnName("Jedrick Wills"));
    assert.equal(normaliseEspnName("C.J. Stroud"), normaliseEspnName("CJ Stroud"));
    assert.equal(normaliseEspnName("A.J. Brown"), normaliseEspnName("AJ Brown"));
  });

  test("club-form tokens come off TEAM names only", () => {
    assert.equal(normaliseEspnTeamName("Liverpool FC"), "liverpool");
    assert.equal(normaliseEspnTeamName("AFC Bournemouth"), "bournemouth");
    // and "United"/"City" survive, because those distinguish real clubs
    assert.notEqual(
      normaliseEspnTeamName("Manchester United"),
      normaliseEspnTeamName("Manchester City")
    );
  });

  /* THE TWO JOSH ALLENS. Live in this connector's own data: the Buffalo roster has
   * Josh Allen the quarterback, and SGO's NFL index returned another on Arizona. */
  test("two players with the same name on one roster REFUSES, never picks", () => {
    const roster = [
      { id: "3918298", displayName: "Josh Allen" },
      { id: "35162406", displayName: "Josh Allen" },
    ];
    const r = resolveEspnAthlete(roster, "Josh Allen");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /Refusing/);
      assert.equal(r.candidates?.length, 2);
    }
  });

  test("an unambiguous surname resolves, an ambiguous one refuses", () => {
    const ok = resolveEspnAthlete(
      [{ id: "1", displayName: "Khalil Shakir" }, { id: "2", displayName: "Dalton Kincaid" }],
      "K. Shakir"
    );
    assert.equal(ok.ok, true);
    const bad = resolveEspnAthlete(
      [{ id: "1", displayName: "Josh Allen" }, { id: "2", displayName: "Kyle Allen" }],
      "Brandon Allen"
    );
    assert.equal(bad.ok, false, "two Allens on one roster must not resolve by surname");
  });

  test("teams resolve by full name and by last word, and refuse when ambiguous", () => {
    const teams = [
      { id: "2", displayName: "Buffalo Bills", abbreviation: "BUF" },
      { id: "364", displayName: "Liverpool", abbreviation: "LIV" },
      { id: "382", displayName: "Manchester City", abbreviation: "MNC" },
    ];
    assert.equal((resolveEspnTeam(teams, "Buffalo Bills") as { value: { id: string } }).value.id, "2");
    assert.equal((resolveEspnTeam(teams, "Liverpool FC") as { value: { id: string } }).value.id, "364");
    assert.equal(resolveEspnTeam(teams, "Nonexistent United").ok, false);
  });

  test("extractTeams walks by SHAPE, so a nesting change does not silently return nothing", () => {
    const payload = {
      sports: [{ leagues: [{ teams: [
        { team: { id: "2", displayName: "Buffalo Bills", abbreviation: "BUF" } },
        { team: { id: "3", displayName: "Chicago Bears", abbreviation: "CHI" } },
      ] }] }],
    };
    const teams = extractTeams(payload);
    assert.equal(teams.length, 2);
    assert.equal(teams[0].id, "2");
  });
});

describe("v2.17.0 the aggregator end to end, no network", () => {
  const TEAMS = {
    sports: [{ leagues: [{ teams: [
      { team: { id: "2", displayName: "Buffalo Bills", abbreviation: "BUF" } },
    ] }] }],
  };
  const ROSTER = {
    athletes: [
      { id: "3918298", displayName: "Josh Allen", firstName: "Josh" },
      { id: "4373678", displayName: "Khalil Shakir", firstName: "Khalil" },
    ],
  };
  const gamelog = (names: string[], rows: [string, string[]][]) => ({
    names,
    labels: names,
    seasonTypes: [
      {
        displayName: "2025 Regular Season",
        categories: [
          {
            displayName: "Regular Season Stats",
            events: rows.map(([id, stats]) => ({ eventId: id, stats })),
          },
        ],
      },
    ],
    events: Object.fromEntries(
      rows.map(([id], i) => [
        id,
        {
          id,
          gameDate: `2025-1${i}-05T18:00:00.000+00:00`,
          atVs: i % 2 ? "@" : "vs",
          opponent: { abbreviation: "MIA" },
        },
      ])
    ),
  });

  const fakeEspn = (log: unknown) =>
    ({
      fetchTeams: async () => ({ ok: true, data: TEAMS, elapsedMs: 1, url: "t" }),
      fetchRoster: async () => ({ ok: true, data: ROSTER, elapsedMs: 1, url: "r" }),
      fetchGamelog: async () => ({ ok: true, data: log, elapsedMs: 1, url: "g" }),
    }) as never;

  test("a QB passing-yards rate resolves, newest first, with real dates", async () => {
    const log = gamelog(NFL_QB, [
      ["A", QB_ROW],                                    // 283
      ["B", QB_ROW.map((v, i) => (i === 2 ? "150" : v))], // 150
      ["C", QB_ROW.map((v, i) => (i === 2 ? "310" : v))], // 310
    ]);
    const r = await getEspnPlayerHitRate(fakeEspn(log), {
      sport: "nfl" as never,
      playerName: "Josh Allen",
      teamName: "Buffalo Bills",
      statID: "passing_yards",
      line: 250.5,
      direction: "over",
    });
    assert.equal(r.gamesConsidered, 3);
    assert.equal(r.gamesHit, 2, "283 and 310 clear 250.5; 150 does not");
    assert.equal(r.espnAthleteId, "3918298");
    assert.equal(r.espnTeamId, "2");
    // newest first
    assert.ok(r.log[0].date > r.log[1].date, "log must be newest first");
    assert.equal(r.rowsWithoutDate, 0);
    assert.equal(r.preseasonExcluded, true);
  });

  test("THE HEADLINE: defense_sacks against a QUARTERBACK refuses through the aggregator", async () => {
    const log = gamelog(NFL_QB, [["A", QB_ROW]]);
    await assert.rejects(
      () =>
        getEspnPlayerHitRate(fakeEspn(log), {
          sport: "nfl" as never,
          playerName: "Josh Allen",
          teamName: "Buffalo Bills",
          statID: "defense_sacks",
          line: 0.5,
          direction: "over",
        }),
      (err: unknown) => {
        assert.ok(err instanceof EspnRefusal, "must be a considered refusal, not a crash");
        assert.match((err as Error).message, /WRONG SHAPE|totalTackles/);
        return true;
      }
    );
  });

  test("an unmapped stat refuses BEFORE any HTTP call", async () => {
    let called = 0;
    const counting = {
      fetchTeams: async () => {
        called++;
        return { ok: true, data: TEAMS, elapsedMs: 1, url: "t" };
      },
      fetchRoster: async () => ({ ok: true, data: ROSTER, elapsedMs: 1, url: "r" }),
      fetchGamelog: async () => ({ ok: true, data: gamelog(NFL_QB, [["A", QB_ROW]]), elapsedMs: 1, url: "g" }),
    } as never;
    await assert.rejects(() =>
      getEspnPlayerHitRate(counting, {
        sport: "nfl" as never,
        playerName: "Josh Allen",
        teamName: "Buffalo Bills",
        statID: "fieldGoals_made",
        line: 1.5,
        direction: "over",
      })
    );
    assert.equal(called, 0, "a code-level refusal must not spend a request");
  });

  test("a 200-with-no-rows gamelog refuses, which is the kicker shape", async () => {
    await assert.rejects(
      () =>
        getEspnPlayerHitRate(fakeEspn({ filters: [] }), {
          sport: "nfl" as never,
          playerName: "Josh Allen",
          teamName: "Buffalo Bills",
          statID: "passing_yards",
          line: 250.5,
          direction: "over",
        }),
      /no column names|no dated regular-season games/
    );
  });

  test("an unresolvable player refuses and names the roster size", async () => {
    await assert.rejects(
      () =>
        getEspnPlayerHitRate(fakeEspn(gamelog(NFL_QB, [["A", QB_ROW]])), {
          sport: "nfl" as never,
          playerName: "Patrick Mahomes",
          teamName: "Buffalo Bills",
          statID: "passing_yards",
          line: 250.5,
          direction: "over",
        }),
      /not on this ESPN roster/
    );
  });

  test("availability is reported UNKNOWN, not a flattering 1.0", async () => {
    const r = await getEspnPlayerHitRate(fakeEspn(gamelog(NFL_QB, [["A", QB_ROW]])), {
      sport: "nfl" as never,
      playerName: "Josh Allen",
      teamName: "Buffalo Bills",
      statID: "passing_yards",
      line: 250.5,
      direction: "over",
    });
    assert.equal(r.recentAvailability.flag, "UNKNOWN");
    assert.match(r.recentAvailability.note!, /cannot show DNPs|NOT an availability measure/);
  });
});

describe("v2.17.0 wiring", () => {
  const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const hitRateSrc = readFileSync(new URL("../src/tools/hitRate.ts", import.meta.url), "utf8");

  test("soccer league paths are registered", () => {
    assert.equal(ESPN_LEAGUE_PATHS.epl?.league, "eng.1");
    assert.equal(ESPN_LEAGUE_PATHS.ucl?.league, "uefa.champions");
    assert.equal(ESPN_LEAGUE_PATHS.epl?.sport, "soccer");
  });

  test("one shared EspnClient is built and passed to the hit-rate tool", () => {
    assert.match(indexSrc, /const espn = new EspnClient\(\);/);
    assert.match(
      indexSrc,
      /registerHitRateTool\(server, sgo, bdl, cfbd, cbbd, nhlStats, espn\);/
    );
  });

  test("dataSource accepts espn", () => {
    assert.match(hitRateSrc, /\.enum\(\["auto", "bdl", "sgo", "cfbd", "espn"\]\)/);
  });

  test("auto routes the five ESPN sports", () => {
    assert.match(
      hitRateSrc,
      /ESPN_AUTO_SPORTS: SportKey\[\] = \["nba", "nfl", "wnba", "epl", "ucl"\]/
    );
  });

  /* The stale Pro-tier claim was live in the TOOL DESCRIPTION every scheduled run
   * reads, telling the agent entity cost was no longer a constraint. On a Rookie key
   * that is false. */
  test("the tool description no longer claims SGO entity cost does not apply", () => {
    assert.ok(
      /NO LONGER TRUE/.test(hitRateSrc),
      "the Pro-era cost claim must be explicitly retracted in the description"
    );
    assert.ok(
      !/so that cost argument no longer applies, and SGO's box scores were verified/.test(hitRateSrc),
      "the original unqualified Pro-tier claim is still present"
    );
  });

  test("package.json agrees with SERVER_VERSION", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const m = indexSrc.match(/const SERVER_VERSION = "([^"]+)";/);
    assert.ok(m);
    assert.equal(pkg.version, m![1]);
  });
});
