import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CFBDClient } from "../services/cfbdClient.js";
import {
  CFBD_STAT_MAP,
  lookupCfbdStat,
  supportedCfbdStatIDs,
  type CfbdCategory,
} from "../services/cfbdStatMap.js";

/**
 * DIAGNOSTIC: what literals does CollegeFootballData actually use?
 *
 * RUN THIS ONCE, FIRST, BEFORE ANY CFB THREAD USES A CFBD NUMBER.
 *
 * WHY IT EXISTS, and why it is the first thing to run rather than a nice-to-have:
 * CFBD's OpenAPI schema pins the box-score STRUCTURE exactly and then types
 * `categories[].name` and `types[].name` as bare strings with no enum. So the exact
 * literals - "passing" or "Passing", "YDS" or "yards", "C/ATT" or "COMP/ATT" - are
 * the one thing a stat mapping depends on and the one thing the schema cannot tell
 * us. cfbdStatMap.ts therefore ships CANDIDATE ARRAYS rather than single guesses,
 * and this tool reports which candidate actually matched.
 *
 * THE PRECEDENT IS EXACT. v2.0.0 shipped tkb_debug_bdl_stats for the same reason and
 * v2.0.1, run within the hour, caught two real bugs with it: the p_k batting/pitching
 * collision that would have reported how often a PITCHER struck out as a HITTER, and
 * a full-name search that returned nothing because BDL matches on surname only. Both
 * failed SILENTLY. Neither would have been found by reading code.
 *
 * WHAT TO DO WITH THE OUTPUT: if a stat shows `matched: null`, read the
 * `categoriesSeen` / `typesSeen` lists it returns and ADD the real literal to the
 * candidate array in cfbdStatMap.ts. Add, never replace - a provider that changes
 * its mind later should still resolve.
 *
 * COSTS ONE REQUEST, and only on a cache miss.
 */
export function registerCfbdStatsProbeTool(server: McpServer, cfbd: CFBDClient): void {
  server.registerTool(
    "tkb_debug_cfbd_stats",
    {
      title: "Diagnostic: CollegeFootballData field names and stat resolution",
      description:
        "DIAGNOSTIC, NOT FOR THREAD CONTENT. Fetches one week of CFB box scores and reports the REAL category and type literals CollegeFootballData uses, plus which SGO statIDs resolve against them. RUN THIS ONCE AFTER DEPLOYING before trusting any CFB hit rate: the CFBD schema types these names as bare strings with no enum, so the mapping ships with candidate arrays rather than guesses, and this is what confirms which candidate is right. If a stat reports matched:null, add the real literal shown in typesSeen to the candidate array in cfbdStatMap.ts. Costs one CFBD request on a cache miss, zero on a hit.",
      inputSchema: {
        year: z
          .number()
          .int()
          .describe("Season year, e.g. 2025. Use a COMPLETED season so box scores exist."),
        week: z.number().int().default(1).describe("Week number within that season."),
        seasonType: z.enum(["regular", "postseason"]).default("regular"),
        team: z
          .string()
          .optional()
          .describe("Optional team name to focus the sample on, e.g. 'Oregon'."),
        playerName: z
          .string()
          .optional()
          .describe(
            "Optional player to resolve every mapped stat against, so a real end-to-end lookup is exercised rather than just the literals being listed."
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      let games;
      try {
        games = await cfbd.getWeekPlayerStats({
          year: input.year,
          week: input.week,
          seasonType: input.seasonType,
          permanent: true,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `CFBD PROBE FAILED: ${msg}\n\n` +
                `This is a configuration or quota answer, not a data answer. If it is a ` +
                `401, CFBD_API_KEY is missing or malformed in the environment. If it is a ` +
                `429, the monthly quota is gone and will not reset for days - do not retry.`,
            },
          ],
        };
      }

      if (!games.length) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `CFBD returned NO GAMES for ${input.year} week ${input.week} ` +
                `(${input.seasonType}). The request succeeded, so this is an empty week ` +
                `rather than a failure. Pick a week that has been played.`,
            },
          ],
        };
      }

      const wantTeam = input.team?.trim().toLowerCase();
      const categoriesSeen = new Map<string, Set<string>>();
      let sampleCategories: CfbdCategory[] | null = null;
      let sampleTeam = "";
      const athleteNames = new Set<string>();

      for (const game of games) {
        for (const team of game.teams ?? []) {
          if (wantTeam && team.team.trim().toLowerCase() !== wantTeam) continue;
          if (!sampleCategories && (team.categories ?? []).length) {
            sampleCategories = team.categories;
            sampleTeam = team.team;
          }
          for (const category of team.categories ?? []) {
            if (!categoriesSeen.has(category.name)) {
              categoriesSeen.set(category.name, new Set());
            }
            const types = categoriesSeen.get(category.name)!;
            for (const type of category.types ?? []) {
              types.add(type.name);
              if (sampleTeam === team.team) {
                for (const a of type.athletes ?? []) athleteNames.add(a.name);
              }
            }
          }
        }
      }

      const literalLines = [...categoriesSeen.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([cat, types]) => `  ${cat}: ${[...types].sort().join(", ")}`)
        .join("\n");

      // Resolve every mapped stat against a real athlete so the report proves an
      // end-to-end lookup rather than merely listing strings.
      let resolutionReport = "";
      if (sampleCategories) {
        const target = input.playerName
          ? [...athleteNames].find(
              (n) => n.trim().toLowerCase() === input.playerName!.trim().toLowerCase()
            )
          : undefined;

        let probeId: string | null = null;
        let probeName = "";
        for (const category of sampleCategories) {
          for (const type of category.types ?? []) {
            for (const a of type.athletes ?? []) {
              if (target ? a.name === target : !probeId) {
                probeId = a.id;
                probeName = a.name;
              }
            }
          }
        }

        if (probeId) {
          const rows = Object.keys(CFBD_STAT_MAP).map((statID) => {
            const r = lookupCfbdStat(sampleCategories!, probeId!, statID);
            return r.kind === "value"
              ? `  ${statID}: ${r.value}  [matched ${r.matchedCategory}/${r.matchedType}]`
              : `  ${statID}: null  [${r.kind}]`;
          });
          resolutionReport =
            `\n\nRESOLUTION AGAINST A REAL PLAYER (${probeName}, ${sampleTeam}):\n` +
            rows.join("\n") +
            `\n\nA "null [player_absent]" here is normal for a stat this player does not ` +
            `record - a running back has no passing line. A null on a stat he plainly DID ` +
            `record means the literal is wrong: find it in the list above and add it to the ` +
            `candidate array in cfbdStatMap.ts.`;
        }
      }

      const stats = cfbd.getStats();

      return {
        content: [
          {
            type: "text" as const,
            text:
              `CFBD PROBE - ${input.year} week ${input.week} (${input.seasonType})\n` +
              `${games.length} game(s) returned in ONE request.\n\n` +
              `CATEGORY AND TYPE LITERALS THIS PROVIDER ACTUALLY USES:\n${literalLines}` +
              resolutionReport +
              `\n\nMapped statIDs: ${supportedCfbdStatIDs().join(", ")}` +
              `\n\nCFBD usage this process: ${stats.requests} request(s), ` +
              `${stats.hits} cache hit(s), ${stats.misses} miss(es), ` +
              `${stats.coalesced} coalesced, ${stats.cachedWeeks} week(s) cached ` +
              `(${stats.permanentWeeks} permanent). Free tier is 1,000 requests a MONTH.`,
          },
        ],
      };
    }
  );
}
