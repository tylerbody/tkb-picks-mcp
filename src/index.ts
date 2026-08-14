import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

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

function buildServer(): McpServer {
  const server = new McpServer({
    name: "tkb-picks-mcp-server",
    version: "2.2.0",
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "tkb-picks-mcp-server", version: "2.2.0" });
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
