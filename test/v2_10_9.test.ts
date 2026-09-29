import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OU_PROP_MARKETS } from "../src/services/marketCatalog.js";

/**
 * v2.10.9: the WNBA catalog gap the drift detector could not see, and the drop paths
 * the v2.10.7 coverage block did not count.
 *
 * WHY THE DRIFT DETECTOR MISSED IT. `statIDsNotInCatalog` only names a statID the books
 * actually PRICED on the event in front of it. On the 2026-09-29 WNBA playoff boards
 * none of the four missing markets were posted, so the detector reported an empty drift
 * map and the v2.10.8 test comment recorded "MLB and WNBA perfectly aligned" as if that
 * settled completeness. It did not. Measurement proves what IS priced; it cannot prove
 * what the namespace supports. This file adds the structural check that can.
 */

const statIDsOf = (sport: keyof typeof OU_PROP_MARKETS) =>
  OU_PROP_MARKETS[sport].map((m) => m.statID);
const labelOf = (sport: keyof typeof OU_PROP_MARKETS, statID: string) =>
  OU_PROP_MARKETS[sport].find((m) => m.statID === statID)?.label;

describe("v2.10.9 the shared basketball namespace is actually shared", () => {
  test("the four statIDs cbb carried and wnba did not are now in wnba", () => {
    for (const id of [
      "fieldGoalsAttempted",
      "minutesPlayed",
      "offensiveRebounds",
      "threePointersAttempted",
    ]) {
      assert.ok(statIDsOf("wnba").includes(id), `wnba missing ${id}`);
    }
  });

  /* THE GUARD, not just the fix. marketCatalog.ts asserts in prose that SGO has one
   * basketball stat namespace. Nothing enforced it, which is exactly how the two blocks
   * drifted by four markets without anyone noticing. This test fails on the next
   * one-sided addition to either block. */
  test("wnba and cbb hold byte-identical statID sets in both directions", () => {
    const w = new Set(statIDsOf("wnba"));
    const c = new Set(statIDsOf("cbb"));
    const onlyW = [...w].filter((id) => !c.has(id)).sort();
    const onlyC = [...c].filter((id) => !w.has(id)).sort();
    assert.deepEqual(onlyW, [], `in wnba but not cbb: ${onlyW.join(", ")}`);
    assert.deepEqual(onlyC, [], `in cbb but not wnba: ${onlyC.join(", ")}`);
  });

  test("and identical labels per statID, since tkb_grade_pick matches on the label", () => {
    for (const id of statIDsOf("wnba")) {
      assert.equal(
        labelOf("wnba", id),
        labelOf("cbb", id),
        `label mismatch for ${id}: wnba ${labelOf("wnba", id)} vs cbb ${labelOf("cbb", id)}`
      );
    }
  });

  test("the added labels do not collide with a label already in the block", () => {
    const labels = OU_PROP_MARKETS.wnba.map((m) => m.label);
    assert.equal(new Set(labels).size, labels.length, "duplicate label in wnba block");
    // `points` is deliberately labelled "Score", not "Points", across the basketball
    // blocks. An addition that reintroduced "Points" would be gradeable-ambiguous.
    assert.ok(!labels.includes("Points"), "wnba must not carry a bare Points label");
  });

  test("wnba count is 20, matching cbb", () => {
    assert.equal(OU_PROP_MARKETS.wnba.length, 20);
    assert.equal(OU_PROP_MARKETS.cbb.length, 20);
  });
});

// ---------------------------------------------------------------------------
// The coverage denominator now reconciles.
// ---------------------------------------------------------------------------

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

const PID = "AJA_WILSON_1_WNBA";
const priced = (odds: string, ou: string) => ({
  byBookmaker: { draftkings: { odds, overUnder: ou, available: true } },
});

/* Every drop path exactly once, so each counter is independently falsifiable and the
 * reconciliation arithmetic has a non-trivial value in every term. */
const EVENT = {
  eventID: "9KXRNj7tgOMn8RAjciee",
  type: "match",
  status: { started: false, startsAt: "2026-09-30T00:00:00.000Z" },
  teams: {
    home: { teamID: "INDIANA_FEVER_WNBA", names: { long: "Indiana Fever" } },
    away: { teamID: "LAS_VEGAS_ACES_WNBA", names: { long: "Las Vegas Aces" } },
  },
  players: { [PID]: { playerID: PID, name: "A'ja Wilson", teamID: "LAS_VEGAS_ACES_WNBA" } },
  odds: {
    // 2 accepted sides -> 1 row.
    [`points-${PID}-game-ou-over`]: priced("-110", "22.5"),
    [`points-${PID}-game-ou-under`]: priced("-110", "22.5"),
    // notOverUnder: betType is not ou.
    [`doubleDouble-${PID}-game-yn-yes`]: priced("+120", ""),
    // nonOverUnderSide: betType IS ou, side is not over/under. THE v2.10.9 BUCKET.
    [`rebounds-${PID}-game-ou-yes`]: priced("-120", "9.5"),
    // nonGamePeriod.
    [`points-${PID}-1h-ou-over`]: priced("-105", "11.5"),
    // notInCatalog.
    [`defensiveRebounds-${PID}-game-ou-over`]: priced("+100", "6.5"),
    // teamOrUnknownEntity.
    ["points-home-game-ou-over"]: priced("-110", "84.5"),
    // noBookPrice: fair odds only, no bookmaker.
    [`steals-${PID}-game-ou-over`]: { fairOdds: "-140", fairOverUnder: "1.5" },
    // unparsableOddID.
    ["not-an-odd-id"]: priced("-110", "1.5"),
  },
};

const callBoard = async (extra: Record<string, unknown> = {}) => {
  const sgo = {
    leagueIDFor: () => "WNBA",
    getAllEvents: async () => [EVENT],
  } as never;
  const { registerPropBoardTool } = await import("../src/tools/propBoard.js");
  const { server, handlers } = captureServer();
  registerPropBoardTool(server as never, sgo);
  const res = (await handlers["tkb_get_prop_board"]({
    sport: "wnba",
    eventID: "9KXRNj7tgOMn8RAjciee",
    preferredBookmakers: "draftkings",
    includeUnpriced: false,
    includeAllBooks: false,
    includeAltLines: false,
    ...extra,
  } as never)) as { structuredContent?: Record<string, unknown> };
  return res.structuredContent!.coverage as {
    seenOdds: number;
    unaccounted: number;
    unparsableOddID: number;
    note: string;
    otherBetTypes: { count: number; betTypesSeen: Record<string, number> };
    overUnder: {
      sidesAccepted: number;
      dropped: Record<string, number>;
      sidesNotOverUnder: Record<string, number>;
    };
    yesNo: { sidesAccepted: number; rowsBuilt: number; dropped: Record<string, number> };
  };
};

describe("v2.10.9 every dropped odd is counted", () => {
  test("unaccounted is zero, which is the whole point", async () => {
    const cov = await callBoard();
    assert.equal(cov.unaccounted, 0, JSON.stringify(cov, null, 2));
  });

  test("the terms sum to seenOdds independently of the unaccounted field", async () => {
    const cov = await callBoard();
    const summed =
      cov.overUnder.sidesAccepted +
      cov.yesNo.sidesAccepted +
      cov.unparsableOddID +
      cov.otherBetTypes.count +
      Object.values(cov.overUnder.dropped).reduce((a, b) => a + b, 0) +
      Object.values(cov.yesNo.dropped).reduce((a, b) => a + b, 0);
    assert.equal(summed, cov.seenOdds);
  });

  /* THE MUTATION. Before v2.10.9 the ou-market-with-a-yes-side odd fell through an
   * uncounted `continue`. If the counter is removed, this bucket goes to 0 and the
   * reconciliation above breaks by exactly 1. */
  test("an ou market carrying a yes side lands in nonOverUnderSide, not nowhere", async () => {
    const cov = await callBoard();
    assert.equal(cov.overUnder.dropped.nonOverUnderSide, 1);
    assert.deepEqual(cov.overUnder.sidesNotOverUnder, { yes: 1 });
  });

  /* RESHAPED FOR v2.11.0. The fixture's doubleDouble yes/no odd used to land in
   * `dropped.notOverUnder`. It is now COLLECTED into the yes/no section, so the point
   * of the test survives: the ou-market-with-a-yes-side is still a distinct thing from
   * a genuine yes/no market, and the two must not be confused. */
  test("a real yes/no market is collected, distinct from the ou-with-a-yes-side", async () => {
    const cov = await callBoard();
    assert.equal(cov.yesNo.sidesAccepted, 1);
    assert.equal(cov.yesNo.rowsBuilt, 1);
    assert.equal(cov.overUnder.dropped.nonOverUnderSide, 1);
  });

  test("the other new buckets are populated too", async () => {
    const cov = await callBoard();
    assert.equal(cov.overUnder.dropped.noBookPrice, 1);
    assert.equal(cov.overUnder.dropped.unparsableLine, 0);
    assert.equal(cov.overUnder.dropped.cancelled, 0);
  });

  test("the note explains the new bucket rather than leaving a bare number", async () => {
    const cov = await callBoard();
    assert.match(cov.note, /nonOverUnderSide/);
  });

  test("the accepted sides still became a row", async () => {
    const cov = await callBoard();
    assert.equal(cov.overUnder.sidesAccepted, 2);
  });
});
