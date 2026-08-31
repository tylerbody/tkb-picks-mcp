import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { CFBDClient } from "../services/cfbdClient.js";

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

export function registerUsageTool(
  server: McpServer,
  sgo: SGOClient,
  cfbd: CFBDClient | null
) {
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

        // CFBD IS BUDGETED PER MONTH, NOT PER MINUTE, so an unnoticed miss loop
        // costs days rather than sixty seconds. That asymmetry is why this is
        // surfaced next to the SGO numbers rather than hidden in a debug tool.
        const cfbdLine = (() => {
          if (!cfbd) return `CollegeFootballData: not configured (CFBD_API_KEY unset).`;
          const c = cfbd.getStats();
          return (
            `CollegeFootballData: ${c.requests} request(s) THIS PROCESS ONLY, ${c.hits} cache ` +
            `hit(s), ${c.misses} miss(es), ${c.coalesced} coalesced, ${c.errors} error(s). ` +
            `${c.cachedWeeks} week(s) cached, ${c.permanentWeeks} of them permanent.\n\n` +
            `READ THAT COUNTER CAREFULLY - IT IS NOT YOUR MONTHLY TOTAL. It is in-memory and ` +
            `resets on every restart, and this server runs on Render's free tier, which spins ` +
            `down when idle. Several cold starts a day means this number can read near zero ` +
            `while real monthly usage climbs. A budget you cannot observe is a budget you are ` +
            `assuming, which is the exact reasoning behind every other counter here.\n\n` +
            `THE AUTHORITATIVE NUMBER is CFBD's own account info endpoint (see the "info" ` +
            `operations at api.collegefootballdata.com/api/info). Check it directly before ` +
            `concluding there is headroom.\n\n` +
            `The commonly cited free-tier limit is 1,000 requests a month (3,000 on a verified ` +
            `.edu key), but CFBD's docs deliberately do NOT publish limits - they point to the ` +
            `API tiers page and note the figures change. Treat 1,000 as an unverified planning ` +
            `assumption, not a fact. The DESIGN holds either way: one request returns a whole ` +
            `week of box scores, so a prior-season backfill is ~16 requests and an in-season ` +
            `refresh is 1 a week. If this number climbs faster than that, something is fetching ` +
            `per game or per player instead of per week.`
          );
        })();

        return {
          content: [
            {
              type: "text" as const,
              text:
                `SportsGameOdds account usage:\n\n${truncated}\n\n${cacheLine}\n\n${cfbdLine}\n\n` +
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
