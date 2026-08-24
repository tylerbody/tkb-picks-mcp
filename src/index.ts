import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SUPPORTED_SPORTS } from "./constants.js";
import { SGOClient } from "./services/sgoClient.js";
import { BDLClient } from "./services/bdlClient.js";
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
import { registerGradePicksTool } from "./tools/gradePicks.js";
import { registerScreenPropsTool } from "./tools/screenProps.js";
import { registerCoverPlayerTool } from "./tools/coverPlayer.js";
import { registerTweetCharsTool } from "./tools/tweetChars.js";
import { registerBdlStatsProbeTool } from "./tools/bdlStatsProbe.js";
import { registerBatchGradeTool } from "./tools/gradeSlate.js";
import { registerStreakScanTool } from "./tools/streakScan.js";
import { registerLineMovementTool } from "./tools/lineMovement.js";
import { registerLiveMonitorTool } from "./tools/liveMonitor.js";

// ---- Environment / config ----

const SGO_API_KEY = process.env.SGO_API_KEY;
const BDL_API_KEY = process.env.BDL_API_KEY;
const PORT = parseInt(process.env.PORT || "3000");

if (!SGO_API_KEY) {
  console.error("FATAL: SGO_API_KEY environment variable is not set.");
  process.exit(1);
}
if (!BDL_API_KEY) {
  console.error("FATAL: BDL_API_KEY environment variable is not set.");
  process.exit(1);
}

// ---- Build shared API clients (one instance each, reused across all tool calls) ----

const sgo = new SGOClient(SGO_API_KEY);
const bdl = new BDLClient(BDL_API_KEY);
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
const SERVER_VERSION = "2.6.0";

function buildServer(): McpServer {
  const server = new McpServer({
    name: "tkb-picks-mcp-server",
    version: SERVER_VERSION,
  });

  registerScheduleTool(server, sgo);
  registerOddsTool(server, sgo);
  registerHitRateTool(server, sgo, bdl);
  registerInjuriesTool(server, bdl);
  registerSplitsTool(server, sgo, bdl);
  registerYesNoPropsTool(server, sgo);
  registerPeriodOddsTool(server, sgo);
  registerWeatherTool(server, weather);
  registerPlayersTool(server, sgo);
  registerUsageTool(server, sgo);
  registerGradePicksTool(server, sgo);
  registerScreenPropsTool(server, sgo, bdl);
  registerCoverPlayerTool(server, sgo, bdl);
  registerTweetCharsTool(server);
  registerBdlStatsProbeTool(server, bdl);
  registerBatchGradeTool(server, sgo);
  registerStreakScanTool(server, bdl);
  registerLineMovementTool(server, sgo);
  registerLiveMonitorTool(server, sgo);

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
