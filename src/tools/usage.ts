import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";

/**
 * API QUOTA MONITOR.
 *
 * WHY THIS EXISTS: SportsGameOdds bills per EVENT OBJECT returned, not per market.
 * That pricing model is very favourable when you fetch one game and read 200 markets
 * off it - and quietly expensive when a tool fetches many events to compute one number.
 *
 * Two paths in this connector do exactly that:
 *   - tkb_get_player_hit_rate pulls up to `lookback * 3` finalized events (30+ by
 *     default) and auto-paginates. One prop check can consume 30-90+ objects.
 *   - tkb_get_team_split's SGO fallback pulls up to 100 events per call.
 *
 * At 15-20 threads a day with two props each, plus splits and schedule calls, monthly
 * consumption can plausibly approach or exceed the Rookie plan's 100,000-object
 * allowance. Until this tool existed there was no way to see that from inside the
 * workflow - the first symptom would have been requests failing mid-slate.
 *
 * Run this at the start of a heavy build day, and any time responses start erroring.
 */
const UsageInputSchema = z.object({}).strict();

type UsageInput = z.infer<typeof UsageInputSchema>;

export function registerUsageTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_get_api_usage",
    {
      title: "Get SportsGameOdds API Usage",
      description: `Check current SportsGameOdds API quota and rate-limit usage for this account.

SGO bills per EVENT OBJECT returned, not per market - so one request that returns 50
events costs 50 objects even if only one number is read from them. Hit-rate checks and
the team-split fallback are the two heaviest consumers in this connector.

Args: none

Returns: raw usage data from SGO's /account/usage endpoint - typically requests per
minute, objects consumed per month, and remaining quota by interval.

Examples:
  - Use when: starting a heavy multi-sport build day and you want to know the headroom
  - Use when: requests start failing or returning rate-limit errors mid-slate
  - Use when: deciding whether the current plan tier still fits actual usage
  - Don't use when: you just need game data - this returns account metadata only

Error Handling:
  - Returns a clear message if the endpoint is unavailable on the current plan`,
      inputSchema: UsageInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_params: UsageInput) => {
      try {
        const usage = await sgo.getUsage();
        const cache = sgo.getCacheStats();
        const text = JSON.stringify(usage, null, 2);
        const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n...[truncated]" : text;

        const total = cache.hits + cache.misses;
        const cacheLine =
          total === 0
            ? `Team-history cache: no lookups yet this process.`
            : `Team-history cache: ${cache.hits} hit(s), ${cache.misses} miss(es), ` +
              `${cache.depthUpgrades} depth upgrade(s), ${cache.coalesced} coalesced ` +
              `in-flight duplicate(s) across ${cache.entries} cached team histories ` +
              `(TTL ${cache.ttlMinutes}m). Each hit is a team-history fetch avoided - ` +
              `roughly 30-140 entities saved depending on role depth. Each COALESCED ` +
              `is a concurrent duplicate collapsed into one request: before v2.6.0 ` +
              `three screener workers could miss the same not-yet-written cache key ` +
              `simultaneously and all three got billed.`;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `SportsGameOdds account usage:\n\n${truncated}\n\n${cacheLine}\n\n` +
                `Reminder: billing is per EVENT OBJECT returned, not per market. Hit-rate ` +
                `checks are the heaviest consumer in this connector, which is why identical ` +
                `team-history fetches are cached.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching API usage: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
