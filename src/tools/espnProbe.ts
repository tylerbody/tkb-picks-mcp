import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  EspnClient,
  ESPN_LEAGUE_PATHS,
  ESPN_STATS_PATH,
  flattenGamelog,
  parseStatValue,
  detectPairedColumns,
  extractRoster,
  type EspnGamelog,
} from "../services/espnClient.js";
import { flexBoolean, flexIntOptional, asBoolean, asNumber } from "../services/flexibleInput.js";

const ProbeInputSchema = z
  .object({
    league: z
      .enum(Object.keys(ESPN_LEAGUE_PATHS) as [string, ...string[]])
      .describe(
        "Which ESPN league path to probe. wnba and nhl were fetched live and verified 2026-09-29; nba, nfl and mlb follow the same path shape and are UNVERIFIED until this probe says otherwise."
      ),
    espnId: z
      .string()
      .optional()
      .describe(
        "ESPN numeric athlete id, e.g. 3149391 for A'ja Wilson. Omit it and pass teamEspnId to list a roster instead, which is how you find one."
      ),
    teamEspnId: z
      .string()
      .optional()
      .describe(
        "ESPN numeric team id. With no espnId this returns that team's roster (id + name), which is the ID-MAPPING half of the problem: SGO says AJA_WILSON_1_WNBA and ESPN says 3149391, with no shared key. Omit both to list every team id."
      ),
    season: flexIntOptional(2000, 2100).describe(
      "Season year. ESPN offers 2018 through 2026 for WNBA. Omitted means ESPN's default, which is the current season."
    ),
    includePreseason: flexBoolean(false).describe(
      "Include preseason games in the flattened count. Off by default: a preseason game is not evidence for a regular-season prop."
    ),
    sampleRows: flexIntOptional(1, 10).describe(
      "How many real stat rows to return, label-mapped, so the shape can be eyeballed. Default 2."
    ),
  })
  .strict();

type ProbeInput = z.infer<typeof ProbeInputSchema>;

export function registerEspnProbeTool(server: McpServer, espn: EspnClient = new EspnClient()) {
  server.registerTool(
    "tkb_probe_espn_gamelog",
    {
      title: "Probe ESPN Game Log (diagnostic only)",
      description: `DIAGNOSTIC. Proves whether this server can reach ESPN's keyless game-log
endpoint and whether the response still has the shape that was measured by hand on
2026-09-29. It is NOT a data source and must never back a published pick.

WHY IT EXISTS. BDL's GOAT tier was ruled out. ESPN's public gamelog is the free
alternative and carries minutes plus points, rebounds, assists, steals, blocks, turnovers
and threes per game, which would give WNBA hit rates where this connector currently has
none. Before any of that is built, two things have to be true and neither has ever been
tested: that Render's outbound network can reach ESPN at all, and that the numbers sit
where they were measured. This answers both from the server, not from a browser.

Args:
  - league: wnba | nba | nhl | nfl | mlb
  - espnId: athlete id. Omit + pass teamEspnId to list a roster; omit both to list teams.
  - season, includePreseason, sampleRows

Reports: reachability with HTTP status and elapsed ms, top-level keys, the labels/names
arrays, whether the measured stats path still holds, the season/category structure
(regular seasons come back split BY MONTH), label-mapped sample rows, which columns carry
the made-attempted "7-21" form, and any row whose length disagrees with labels.

Examples:
  - "can Render reach ESPN" -> league="wnba", espnId="3149391"
  - "what is X's ESPN id" -> league="wnba", teamEspnId="17"
  - "does this work for hockey" -> league="nhl", espnId=<an NHL athlete id>`,
      inputSchema: ProbeInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input: ProbeInput) => {
      try {
        // Resolved in code, not only in the schema. A direct handler call skips zod, and
        // this repo has been bitten by that twice: v2.10.8 on defaults, v2.11.1 on types.
        const season = asNumber(input.season);
        const includePreseason = asBoolean(input.includePreseason, false);
        const sampleRows = asNumber(input.sampleRows) ?? 2;

        const path = ESPN_LEAGUE_PATHS[input.league];
        if (!path) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No ESPN path is defined for "${input.league}". Known: ` +
                  `${Object.keys(ESPN_LEAGUE_PATHS).join(", ")}.`,
              },
            ],
            isError: true,
          };
        }

        // ---- Mode 1: list teams, so a team id can be found without guessing ----
        if (!input.espnId && !input.teamEspnId) {
          const res = await espn.fetchTeams(path);
          if (!res.ok) {
            return {
              content: [
                { type: "text" as const, text: `TEAMS LOOKUP FAILED.\n\n${res.reason}\n\n${res.url}` },
              ],
              structuredContent: {
                mode: "teams",
                reachable: false,
                status: res.status,
                elapsedMs: res.elapsedMs,
                url: res.url,
                reason: res.reason,
              },
            };
          }
          const teams = extractRoster(res.data);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `ESPN reachable. ${teams.length} team-ish entries found in ${res.elapsedMs}ms.\n\n` +
                  JSON.stringify(teams.slice(0, 40), null, 2),
              },
            ],
            structuredContent: {
              mode: "teams",
              reachable: true,
              status: res.status,
              elapsedMs: res.elapsedMs,
              url: res.url,
              // extractRoster targets athletes; on the teams endpoint it may find little.
              // Reported as-is rather than reshaped, because this is a probe.
              entries: teams.slice(0, 40),
              note:
                `This endpoint returns teams, not athletes, so the extractor may report few ` +
                `entries. Use the raw url above if a team id is missing, then re-run with ` +
                `teamEspnId to get athlete ids.`,
            },
          };
        }

        // ---- Mode 2: roster, which is the ID-mapping half ----
        if (!input.espnId && input.teamEspnId) {
          const res = await espn.fetchRoster(path, input.teamEspnId);
          if (!res.ok) {
            return {
              content: [
                { type: "text" as const, text: `ROSTER LOOKUP FAILED.\n\n${res.reason}\n\n${res.url}` },
              ],
              structuredContent: {
                mode: "roster",
                reachable: false,
                status: res.status,
                elapsedMs: res.elapsedMs,
                url: res.url,
                reason: res.reason,
              },
            };
          }
          const roster = extractRoster(res.data);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `ESPN reachable. ${roster.length} athlete(s) on team ${input.teamEspnId} in ` +
                  `${res.elapsedMs}ms.\n\n${JSON.stringify(roster, null, 2)}\n\n` +
                  `NAME MATCHING IS THE REAL WORK. SGO player names carry accents and hyphens ` +
                  `(Slafkovsky, Ekman-Larsson, Parker-Tyus all appear in live SGO data), so a ` +
                  `resolver built on this must refuse an uncertain match rather than guess one.`,
              },
            ],
            structuredContent: {
              mode: "roster",
              reachable: true,
              status: res.status,
              elapsedMs: res.elapsedMs,
              url: res.url,
              athleteCount: roster.length,
              athletes: roster,
            },
          };
        }

        // ---- Mode 3: the gamelog itself ----
        const res = await espn.fetchGamelog(path, input.espnId!, season);
        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `GAMELOG FETCH FAILED.\n\n${res.reason}\n\n${res.url}\n\n` +
                  `Nothing about the data shape can be concluded from this. If the reason ` +
                  `above says egress, the build is blocked on Render's outbound network, not ` +
                  `on ESPN.`,
              },
            ],
            structuredContent: {
              mode: "gamelog",
              reachable: false,
              status: res.status,
              elapsedMs: res.elapsedMs,
              url: res.url,
              reason: res.reason,
            },
          };
        }

        const log = res.data as EspnGamelog;
        const labels = log.labels ?? [];
        const names = log.names ?? [];
        const topLevelKeys = Object.keys(log as Record<string, unknown>).sort();

        const flat = flattenGamelog(log, { includePreseason });
        const statsPathHolds = flat.games.length > 0;

        /* RECONCILIATION. The root `events` map is game metadata; the stats live at the
         * path above. On the verified sample the two counts matched exactly at 55. If they
         * diverge, one of them is not what it was, and that is worth seeing before any
         * hit rate is computed off it. */
        const eventsMetaCount = log.events ? Object.keys(log.events).length : 0;
        const allGames = flattenGamelog(log, { includePreseason: true }).games.length;

        const paired = detectPairedColumns(labels, flat.games);

        const samples = flat.games.slice(0, sampleRows).map((g) => ({
          eventId: g.eventId,
          seasonType: g.seasonType,
          category: g.category,
          mapped: labels.map((label, i) => {
            const parsed = parseStatValue(g.stats[i]);
            return {
              index: i,
              label,
              name: names[i],
              raw: g.stats[i],
              value: parsed.value,
              form: parsed.form,
              ...(parsed.form === "made-attempted"
                ? { made: parsed.made, attempted: parsed.attempted }
                : {}),
            };
          }),
        }));

        const verdict = !statsPathHolds
          ? `SHAPE CHANGED OR EMPTY. ESPN answered ${res.status} but no rows were found at ` +
            `${ESPN_STATS_PATH}. Do NOT build against this until the path is re-measured.`
          : `SHAPE HOLDS. ${flat.games.length} game row(s) at ${ESPN_STATS_PATH}, ` +
            `${labels.length} stat column(s).`;

        return {
          content: [
            {
              type: "text" as const,
              text:
                `ESPN REACHABLE from this server: HTTP ${res.status} in ${res.elapsedMs}ms.\n\n` +
                `${verdict}\n\n` +
                `SEASON STRUCTURE (a regular season comes back split BY MONTH; anything ` +
                `reading categories[0] gets one month, not a season):\n` +
                `${JSON.stringify(flat.structure, null, 2)}\n\n` +
                `PAIRED COLUMNS (made-attempted, e.g. "7-21" - these are NOT numbers): ` +
                `${paired.length ? paired.map((i) => `${i}:${labels[i]}`).join(", ") : "none"}\n\n` +
                (flat.lengthMismatches.length
                  ? `LENGTH MISMATCHES (${flat.lengthMismatches.length}), dropped and named: ` +
                    `${JSON.stringify(flat.lengthMismatches.slice(0, 5))}\n\n`
                  : `No row disagreed with the labels array on length.\n\n`) +
                `SAMPLE ROWS:\n${JSON.stringify(samples, null, 2)}\n\n` +
                `DIAGNOSTIC ONLY. This tool must not back a published pick.`,
            },
          ],
          structuredContent: {
            mode: "gamelog",
            reachable: true,
            status: res.status,
            elapsedMs: res.elapsedMs,
            url: res.url,
            statsPathExpected: ESPN_STATS_PATH,
            statsPathHolds,
            topLevelKeys,
            labels,
            names,
            columnCount: labels.length,
            gameRowsUsable: flat.games.length,
            gameRowsIncludingPreseason: allGames,
            eventsMetaCount,
            reconciles: eventsMetaCount === allGames,
            seasonStructure: flat.structure,
            pairedColumnIndexes: paired,
            pairedColumnLabels: paired.map((i) => labels[i]),
            lengthMismatches: flat.lengthMismatches.slice(0, 10),
            sampleRows: samples,
            preseasonIncluded: includePreseason,
            verdict,
            caveat:
              `Undocumented endpoint: no contract, no versioning, no deprecation notice. ` +
              `Treat a shape change as expected rather than surprising, and never let a ` +
              `parse failure become a plausible number.`,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error probing ESPN: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
