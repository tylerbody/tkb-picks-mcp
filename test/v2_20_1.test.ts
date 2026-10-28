import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { summarizeSeasons, currentSeason } from "../src/services/seasonBoundary.js";
import { registerScreenSlateTool } from "../src/tools/screenSlate.js";
import { registerRankingsTool } from "../src/tools/rankings.js";
import { registerSplitsTool } from "../src/tools/splits.js";
import { registerStandingsTool } from "../src/tools/standings.js";
import { createUnavailableBDLClient } from "../src/services/bdlUnavailable.js";

/**
 * v2.20.1: three defects found testing v2.20.0 live on 2026-10-28.
 */

describe("season warning names PRIOR seasons only", () => {
  const thisSeason = currentSeason("nba").seasonYear;
  const now = new Date().toISOString();
  const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();

  test("a mixed sample's parenthetical never lists the current season", () => {
    const s = summarizeSeasons("nba", [now, now, longAgo]);
    assert.ok(s.warning, "a mixed sample warns");
    const paren = /prior season\(s\) \(([^)]*)\)/.exec(s.warning!)![1]!;
    assert.ok(!paren.split(", ").includes(String(thisSeason)), `"${paren}" lists the current season ${thisSeason}`);
    assert.ok(paren.length > 0);
  });

  test("an all-prior sample's parenthetical never lists the current season either", () => {
    const s = summarizeSeasons("nba", [longAgo]);
    const paren = /PRIOR season \(([^)]*)\)/.exec(s.warning!)![1]!;
    assert.ok(!paren.split(", ").includes(String(thisSeason)));
  });
});

const capture = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[]; structuredContent?: any }>> = {};
  const defs: Record<string, { description?: string; inputSchema?: any }> = {};
  return {
    server: {
      registerTool: (n: string, d: any, h: never) => {
        handlers[n] = h as never;
        defs[n] = d;
      },
    } as never,
    handlers,
    defs,
  };
};
const BDL_OFF = createUnavailableBDLClient();

describe("slate screen: zero priced markets is labelled, not 'screened 0 of 0'", () => {
  test("players attached but nothing priced -> no_props_priced", async () => {
    const ev = {
      eventID: "G1",
      status: { started: false, completed: false, startsAt: "2026-10-29T00:00:00.000Z" },
      teams: { home: { teamID: "CHICAGO_BULLS_NBA", names: { long: "Chicago Bulls" } }, away: { teamID: "NEW_YORK_KNICKS_NBA", names: { long: "New York Knicks" } } },
      players: { JALEN_BRUNSON_1_NBA: { playerID: "JALEN_BRUNSON_1_NBA", name: "Jalen Brunson", teamID: "NEW_YORK_KNICKS_NBA" } },
      odds: {},
    };
    const sgo = { leagueIDFor: () => "NBA", getAllEvents: async () => [ev] } as never;
    const { server, handlers } = capture();
    registerScreenSlateTool(server, sgo, BDL_OFF, null, null, null);
    const r = await handlers["tkb_screen_slate"]({ sport: "nba", date: "2026-10-28", limit: 20, perGameLimit: 6, rankBy: "edge" } as never);
    assert.equal(r.structuredContent.perGame[0].status, "no_props_priced");
    assert.equal(r.structuredContent.gamesScreened, 0);
    assert.match(r.content[0]!.text, /NO PROPS PRICED AT YOUR BOOKS YET/);
    assert.doesNotMatch(r.content[0]!.text, /0 of 0 qualified/);
  });
});

describe("tool descriptions match the v2.20.0 sources (scheduled runs read these)", () => {
  test("rankings and team split no longer claim BALLDONTLIE as their source", () => {
    const { server, defs } = capture();
    registerRankingsTool(server, BDL_OFF, null);
    registerSplitsTool(server, {} as never, BDL_OFF, null);
    assert.doesNotMatch(defs["tkb_get_rankings"]!.description!, /BALLDONTLIE does/);
    assert.match(defs["tkb_get_rankings"]!.description!, /ESPN/);
    assert.doesNotMatch(defs["tkb_get_team_split"]!.description!, /come from BALLDONTLIE standings/);
    assert.match(defs["tkb_get_team_split"]!.description!, /ESPN standings/);
  });

  test("standings `conference` no longer says REQUIRED for cfb", () => {
    const { server, defs } = capture();
    registerStandingsTool(server, BDL_OFF, null, null);
    const schema = defs["tkb_get_standings"]!.inputSchema;
    const conf = schema.shape.conference.description as string;
    assert.doesNotMatch(conf, /REQUIRED for cfb/);
    assert.match(conf, /OR a teamName/);
  });
});
