import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BDLClient } from "../services/bdlClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * BDL STATS MIGRATION PROBE
 *
 * WHY THIS EXISTS RATHER THAN JUST WRITING THE MIGRATION:
 *
 * Moving hit-rate computation from SportsGameOdds to BALLDONTLIE is the single
 * highest-value change available to this connector. Measured on 2026-08-10: one
 * thread cost 211 SGO entities, a 15-game slate ~3,000, and a month of daily
 * builds projected to ~114,000 against a 100,000 cap. BDL has no monthly object
 * cap at all - only a per-minute request limit - so the migration removes the
 * binding constraint instead of shrinking it.
 *
 * TWO THINGS MUST BE CONFIRMED BEFORE ANY OF THAT CAN BE BUILT, and neither can
 * be answered from documentation:
 *
 *   1. TIER ACCESS. Player stats are reported to be included in ALL-STAR
 *      ($9.99/sport, already subscribed for MLB and WNBA), with odds and props
 *      requiring GOAT ($39.99). That comes from a third-party article, not BDL's
 *      own pricing page. A 401 here means the migration needs a paid upgrade and
 *      the economics change completely.
 *
 *   2. FIELD NAMES. SGO statIDs (batting_hits, batting_totalBases,
 *      pitching_strikeouts) have to map onto BDL's response fields. Those field
 *      names are not published in a form that can be relied on, and total bases
 *      in particular may not exist as a field at all - it may need computing from
 *      singles/doubles/triples/home runs.
 *
 * WHY NOT JUST GUESS AND FALL BACK: this connector has shipped a wrong BDL field
 * assumption twice (injuries team lookup, then again on the retry). Both times it
 * failed SILENTLY - returning "unknown" or an empty result that read as a clean
 * answer. A wrong stat mapping is worse still: a missing field would read as 0,
 * which is indistinguishable from a real 0 hits, and would produce a confident,
 * completely wrong hit rate published to thousands of people.
 *
 * Run this once per sport, read the real field names off the response, and only
 * then write the mapping.
 */
const ProbeInputSchema = z
  .object({
    sport: z
      .enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]])
      .describe("Which sport to probe. Start with mlb."),
    playerName: z
      .string()
      .describe(
        "Player name to look up, e.g. 'Ketel Marte'. Resolved to a BDL numeric ID first, since SGO and BDL use different ID spaces."
      ),
  })
  .strict();

type ProbeInput = z.infer<typeof ProbeInputSchema>;

export function registerBdlStatsProbeTool(server: McpServer, bdl: BDLClient) {
  server.registerTool(
    "tkb_debug_bdl_stats",
    {
      title: "[DIAGNOSTIC] Probe BALLDONTLIE player game stats",
      description: `Verify whether BALLDONTLIE player game stats are accessible on the current
subscription tier, and reveal the real response field names.

This exists to answer two questions that documentation cannot settle:
  1. Does the current BDL tier include player game stats? (401 = no)
  2. What are the actual stat field names, so an SGO statID mapping can be written
     against real data rather than assumptions?

Returns: the resolved BDL player ID, the raw stat rows for that player, and an
explicit list of every field name present on the first row.

Args:
  - sport: which sport to probe
  - playerName: e.g. "Ketel Marte" - resolved to a numeric BDL ID automatically

Examples:
  - Use when: evaluating whether hit-rate computation can move off SportsGameOdds
  - Use when: a stat mapping returns nothing and the field name is suspect
  - Don't use when: building a thread - this is a diagnostic, not a data source

Error Handling:
  - A 401 is the ANSWER, not a failure: it means this tier does not include stats
  - Reports clearly when the player name matches zero or multiple BDL players,
    rather than picking one and risking a wrong-player stat line`,
      inputSchema: ProbeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: ProbeInput) => {
      try {
        // ---- Step 1: resolve name -> BDL numeric ID ----
        const search = await bdl.searchPlayers(params.sport, params.playerName);

        if (!search.data.length) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No ${params.sport.toUpperCase()} player found on BALLDONTLIE matching "${params.playerName}".\n\n` +
                  `If other names resolve fine, this is a name-format mismatch rather than a tier problem. ` +
                  `If NOTHING resolves, the players endpoint itself may be gated on this tier.`,
              },
            ],
          };
        }

        const candidates = search.data.map((p) => ({
          bdlPlayerID: p.id,
          name: `${p.first_name} ${p.last_name}`,
          team: p.team?.full_name ?? p.team?.display_name ?? p.team?.name ?? "unknown",
        }));

        const chosen = search.data[0]!;
        const ambiguity =
          candidates.length > 1
            ? `\n\nNOTE: ${candidates.length} players matched. Probing the first. For a real ` +
              `migration the team must be cross-checked, since resolving the wrong player ` +
              `produces a confident but completely wrong hit rate.\n` +
              JSON.stringify(candidates, null, 2)
            : "";

        // ---- Step 2: pull raw stat rows ----
        const raw = (await bdl.getRawPlayerGameStats(params.sport, chosen.id, 3)) as {
          data?: unknown[];
        };

        const rows = Array.isArray(raw?.data) ? raw.data : [];

        if (!rows.length) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `TIER ACCESS OK (no 401), but zero stat rows returned for ` +
                  `${chosen.first_name} ${chosen.last_name} (BDL id ${chosen.id}).\n\n` +
                  `The endpoint is reachable on this subscription, which answers the tier ` +
                  `question positively. An empty result more likely means the filters need ` +
                  `a season or date range for this sport.${ambiguity}`,
              },
            ],
          };
        }

        // ---- Step 3: expose the real field shape ----
        const first = rows[0] as Record<string, unknown>;
        const fieldNames = Object.keys(first).sort();
        const scalarFields = fieldNames.filter(
          (k) => typeof first[k] === "number" || typeof first[k] === "string"
        );

        const text =
          `BDL STATS ACCESSIBLE on this tier for ${params.sport.toUpperCase()}.\n\n` +
          `Player: ${chosen.first_name} ${chosen.last_name} (BDL id ${chosen.id})\n` +
          `Rows returned: ${rows.length}\n\n` +
          `FIELD NAMES ON ROW 1 (${fieldNames.length} total):\n${fieldNames.join(", ")}\n\n` +
          `SCALAR (mappable) FIELDS:\n${scalarFields.join(", ")}\n\n` +
          `RAW ROW 1:\n${JSON.stringify(first, null, 2)}\n\n` +
          `NEXT STEP: map SGO statIDs onto these field names in a new ` +
          `services/bdlStatMap.ts. Note whether total bases exists directly or has to ` +
          `be computed from singles/doubles/triples/home runs.${ambiguity}`;

        return {
          content: [{ type: "text" as const, text: text.slice(0, 12000) }],
          structuredContent: {
            tierAccessOK: true,
            bdlPlayerID: chosen.id,
            playerName: `${chosen.first_name} ${chosen.last_name}`,
            rowCount: rows.length,
            fieldNames,
            scalarFields,
            candidates,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isAuth = msg.includes("auth error") || msg.includes("401");
        return {
          content: [
            {
              type: "text" as const,
              text: isAuth
                ? `TIER GATE CONFIRMED - this is the answer, not a malfunction.\n\n${msg}\n\n` +
                  `Player game stats are NOT included on the current ${params.sport.toUpperCase()} ` +
                  `subscription. Migrating hit rates to BALLDONTLIE would require an upgrade ` +
                  `(reported at GOAT, $39.99/sport/month), which changes the economics versus ` +
                  `staying on SportsGameOdds. Do not build the migration until this is resolved.`
                : `Error probing BDL stats: ${msg}`,
            },
          ],
          isError: !isAuth,
        };
      }
    }
  );
}
