#!/usr/bin/env node
/**
 * DEPLOY VERIFICATION
 *
 * WHY THIS IS A SCRIPT AND NOT A CHECKLIST. DEPLOY-CHECK.md describes a six-step
 * manual routine, and the pattern across releases has been: deploy, assume it
 * worked, discover something later. Three separate times the thing discovered
 * later was that /health was reporting a stale version, which cost a full
 * debugging cycle on its own.
 *
 * More importantly this measures ENTITY COST, which is the number that has
 * silently regressed twice (v2.2.0 expected ~100 and got 1,195; v2.5.x
 * over-fetching went unnoticed for four releases). Reading a before/after delta
 * at deploy time is the difference between catching a cost regression in thirty
 * seconds and catching it at the quota wall mid-slate.
 *
 * USAGE
 *   node scripts/verify-deploy.mjs
 *   node scripts/verify-deploy.mjs --url https://tkb-picks-mcp.onrender.com
 *   node scripts/verify-deploy.mjs --screen <mlbEventID>   # also measures a screen
 *
 * Exits non-zero if anything fails, so it can gate a deploy.
 */

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = argVal("--url", "https://tkb-picks-mcp.onrender.com").replace(/\/$/, "");
const SCREEN_EVENT = argVal("--screen", null);
const EXPECTED_VERSION = argVal("--expect", null);

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const info = (m) => console.log(`        ${m}`);
const head = (m) => console.log(`\n${m}\n${"-".repeat(m.length)}`);

/** Minimal JSON-RPC over the streamable HTTP transport. */
let rpcID = 0;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcID, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  // The transport may answer as SSE even with JSON responses enabled.
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("")
    : text;
  const parsed = JSON.parse(payload);
  if (parsed.error) throw new Error(`RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

async function callTool(name, toolArgs = {}) {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tkb-verify-deploy", version: "1" },
  });
  const result = await rpc("tools/call", { name, arguments: toolArgs });
  return (result?.content ?? []).map((c) => c.text ?? "").join("\n");
}

/** Pull monthly entity consumption out of the usage tool's text output. */
function parseMonthlyEntities(text) {
  const m = text.match(/"per-month"\s*:\s*\{[^}]*"current-entities"\s*:\s*(\d+)/s);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
head(`Verifying ${BASE}`);

let health;
try {
  const res = await fetch(`${BASE}/health`);
  health = await res.json();
  ok(`/health responded (${res.status})`);
} catch (err) {
  bad(`/health unreachable: ${err.message}`);
  console.log("\nThe service is down or still deploying. Nothing else can be checked.");
  process.exit(1);
}

info(`version:   ${health.version}`);
info(`tools:     ${health.toolCount ?? "not reported"}`);
info(`sports:    ${(health.sports ?? []).join(", ") || "not reported"}`);

if (EXPECTED_VERSION) {
  if (health.version === EXPECTED_VERSION) ok(`version is ${EXPECTED_VERSION}`);
  else bad(`expected version ${EXPECTED_VERSION}, got ${health.version}`);
}

/**
 * THE POINT OF REPORTING sports AND tools. A version string is a claim about the
 * build; these are consequences of it. If the version looks stale but `sports`
 * contains atp, the code IS new and only the constant was forgotten - which is
 * exactly the ambiguity that cost a debugging cycle in v2.5.3.
 */
if (health.toolCount === 0 || health.toolIntrospectionError) {
  bad(`tool introspection failed: ${health.toolIntrospectionError ?? "zero tools"}`);
} else {
  ok(`${health.toolCount} tools registered`);
}

head("Tool listing");
try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tkb-verify-deploy", version: "1" },
  });
  const list = await rpc("tools/list", {});
  const names = (list?.tools ?? []).map((t) => t.name).sort();
  ok(`tools/list returned ${names.length}`);
  if (health.toolCount && names.length !== health.toolCount) {
    bad(`/health says ${health.toolCount} but tools/list says ${names.length}`);
  }
  const missing = ["tkb_get_schedule", "tkb_get_odds", "tkb_get_api_usage"]
    .filter((n) => !names.includes(n));
  if (missing.length) bad(`core tools missing: ${missing.join(", ")}`);
  else ok("core tools present");
} catch (err) {
  bad(`tools/list failed: ${err.message}`);
}

head("Quota baseline");
let before = null;
try {
  const text = await callTool("tkb_get_api_usage", {});
  before = parseMonthlyEntities(text);
  if (before === null) bad("could not parse monthly entity count from usage output");
  else ok(`monthly entities so far: ${before.toLocaleString()}`);
  const cacheLine = text.split("\n").find((l) => l.includes("Team-history cache"));
  if (cacheLine) info(cacheLine.trim());
} catch (err) {
  bad(`tkb_get_api_usage failed: ${err.message}`);
}

head("Tennis wiring");
try {
  const text = await callTool("tkb_get_player_hit_rate", {
    sport: "atp", teamID: "x", playerID: "x", playerName: "x",
    statID: "points", line: 0.5, direction: "over",
  });
  if (/not available for ATP/i.test(text)) {
    ok("tennis correctly REFUSES hit rates with an explanation");
  } else {
    bad("tennis hit rate did not return the capability refusal");
    info(text.slice(0, 200));
  }
} catch (err) {
  bad(`tennis capability guard check failed: ${err.message}`);
}

if (SCREEN_EVENT) {
  head("Entity cost of one screen");
  info("This is the number that has regressed silently twice. Target is roughly");
  info("60-150 entities for one MLB game. Anything near 1,000 means rates are");
  info("falling back to SportsGameOdds - read the routing line to find out why.");
  try {
    const screenText = await callTool("tkb_screen_props", {
      sport: "mlb",
      eventID: SCREEN_EVENT,
      preferredBookmakers: "draftkings,fanduel,betmgm,caesars",
    });
    const routing = screenText.split("\n").find((l) => l.includes("Rate sources:"));
    if (routing) info(routing.trim());

    const after = parseMonthlyEntities(await callTool("tkb_get_api_usage", {}));
    if (before !== null && after !== null) {
      const delta = after - before;
      info(`entity delta: ${delta}`);
      if (delta > 400) bad(`screen cost ${delta} entities - expected well under 400`);
      else ok(`screen cost ${delta} entities`);
    }
  } catch (err) {
    bad(`screen failed: ${err.message}`);
  }
} else {
  head("Entity cost of one screen");
  info("Skipped. Re-run with --screen <mlbEventID> to measure it.");
}

head(failures === 0 ? "All checks passed" : `${failures} check(s) FAILED`);
if (failures === 0) {
  console.log("Safe to run the nightly tasks against this build.\n");
}
process.exit(failures === 0 ? 0 : 1);
