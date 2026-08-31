import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStanding } from "../src/services/standingsNormalizer.js";
import type { BDLStanding } from "../src/types.js";

/**
 * Both cases here are REAL rows returned live on 2026-08-27 by the first run of
 * tkb_get_standings against NCAAF. Neither bug was hypothetical: one printed the
 * literal string "null-0" as a team record, the other nulled the road column on
 * all 17 ACC rows.
 */

const ncaafPreseason = {
  team: { id: 1, name: "Eagles", full_name: "Boston College Eagles", abbreviation: "BC" },
  season: 2026,
  wins: null,
  losses: 0,
  home_record: "0-0",
  away_record: "0-0",
  conference_record: "0-0",
} as unknown as BDLStanding;

test("null wins never compose into the string 'null-0'", () => {
  // BDL returns wins: null pre-season. The old guard was `!== undefined`, which
  // null passes, so it interpolated null straight into the record string.
  const n = normalizeStanding(ncaafPreseason);
  assert.notEqual(n.overallRecord, "null-0");
  assert.equal(n.overallRecord, null);
});

test("NCAAF away_record populates roadRecord (third naming variant)", () => {
  // NFL says road_record, MLB says road, NCAAF says away_record. Reading only the
  // first two returned null here on every CFB row.
  const n = normalizeStanding(ncaafPreseason);
  assert.equal(n.roadRecord, "0-0");
  assert.equal(n.homeRecord, "0-0");
  assert.equal(n.conferenceRecord, "0-0");
});

test("real numbers still compose normally", () => {
  const played = {
    team: { id: 15, name: "Cavaliers", full_name: "Virginia Cavaliers", abbreviation: "UVA" },
    season: 2025,
    wins: 5,
    losses: 1,
    home_record: "4-0",
    away_record: "1-1",
    conference_record: "3-0",
  } as unknown as BDLStanding;
  const n = normalizeStanding(played);
  assert.equal(n.overallRecord, "5-1");
  assert.equal(n.roadRecord, "1-1");
});

test("NFL and MLB naming still win over the new alias", () => {
  const nfl = {
    team: { id: 1, name: "Ravens", full_name: "Baltimore Ravens", abbreviation: "BAL" },
    overall_record: "3-0",
    home_record: "2-0",
    road_record: "1-0",
  } as unknown as BDLStanding;
  assert.equal(normalizeStanding(nfl).roadRecord, "1-0");

  const mlb = {
    team: { id: 2, name: "Phillies", full_name: "Philadelphia Phillies", abbreviation: "PHI" },
    total: "44-37",
    home: "24-11",
    road: "20-26",
  } as unknown as BDLStanding;
  const m = normalizeStanding(mlb);
  assert.equal(m.overallRecord, "44-37");
  assert.equal(m.roadRecord, "20-26");
});

test("explicit numeric home/road fields still take precedence over strings", () => {
  const mlb = {
    team: { id: 2, name: "Phillies", full_name: "Philadelphia Phillies", abbreviation: "PHI" },
    home: "24-11",
    road: "20-26",
    home_wins: 24,
    home_losses: 11,
    road_wins: 20,
    road_losses: 26,
  } as unknown as BDLStanding;
  const n = normalizeStanding(mlb);
  assert.equal(n.homeWins, 24);
  assert.equal(n.roadLosses, 26);
});
