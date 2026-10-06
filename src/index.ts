import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SUPPORTED_SPORTS } from "./constants.js";
import { SGOClient } from "./services/sgoClient.js";
import { BDLClient } from "./services/bdlClient.js";
import { CFBDClient } from "./services/cfbdClient.js";
import { CBBDClient } from "./services/cbbdClient.js";
import { MLBStatsClient } from "./services/mlbStatsClient.js";
import { NHLStatsClient } from "./services/nhlStatsClient.js";
import { WeatherClient } from "./services/weatherClient.js";
import { registerScheduleTool } from "./tools/schedule.js";
import { registerOddsTool } from "./tools/odds.js";
import { registerHitRateTool } from "./tools/hitRate.js";
import { registerInjuriesTool } from "./tools/injuries.js";
import { registerSplitsTool } from "./tools/splits.js";
import { registerYesNoPropsTool } from "./tools/yesNoProps.js";
import { registerPeriodOddsTool } from "./tools/periodOdds.js";
import { registerWeatherTool } from "./tools/weather.js";
import { registerPlayersTool } from "./tools/players.js";
import { registerUsageTool } from "./tools/usage.js";
import { registerLeagueAccessTool } from "./tools/leagueAccess.js";
import { registerGradePicksTool } from "./tools/gradePicks.js";
import { registerScreenPropsTool } from "./tools/screenProps.js";
import { registerCoverPlayerTool } from "./tools/coverPlayer.js";
import { registerTweetCharsTool } from "./tools/tweetChars.js";
import { registerBdlStatsProbeTool } from "./tools/bdlStatsProbe.js";
import { registerBatchGradeTool } from "./tools/gradeSlate.js";
import { registerStreakScanTool } from "./tools/streakScan.js";
import { registerLineMovementTool } from "./tools/lineMovement.js";
import { registerLiveMonitorTool } from "./tools/liveMonitor.js";
import { registerPropBoardTool } from "./tools/propBoard.js";
import { registerGameLinesTool } from "./tools/gameLines.js";
import { registerRankingsTool } from "./tools/rankings.js";
import { registerStandingsTool } from "./tools/standings.js";
import { registerEventProbeTool } from "./tools/eventProbe.js";
import { registerEspnProbeTool } from "./tools/espnProbe.js";
import { registerDevigTool } from "./tools/devig.js";
import { registerCfbdStatsProbeTool } from "./tools/cfbdStatsProbe.js";
import { registerMlbMatchupTool } from "./tools/mlbMatchup.js";
import { registerVerifyRosterTool } from "./tools/verifyRoster.js";
import { registerDebugEventTool } from "./tools/debugEvent.js";
import { createUnavailableBDLClient, isBdlConfigured } from "./services/bdlUnavailable.js";
import { EspnClient } from "./services/espnClient.js";

// ---- Environment / config ----

const SGO_API_KEY = process.env.SGO_API_KEY;
const BDL_API_KEY = process.env.BDL_API_KEY;
const PORT = parseInt(process.env.PORT || "3000");

if (!SGO_API_KEY) {
  console.error("FATAL: SGO_API_KEY environment variable is not set.");
  process.exit(1);
}

// ---- Build shared API clients (one instance each, reused across all tool calls) ----

const sgo = new SGOClient(SGO_API_KEY);

/**
 * BALLDONTLIE IS OPTIONAL AS OF v2.16.0. IT USED TO BE FATAL.
 *
 * The guard that stood here was `if (!BDL_API_KEY) process.exit(1)`, which took all
 * 31 tools down over a key that six of them need - the exact mistake the CFBD comment
 * below warns about, made one screen earlier. Measured 2026-10-01: SGO serves every
 * hit rate, box score, line, prop and grade; BDL is the only source for just one
 * capability, the injury feed, plus standings, the CFB poll, streak scanning and roster
 * verification.
 *
 * WITH NO KEY the connector runs on SportsGameOdds and the BDL-backed tools refuse by
 * name rather than guessing. See services/bdlUnavailable.ts for why this is a Proxy
 * rather than a `BDLClient | null` threaded through twelve signatures.
 *
 * SWAPPING BACK IS SETTING BDL_API_KEY IN RENDER. No code change: the client, the
 * aggregators and every BDL route still ship intact.
 */
const bdl = BDL_API_KEY ? new BDLClient(BDL_API_KEY) : createUnavailableBDLClient();

/**
 * CFBD IS OPTIONAL, UNLIKE SGO AND BDL, AND THE SERVER MUST STILL BOOT WITHOUT IT.
 *
 * Exiting here would take all 24 existing tools down over a key that only CFB hit
 * rates need. The CFB path instead returns a clear refusal naming the missing key
 * (see tools/hitRate.ts), which is the same rule the capability flags follow: an
 * unanswerable question gets a refusal, never a plausible answer.
 *
 * Set CFBD_API_KEY in the Render environment alongside SGO_API_KEY and BDL_API_KEY.
 * Free tier: collegefootballdata.com/key
 */
const CFBD_API_KEY = process.env.CFBD_API_KEY;
const cfbd = CFBD_API_KEY ? new CFBDClient(CFBD_API_KEY) : null;

/**
 * CBBD IS OPTIONAL FOR THE SAME REASON CFBD IS, and is a SEPARATE KEY.
 *
 * It is not the CFBD key under another name: CollegeBasketballData issues its own,
 * free at collegebasketballdata.com/key. What the two DO share is the monthly call
 * quota, which is tied to the account rather than to the sport - so November and
 * early December, when both seasons overlap, is the one stretch where CFB usage can
 * exhaust CBB.
 *
 * Without it, CBB hit rates refuse rather than falling back to a source that cannot
 * answer. Every other CBB tool works normally.
 */
const CBBD_API_KEY = process.env.CBBD_API_KEY;
const cbbd = CBBD_API_KEY ? new CBBDClient(CBBD_API_KEY) : null;

/**
 * NO KEY, SO NO CONDITIONAL. statsapi.mlb.com is unauthenticated and unmetered, so
 * unlike SGO, BDL and CFBD there is nothing to configure and nothing to gate on.
 * The tool fails soft at call time if the feed is unreachable.
 */
const mlbStats = new MLBStatsClient();

/**
 * SAME REASONING, FOR HOCKEY. api-web.nhle.com is unauthenticated and unmetered, so
 * there is nothing to configure and nothing to gate on.
 *
 * WORTH KNOWING WHAT THIS ONE CARRIES, because it is more load-bearing than the MLB
 * client: it is the sole source of NHL hit rates AND the second source that confirms
 * NHL finality when SGO's ingest lags. BALLDONTLIE cannot do either job on this
 * account - its tiers are per sport and hockey sits behind ALL-STAR for games and GOAT
 * for player stats - so there is no fallback behind it. If the league changes a shape,
 * NHL rates refuse and NHL grading loses its cross-check; nothing silently degrades.
 */
const nhlStats = new NHLStatsClient();
/**
 * ESPN, v2.17.0. No key, same as NHLStatsClient, so there is no configuration under
 * which it is absent and nothing to warn about at boot.
 *
 * ONE INSTANCE, SHARED, because it is now a PRIMARY rate source rather than a probe:
 * `auto` routes NBA, NFL, WNBA, EPL and UCL here. The probe keeps its own default
 * instance, which is fine - neither holds state worth sharing beyond the axios agent.
 */
const espn = new EspnClient();
if (!cfbd) {
  console.warn(
    "WARN: CFBD_API_KEY is not set. CFB hit rates will refuse rather than fall back " +
      "to SportsGameOdds, which carries no CFB player box scores outside the playoff. " +
      "Every other tool is unaffected."
  );
}
if (!cbbd) {
  console.warn(
    "WARN: CBBD_API_KEY is not set. College basketball hit rates will refuse rather " +
      "than fall back to SportsGameOdds or BALLDONTLIE, neither of which can serve " +
      "NCAAB player box scores on this account. It is a SEPARATE key from CFBD_API_KEY " +
      "(free at collegebasketballdata.com/key) on a SHARED monthly quota. Every other " +
      "tool is unaffected."
  );
}
if (!isBdlConfigured(bdl)) {
  console.warn(
    "WARN: BDL_API_KEY is not set. The connector is running on SportsGameOdds alone. " +
      "Unaffected: hit rates, box scores, odds, props, period odds, game lines, " +
      "schedules, grading, weather, ESPN research. " +
      "REFUSING BY NAME: tkb_get_injuries, tkb_get_standings, tkb_get_rankings, " +
      "tkb_scan_streaks, tkb_verify_roster, tkb_debug_bdl_stats, and " +
      'tkb_get_player_hit_rate with an explicit dataSource="bdl". ' +
      "THE INJURY FEED HAS NO SUBSTITUTE - SGO publishes none, so confirm availability " +
      "against the official injury report before posting a player prop. " +
      "Restore by setting BDL_API_KEY in Render; no code change is required."
  );
}
const weather = new WeatherClient(); // no API key needed - free public NWS API

// ---- Build MCP server and register tools ----

/**
 * SINGLE SOURCE OF TRUTH FOR THE VERSION.
 *
 * This was previously written out twice - once here and once in the /health
 * response - and on 2026-08-19 the two drifted: buildServer said 2.5.3 while
 * /health still said 2.5.2. Since /health is the ONLY way to tell which build is
 * live, a stale string there is worse than no version at all. It cost a full
 * debugging cycle chasing a deploy that had partly worked.
 *
 * DEPLOYCHECK.md already records the same class of failure from 2.0.1-2.0.3,
 * where /health reported 2.0.0 across three builds and testing was ambiguous.
 * One constant makes the drift impossible rather than merely unlikely.
 *
 * IT HAPPENED A THIRD TIME ANYWAY. The deployed repo still declared 2.5.3 after
 * the 2.5.4 changes shipped. The one-constant fix solved "two copies in one file
 * disagree"; it did not solve "someone has to remember to edit the constant",
 * which is the failure that actually keeps recurring.
 *
 * SO /health NOW CARRIES EVIDENCE, NOT JUST A CLAIM. The lesson recorded in
 * CHANGESv2.5.4.md is that a version string is an assertion ABOUT the build and
 * the authoritative test is behavioural. toolCount, tools and sports are all
 * derived from the running server at request time, so they cannot be stale
 * independently of the code. If the version says 2.5.3 but `sports` contains atp,
 * the build is new and only the string was forgotten - and that is now
 * diagnosable in one curl instead of a debugging cycle.
 */
const SERVER_VERSION = "2.18.0";

function buildServer(): McpServer {
  const server = new McpServer({
    name: "tkb-picks-mcp-server",
    version: SERVER_VERSION,
  });

  registerScheduleTool(server, sgo);
  registerOddsTool(server, sgo);
  registerHitRateTool(server, sgo, bdl, cfbd, cbbd, nhlStats, espn);
  registerInjuriesTool(server, bdl);
  registerSplitsTool(server, sgo, bdl);
  registerYesNoPropsTool(server, sgo);
  registerPeriodOddsTool(server, sgo);
  registerWeatherTool(server, weather);
  registerPlayersTool(server, sgo);
  registerUsageTool(server, sgo, cfbd, cbbd, nhlStats);
  registerLeagueAccessTool(server, sgo);
  registerGradePicksTool(server, sgo, bdl, nhlStats);
  registerScreenPropsTool(server, sgo, bdl, cfbd, cbbd);
  registerCoverPlayerTool(server, sgo, bdl);
  registerTweetCharsTool(server);
  registerBdlStatsProbeTool(server, bdl);
  registerBatchGradeTool(server, sgo, bdl, nhlStats);
  registerStreakScanTool(server, bdl);
  registerLineMovementTool(server, sgo);
  registerLiveMonitorTool(server, sgo);
  registerPropBoardTool(server, sgo);
  registerGameLinesTool(server, sgo);
  registerRankingsTool(server, bdl);
  registerStandingsTool(server, bdl);
  registerEventProbeTool(server, sgo);
  /* ESPN PROBE, v2.12.0. Registered with no client argument: EspnClient needs no key,
   * which is the entire point of it. Diagnostic only until the probe confirms Render can
   * reach ESPN and that the measured shape still holds. */
  registerEspnProbeTool(server, espn);
  /* DEVIG, v2.13.0. Pure arithmetic on prices the caller supplies, so no client and no
   * provider. Deliberately NOT wired into the prop board yet. */
  registerDevigTool(server);
  if (cfbd) registerCfbdStatsProbeTool(server, cfbd);
  registerMlbMatchupTool(server, mlbStats);
  registerVerifyRosterTool(server, bdl);
  /* RAW EVENT DUMP, registered v2.15.0 after sitting written-but-unreachable.
   *
   * WHY IT IS BEING TURNED ON RATHER THAN DELETED, measured 2026-10-01: two separate
   * items are blocked on ONE unknown, the value of the event's top-level `type` field.
   *
   *   1. PRESEASON CONTAMINATION. A live NFL hit rate (Josh Allen, 4 counted
   *      appearances) included the 15 Aug 2026 PRESEASON game as a real 111-yard
   *      sample, and its two preseason DNPs drove recentAvailability to playRate 0.67
   *      with flag IRREGULAR on a QB who has missed no regular-season game. The
   *      obvious filter does not work: info.seasonWeek reads "Week 1" for BOTH the
   *      15 Aug preseason game (ygBw5sEmEBR0sBPv7C4g) and the 13 Sep regular-season
   *      opener (J5HTln3CEGxm5DE8iDDD), and tkb_probe_event_fields shows `info` holds
   *      only venue and seasonWeek, so nothing else in there can discriminate.
   *
   *   2. FUTURES. tools/futures.ts is complete and unregistered for exactly one
   *      stated reason, and it names this tool as the fix: "the event `type` value
   *      used to identify futures is not yet confirmed ... the first thing to check
   *      via tkb_debug_raw_event".
   *
   * tkb_probe_event_fields reports `type` as a SHAPE ("type":"string") and never as a
   * VALUE, so it cannot answer either question. This tool dumps the raw object, which
   * can. Building a hardcoded season-start date table before reading `type` would be
   * assuming instead of measuring, and would ship an annual maintenance burden that
   * may turn out to be unnecessary.
   *
   * SCOPE: read-only, one event, no fallbacks, no derived numbers. It cannot feed a
   * published pick. Retire it once `type` is recorded in the docs and both items above
   * are closed. */
  registerDebugEventTool(server, sgo);

  return server;
}

// ---- HTTP transport (stateless - new transport per request, per MCP best practices) ----

const app = express();
app.use(express.json({ limit: "10mb" }));

/**
 * Tool names, read off a real server instance rather than a hand-maintained list.
 * A hardcoded array here would be one more thing to forget, which is the exact
 * problem /health exists to catch.
 */
function registeredToolNames(): string[] {
  const probe = buildServer() as unknown as {
    _registeredTools?: Record<string, unknown>;
  };
  return Object.keys(probe._registeredTools ?? {}).sort();
}

app.get("/health", (_req, res) => {
  let tools: string[] = [];
  let toolError: string | null = null;
  try {
    tools = registeredToolNames();
  } catch (err) {
    // Never let health-check introspection take the endpoint down. A /health that
    // 500s tells you nothing about whether the deploy worked.
    toolError = err instanceof Error ? err.message : String(err);
  }

  res.json({
    status: "ok",
    server: "tkb-picks-mcp-server",
    version: SERVER_VERSION,
    // Behavioural evidence. These change when the code changes; the version
    // string only changes when someone remembers to change it.
    toolCount: tools.length,
    tools,
    sports: SUPPORTED_SPORTS,
    ...(toolError ? { toolIntrospectionError: toolError } : {}),
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

app.listen(PORT, () => {
  console.log(`TKB Picks MCP server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
