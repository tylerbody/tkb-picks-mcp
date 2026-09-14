import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { lookupCbbdStat, isCbbdStatSupported, type CbbdPlayerRow } from "../src/services/cbbdStatMap.js";
import {
  deriveCbbdTeamName,
  resolveCbbdPlayer,
  buildWindows,
} from "../src/services/cbbdHitRateAggregator.js";
import type { CbbdTeamBoxScore } from "../src/services/cbbdClient.js";

/**
 * The row shape below is CollegeBasketballData's, taken from its own server source
 * rather than inferred from CollegeFootballData's. The nesting is the whole point:
 * threes, rebounds and free throws are OBJECTS, and a mapper that read them flat
 * would return undefined for the three most-posted college markets.
 */
const row = (over: Partial<CbbdPlayerRow> = {}): CbbdPlayerRow => ({
  athleteId: 4433176,
  name: "Braden Smith",
  position: "G",
  starter: true,
  ejected: false,
  minutes: 34,
  points: 18,
  assists: 9,
  steals: 2,
  blocks: 0,
  turnovers: 3,
  fouls: 1,
  fieldGoals: { made: 6, attempted: 13, pct: 0.462 },
  twoPointFieldGoals: { made: 3, attempted: 6, pct: 0.5 },
  threePointFieldGoals: { made: 3, attempted: 7, pct: 0.429 },
  freeThrows: { made: 3, attempted: 4, pct: 0.75 },
  rebounds: { offensive: 1, defensive: 4, total: 5 },
  ...over,
});

describe("lookupCbbdStat - the nested fields are where this would break", () => {
  test("threes come from threePointFieldGoals.made, not a flat field", () => {
    const r = lookupCbbdStat(row(), "threePointersMade");
    assert.equal(r.kind, "value");
    if (r.kind !== "value") return;
    assert.equal(r.value, 3);
    assert.equal(r.matchedField, "threePointFieldGoals.made");
  });

  test("rebounds come from rebounds.total, and offensive boards from rebounds.offensive", () => {
    const total = lookupCbbdStat(row(), "rebounds");
    assert.equal(total.kind === "value" && total.value, 5);
    const off = lookupCbbdStat(row(), "offensiveRebounds");
    assert.equal(off.kind === "value" && off.value, 1);
  });

  test("flat fields still resolve", () => {
    assert.equal(lookupCbbdStat(row(), "points").kind === "value" && lookupCbbdStat(row(), "points"). kind, "value");
    const a = lookupCbbdStat(row(), "assists");
    assert.equal(a.kind === "value" && a.value, 9);
  });

  test("A ZERO IS A VALUE, and must not be mistaken for an absence", () => {
    const r = lookupCbbdStat(row(), "blocks");
    assert.equal(r.kind, "value");
    assert.equal(r.kind === "value" && r.value, 0);
  });

  test("NULL IS NOT ZERO. A null field is an absence, never a 0.", () => {
    // CBBD's own source converts DB values with `x !== null ? Number(x) : null`, so
    // nulls are intentional. This repo has shipped null-read-as-zero twice.
    const r = lookupCbbdStat(row({ points: null }), "points");
    assert.equal(r.kind, "field_absent");
    assert.doesNotMatch(JSON.stringify(r), /"value":\s*0/);
  });

  test("a missing nested object is an absence, not a crash", () => {
    const r = lookupCbbdStat(row({ rebounds: null }), "rebounds");
    assert.equal(r.kind, "field_absent");
  });

  test("an unmapped statID refuses and names what IS supported", () => {
    const r = lookupCbbdStat(row(), "passing_yards");
    assert.equal(r.kind, "stat_not_mapped");
    if (r.kind !== "stat_not_mapped") return;
    assert.match(r.note, /Do NOT substitute/);
    assert.match(r.note, /threePointersMade/);
  });
});

describe("composites are all-or-nothing", () => {
  test("points+rebounds+assists sums the three real values", () => {
    const r = lookupCbbdStat(row(), "points+rebounds+assists");
    assert.equal(r.kind === "value" && r.value, 18 + 5 + 9);
  });

  test("blocks+steals works even though blocks is 0", () => {
    const r = lookupCbbdStat(row(), "blocks+steals");
    assert.equal(r.kind === "value" && r.value, 2);
  });

  test("ONE NULL COMPONENT REFUSES THE WHOLE COMPOSITE", () => {
    // A partial sum is a plausible wrong number, which is worse than a refusal.
    const r = lookupCbbdStat(row({ rebounds: null }), "points+rebounds+assists");
    assert.notEqual(r.kind, "value");
    if (r.kind === "value") return;
    assert.match(r.note, /partial sum/i);
  });

  test("every catalogued composite is actually supported", () => {
    for (const id of [
      "points+rebounds",
      "points+assists",
      "rebounds+assists",
      "points+rebounds+assists",
      "blocks+steals",
    ]) {
      assert.equal(isCbbdStatSupported(id), true, `${id} must be mapped`);
    }
  });
});

describe("deriveCbbdTeamName - the v2.8.6 bug, pre-empted", () => {
  test("strips the SGO league suffix", () => {
    assert.equal(deriveCbbdTeamName("PURDUE_NCAAB"), "Purdue");
  });

  test("keeps all-caps programs capitalised", () => {
    assert.equal(deriveCbbdTeamName("BYU_NCAAB"), "BYU");
    assert.equal(deriveCbbdTeamName("UCLA_NCAAB"), "UCLA");
  });

  test("handles the awkward names by override rather than by cleverness", () => {
    assert.equal(deriveCbbdTeamName("OLE_MISS_NCAAB"), "Ole Miss");
    assert.equal(deriveCbbdTeamName("SAINT_MARYS_NCAAB"), "Saint Mary's");
    assert.equal(deriveCbbdTeamName("MIAMI_OHIO_NCAAB"), "Miami (OH)");
  });

  test("multi-word programs title-case rather than shouting", () => {
    assert.equal(deriveCbbdTeamName("MICHIGAN_STATE_NCAAB"), "Michigan State");
  });

  test("an SGO teamID never survives unchanged into a name compare", () => {
    // The precise failure on the football side: COLORADO_NCAAF was compared against
    // "Colorado", never matched, and every CFB hit rate returned NO SAMPLE silently.
    assert.notEqual(deriveCbbdTeamName("COLORADO_NCAAB"), "COLORADO_NCAAB");
  });
});

const boxScore = (over: Partial<CbbdTeamBoxScore> = {}): CbbdTeamBoxScore => ({
  gameId: 401,
  season: 2026,
  seasonType: "regular",
  startDate: "2026-11-14T00:00:00.000Z",
  teamId: 2509,
  team: "Purdue",
  conference: "Big Ten",
  opponentId: 84,
  opponent: "Indiana",
  neutralSite: false,
  isHome: true,
  players: [row()],
  ...over,
});

describe("resolveCbbdPlayer", () => {
  test("resolves a player on the right team", () => {
    const r = resolveCbbdPlayer([boxScore()], "Purdue", "Braden Smith");
    assert.equal("id" in r && r.id, 4433176);
  });

  test("IGNORES THE SAME NAME ON THE OPPONENT", () => {
    const opponentRow = boxScore({
      team: "Indiana",
      players: [row({ athleteId: 999, name: "Braden Smith" })],
    });
    const r = resolveCbbdPlayer([opponentRow], "Purdue", "Braden Smith");
    assert.ok("error" in r);
  });

  test("REFUSES ON AMBIGUITY rather than picking one", () => {
    const twoSameName = boxScore({
      players: [row(), row({ athleteId: 555 })],
    });
    const r = resolveCbbdPlayer([twoSameName], "Purdue", "Braden Smith");
    assert.ok("error" in r);
    if (!("error" in r)) return;
    assert.match(r.error, /AMBIGUOUS/);
    assert.match(r.error, /worse than no hit rate/);
  });

  test("a miss says to check the TEAM NAME, not just the player", () => {
    const r = resolveCbbdPlayer([boxScore()], "Purdue", "Nobody At All");
    assert.ok("error" in r);
    if (!("error" in r)) return;
    assert.match(r.error, /TEAM NAME/);
  });
});

describe("buildWindows", () => {
  const asOf = new Date("2026-12-01T12:00:00.000Z");

  test("walks BACKWARD, newest window first", () => {
    const w = buildWindows(asOf, 3);
    assert.ok(new Date(w[0].startISO) > new Date(w[1].startISO));
    assert.ok(new Date(w[1].startISO) > new Date(w[2].startISO));
  });

  test("the first window contains today and is NOT cached permanently", () => {
    const w = buildWindows(asOf, 3);
    assert.equal(w[0].closed, false, "a window containing live games must expire");
    assert.equal(w[1].closed, true, "a closed week is immutable and cached forever");
  });

  test("windows are a week wide", () => {
    const w = buildWindows(asOf, 1)[0];
    const days = (new Date(w.endISO).getTime() - new Date(w.startISO).getTime()) / 86_400_000;
    assert.equal(days, 7);
  });
});
