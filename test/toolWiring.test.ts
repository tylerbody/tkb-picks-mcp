import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { registerOddsTool } from "../src/tools/odds.js";
import { registerLineMovementTool } from "../src/tools/lineMovement.js";
import { registerGradePicksTool } from "../src/tools/gradePicks.js";
import { registerBatchGradeTool } from "../src/tools/gradeSlate.js";
import { DEFAULT_BOOKMAKERS } from "../src/constants.js";

/**
 * TOOL WIRING, NOT TOOL LOGIC.
 *
 * ============================================================================
 * WHY THIS FILE HAD TO EXIST
 * ============================================================================
 *
 * v2.8.9 added `diagnosePlayerIdMiss` with nine passing unit tests, wired it into
 * four tools, and shipped. Three of the four worked. In `odds.ts` the call was
 * placed as the else-branch of `unpricedReasons.length`, and that branch never
 * runs on the case it was built for: a missing market populates one unpricedReason
 * PER SIDE, so the list is always non-empty and the diagnosis was unreachable.
 *
 * It was verified dead against the live build, on the exact Caleb Williams lookup
 * the release existed to answer. Every unit test still passed, because the pure
 * function was fine. The wiring was not, and nothing in the suite could see it.
 *
 * That is the same failure the repo has recorded in a different costume: v2.6.1
 * ("a cost change that alters which data comes back is a correctness change and
 * needs a test"), v2.8.4 ("none ship here, since searchPlayers needs an HTTP
 * client"). The gap was always "logic that needs a client cannot be asserted", and
 * the answer has been to extract the pure part and leave the wiring untested.
 *
 * EXTRACTING THE PURE PART IS NOT ENOUGH. A perfect function called in an
 * unreachable branch produces exactly the bug it was written to prevent.
 *
 * ============================================================================
 * THE PATTERN
 * ============================================================================
 *
 * A tool's `register*` function takes an McpServer and a client. Both are just
 * objects. Pass a fake server that captures the handler, a fake client that
 * returns a fixed event, then call the handler and assert on what a caller would
 * actually receive. No network, no SDK, no mocking framework.
 *
 * This costs almost nothing and covers the seam every previous release left bare.
 */

const captureServer = () => {
  const handlers: Record<string, (p: never) => Promise<{ content: { text: string }[] }>> = {};
  return {
    server: { registerTool: (n: string, _d: unknown, h: never) => { handlers[n] = h as never; } },
    handlers,
  };
};

// The real Bears @ Panthers roster, 2026-09-13. SGO carries Caleb Williams under
// CHRIS_WILLIAMS_1_NFL: right display name, wrong ID stem, line posted at 229.5.
const EVENT = {
  eventID: "Nw0i5lD1IafZ0HlX842y",
  status: { displayShort: "F", started: true, completed: true, ended: true, live: false },
  teams: {
    home: { teamID: "CAROLINA_PANTHERS_NFL", names: { long: "Carolina Panthers" }, score: 17 },
    away: { teamID: "CHICAGO_BEARS_NFL", names: { long: "Chicago Bears" }, score: 24 },
  },
  players: {
    CHRIS_WILLIAMS_1_NFL: {
      playerID: "CHRIS_WILLIAMS_1_NFL",
      name: "Caleb Williams",
      teamID: "CHICAGO_BEARS_NFL",
    },
  },
  odds: {
    "passing_yards-CHRIS_WILLIAMS_1_NFL-game-ou-over": {
      oddID: "passing_yards-CHRIS_WILLIAMS_1_NFL-game-ou-over",
      statID: "passing_yards",
      score: 241,
      byBookmaker: { draftkings: { odds: "-112", overUnder: "229.5", available: true } },
    },
  },
};

const fakeSgo = {
  leagueIDFor: () => "NFL",
  getAllEvents: async () => [EVENT],
  getEvents: async () => ({ data: [EVENT] }),
} as never;

const WRONG_ID = "CALEB_WILLIAMS_1_NFL";

/**
 * Calling a handler directly bypasses Zod, so schema defaults are NOT applied.
 * Supplying them here is deliberate rather than a workaround: it keeps the test
 * honest about which values the tool actually depends on, and a default that
 * silently disappears in this harness would be a default the tool should not be
 * relying on so deeply. preferredBookmakers is the one that bites - odds.ts and
 * lineMovement.ts both call .trim() on it unconditionally.
 */
const SCHEMA_DEFAULTS = { preferredBookmakers: DEFAULT_BOOKMAKERS };

describe("a wrong playerID is diagnosed by EVERY tool that can miss on one", () => {
  test("tkb_get_odds names the real ID - THE REGRESSION, it was unreachable in v2.8.9", () => {
    const { server, handlers } = captureServer();
    registerOddsTool(server as never, fakeSgo);
    return handlers["tkb_get_odds"]({
      sport: "nfl",
      eventID: "E",
      marketType: "player_prop",
      playerID: WRONG_ID,
      marketLabel: "Passing Yards",
      ...SCHEMA_DEFAULTS,
    } as never).then((r) => {
      const text = r.content[0].text;
      assert.match(text, /CHRIS_WILLIAMS_1_NFL/, "must name the real playerID");
      assert.match(text, /Caleb Williams/, "must name the display name");
      assert.match(text, /WRONG ID/);
    });
  });

  test("tkb_get_line_movement names the real ID", () => {
    const { server, handlers } = captureServer();
    registerLineMovementTool(server as never, fakeSgo);
    return handlers["tkb_get_line_movement"]({
      sport: "nfl",
      eventID: "E",
      marketType: "player_prop",
      playerID: WRONG_ID,
      marketLabel: "Passing Yards",
      side: "over",
      ...SCHEMA_DEFAULTS,
    } as never).then((r) => {
      assert.match(r.content[0].text, /CHRIS_WILLIAMS_1_NFL/);
    });
  });

  test("tkb_grade_pick names the real ID", () => {
    const { server, handlers } = captureServer();
    registerGradePicksTool(server as never, fakeSgo);
    return handlers["tkb_grade_pick"]({
      sport: "nfl",
      eventID: "E",
      marketType: "player_prop",
      side: "over",
      playerID: WRONG_ID,
      marketLabel: "Passing Yards",
      postedLine: 229.5,
    } as never).then((r) => {
      assert.match(r.content[0].text, /CHRIS_WILLIAMS_1_NFL/);
    });
  });

  test("tkb_grade_slate names the real ID", () => {
    const { server, handlers } = captureServer();
    registerBatchGradeTool(server as never, fakeSgo);
    return handlers["tkb_grade_slate"]({
      sport: "nfl",
      picks: [
        {
          ref: "wrong id",
          eventID: "E",
          marketType: "player_prop",
          side: "over",
          playerID: WRONG_ID,
          marketLabel: "Passing Yards",
          postedLine: 229.5,
        },
      ],
    } as never).then((r) => {
      assert.match(r.content[0].text, /CHRIS_WILLIAMS_1_NFL/);
    });
  });
});

describe("the control: a CORRECT playerID is untouched by the diagnosis path", () => {
  test("tkb_get_odds still returns the real line", () => {
    // The failure mode of an over-eager diagnosis is intercepting successful
    // lookups, which would block every prop pull rather than one.
    const { server, handlers } = captureServer();
    registerOddsTool(server as never, fakeSgo);
    return handlers["tkb_get_odds"]({
      sport: "nfl",
      eventID: "E",
      marketType: "player_prop",
      playerID: "CHRIS_WILLIAMS_1_NFL",
      marketLabel: "Passing Yards",
      ...SCHEMA_DEFAULTS,
    } as never).then((r) => {
      const text = r.content[0].text;
      assert.match(text, /229\.5/, "the real line must still come back");
      assert.doesNotMatch(text, /WRONG ID/, "a successful lookup must not be diagnosed");
      assert.doesNotMatch(text, /NO USABLE ODDS/);
    });
  });
});
