import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { CFBDClient } from "../services/cfbdClient.js";
import type { CBBDClient } from "../services/cbbdClient.js";

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
  cfbd: CFBDClient | null,
  cbbd: CBBDClient | null = null
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
            `THE AUTHORITATIVE NUMBER IS AN ENDPOINT. GET /info returns monthlyLimit, ` +
            `remainingCalls, usedCalls and resetAt; GET /info/usage splits the SHARED CFB/CBB ` +
            `pool into totals.cfbRequests and totals.cbbRequests. Read those before concluding ` +
            `there is headroom - and remember the pool is shared, so the CollegeBasketballData ` +
            `line below is drawing on the same allowance.\n\n` +
            `The free tier is 1,000 calls a month and the Academic tier is 3,000 (free with a ` +
            `.edu email) - PUBLISHED figures at collegefootballdata.com/api-tiers, not an ` +
            `assumption. What is genuinely unpublished is any per-minute limit and the status ` +
            `code for an exhausted quota. The DESIGN holds regardless: one request returns a whole ` +
            `week of box scores, so a prior-season backfill is ~16 requests and an in-season ` +
            `refresh is 1 a week. If this number climbs faster than that, something is fetching ` +
            `per game or per player instead of per week.`
          );
        })();

        // CBBD SHARES CFBD'S MONTHLY QUOTA, which is the single most important thing
        // to know about it and is not visible from either counter alone. November and
        // early December are the overlap: CFB is still running when CBB tips off, and
        // football usage can exhaust basketball.
        //
        // X-CallLimit-Remaining IS THE ONE TRUSTWORTHY NUMBER HERE. Every counter in
        // this tool is in-process and resets on a Render cold start, so they
        // understate real usage by an unknown amount. That header comes from the
        // provider and does not, which is why it is reported first.
        const cbbdLine = (() => {
          if (!cbbd) return `CollegeBasketballData: not configured (CBBD_API_KEY unset).`;
          const c = cbbd.getStats();
          return (
            `CollegeBasketballData: ` +
            (c.callLimitRemaining !== null
              ? `X-CallLimit-Remaining ${c.callLimitRemaining} AS REPORTED BY THE PROVIDER - ` +
                `trust this over the in-process counters below. `
              : `no X-CallLimit-Remaining seen yet (no request made this process). `) +
            `${c.requests} request(s) this process, ${c.hits} cache hit(s), ${c.misses} ` +
            `miss(es), ${c.coalesced} coalesced, ${c.errors} error(s). ${c.cachedWindows} ` +
            `date window(s) cached, ${c.permanentWindows} of them permanent.\n\n` +
            `THE QUOTA IS SHARED WITH CollegeFootballData. It is tied to the account, not ` +
            `to the sport, so the two counters above are drawing on ONE allowance. In ` +
            `November and early December both seasons are live at once and CFB can ` +
            `exhaust CBB. The free tier is commonly cited at 1,000 calls a month; treat ` +
            `that as a planning assumption rather than a documented fact.\n\n` +
            `The design absorbs being wrong about the number: one request returns every ` +
            `box score in a whole date window, so an in-season refresh is about one call ` +
            `a week per sport. If this climbs faster than that, something is fetching per ` +
            `game instead of per window.`
          );
        })();

        return {
          content: [
            {
              type: "text" as const,
              text:
                `SportsGameOdds account usage:\n\n${truncated}\n\n${cacheLine}\n\n${cfbdLine}\n\n${cbbdLine}\n\n` +
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
