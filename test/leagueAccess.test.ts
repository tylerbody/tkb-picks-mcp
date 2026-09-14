import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  emptyResultExplanation,
  leagueTierNote,
  probeLeagueReach,
  probeAllLeagues,
  type EventCounter,
} from "../src/services/leagueAccess.js";

/**
 * THE CASE THIS FILE EXISTS FOR, measured live on 2026-09-14:
 *
 *   tkb_get_schedule sport="atp"              -> "No ATP games found ..."
 *   tkb_get_schedule sport="atp" Sep 1-13     -> 81 events, the whole US Open
 *
 * One message, three possible causes, and it took a backwards probe into a past
 * window to find out which one it was. On an account that swaps between a rookie
 * key (17 leagues) and a pro key (53), one of those causes is a silent outage.
 */

const counter = (recent: number, upcoming: number): EventCounter => ({
  leagueIDFor: (s) => s.toUpperCase(),
  getAllEvents: async (p) => {
    const looksBackward = new Date(p.startsBefore ?? 0).getTime() <= Date.now() + 1000;
    return new Array(looksBackward ? recent : upcoming).fill({});
  },
});

describe("emptyResultExplanation - never one cause, never a guess", () => {
  test("names all three causes when nothing at all came back", () => {
    const msg = emptyResultExplanation({
      sport: "atp",
      windowDescription: "the next 2 days",
      fetchedBeforeFilters: 0,
    });
    assert.match(msg, /calendar really is empty/i);
    assert.match(msg, /not posted yet/i);
    assert.match(msg, /CANNOT SEE THIS LEAGUE/);
    assert.match(msg, /tkb_check_league_access/);
  });

  test("STATES THE FILTER CAUSE AS FACT when it is known for certain", () => {
    // If SGO returned events and our own filters removed them, that is not one
    // possibility among three - it is what happened, and hedging it would be worse.
    const msg = emptyResultExplanation({
      sport: "cfb",
      windowDescription: "Saturday",
      fetchedBeforeFilters: 47,
    });
    assert.match(msg, /47/);
    assert.match(msg, /FILTERS/);
    assert.doesNotMatch(msg, /CANNOT SEE THIS LEAGUE/);
  });

  test("carries the SGO leagueID so the reader can check it by hand", () => {
    assert.match(
      emptyResultExplanation({ sport: "cbb", windowDescription: "tonight" }),
      /NCAAB/
    );
    assert.match(
      emptyResultExplanation({ sport: "ucl", windowDescription: "tonight" }),
      /UEFA_CHAMPIONS_LEAGUE/
    );
  });
});

describe("leagueTierNote - the key-swap facts, stated without overclaiming", () => {
  test("free-tier leagues are named as such, because they survive every key", () => {
    assert.match(leagueTierNote("cbb"), /AMATEUR/);
    assert.match(leagueTierNote("ucl"), /AMATEUR/);
  });

  test("EPL is documented from rookie up", () => {
    assert.match(leagueTierNote("epl"), /ROOKIE/);
  });

  test("UFC is reported as UNLISTED and the note says so is unverified", () => {
    const note = leagueTierNote("ufc");
    assert.match(note, /not named in ANY plan/);
    assert.match(note, /UNVERIFIED/);
  });

  test("tennis carries the MEASURED result rather than a tier guess", () => {
    assert.match(leagueTierNote("atp"), /MEASURED WORKING/);
    assert.match(leagueTierNote("atp"), /81 events/);
  });
});

describe("probeLeagueReach", () => {
  test("EVENTS IN THE PAST PROVE REACHABILITY even with an empty forward window", () => {
    // Exactly the ATP case. This is the whole reason the probe looks backward.
    return probeLeagueReach(counter(81, 0), "atp").then((r) => {
      assert.equal(r.verdict, "reachable");
      assert.equal(r.recentEvents, 81);
      assert.equal(r.upcomingEvents, 0);
      assert.match(r.reading, /CALENDAR GAP/);
    });
  });

  test("events in both directions is plainly reachable", () =>
    probeLeagueReach(counter(30, 12), "wta").then((r) => {
      assert.equal(r.verdict, "reachable");
      assert.doesNotMatch(r.reading, /CALENDAR GAP/);
    }));

  test("nothing either way DOES NOT ASSERT an entitlement failure", async () => {
    const r = await probeLeagueReach(counter(0, 0), "ufc");
    assert.equal(r.verdict, "no_events_either_direction");
    // Out of season looks identical, and claiming otherwise would be the exact
    // confident wrong answer this is meant to prevent.
    assert.match(r.reading, /OUT OF SEASON/);
    assert.match(r.reading, /most likely/);
  });

  test("a probe that throws establishes NOTHING, and says so", async () => {
    const broken: EventCounter = {
      leagueIDFor: (s) => s.toUpperCase(),
      getAllEvents: async () => {
        throw new Error("upstream 502");
      },
    };
    const r = await probeLeagueReach(broken, "epl");
    assert.equal(r.verdict, "error");
    assert.match(r.reading, /nothing is established/i);
    assert.match(r.error ?? "", /502/);
  });

  test("passes oddIDs so SGO does not serialise every market into the probe", async () => {
    const seen: Record<string, unknown>[] = [];
    const spy: EventCounter = {
      leagueIDFor: (s) => s.toUpperCase(),
      getAllEvents: async (p) => {
        seen.push(p as Record<string, unknown>);
        return [];
      },
    };
    await probeLeagueReach(spy, "cbb");
    assert.equal(seen.length, 2, "exactly two windows, no more");
    for (const call of seen) assert.ok(call.oddIDs, "every probe call must narrow the response");
  });
});

describe("probeAllLeagues", () => {
  test("returns one row per requested sport", async () => {
    const rows = await probeAllLeagues(counter(1, 1), ["cbb", "epl", "ufc"]);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.sport), ["cbb", "epl", "ufc"]);
  });
});
