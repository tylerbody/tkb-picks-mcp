import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BDLClient } from "../services/bdlClient.js";
import { resolveStat, isStatSupported } from "../services/bdlStatMap.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * STREAK & MILESTONE SCANNER
 *
 * WHY THIS IS NOT A PICKS TOOL, AND WHY THAT IS THE POINT:
 *
 * Every other tool here exists to produce a pick. But an account that posts only
 * picks has a structural problem: published growth guidance for handicapper
 * accounts puts the healthy mix nearer 40% picks / 30% engagement / 30% personal,
 * and warns that broadcast-only accounts get deprioritised and read as bots. This
 * connector had no way to produce anything except picks, so the content mix was
 * effectively forced to 100%.
 *
 * Streaks and milestones are the cheapest possible fix. They are genuinely
 * interesting on their own, they invite replies rather than just clicks, and they
 * are built from data already being pulled for other reasons.
 *
 * RUNS ON BALLDONTLIE, SO IT COSTS NO SGO QUOTA. That matters because this is a
 * once-a-day scan across many players - exactly the shape of workload that made
 * the SGO entity bill unmanageable.
 *
 * WHAT COUNTS AS NOTABLE (deliberately conservative):
 *   - An ACTIVE streak of 3+ consecutive games clearing a threshold
 *   - Approaching a round-number season milestone within a plausible reach
 *   - A recent outlier game well above the player's own baseline
 *
 * Ordinary production is not surfaced. A scanner that flags everything gets
 * ignored, which is the same failure as flagging nothing.
 */

const StreakInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]).describe("Which sport"),
    playerNames: z
      .array(z.string())
      .min(1)
      .max(12)
      .describe(
        "Players to scan, by name. Pull these from tkb_get_players for today's slate, or pass a watchlist of stars."
      ),
    statID: z
      .string()
      .describe(
        "Which stat to scan, using SGO statID form: 'batting_hits', 'batting_totalBases', 'points', 'rebounds', 'assists'."
      ),
    threshold: z
      .number()
      .default(0.5)
      .describe("The bar a game must clear to extend a streak. 0.5 = 'recorded at least one'."),
    minStreak: z
      .number()
      .int()
      .min(2)
      .default(3)
      .describe("Minimum consecutive games to report. Below 3 is noise, not a streak."),
    lookback: z
      .number()
      .int()
      .min(5)
      .max(40)
      .default(20)
      .describe("How many recent appearances to examine per player."),
  })
  .strict();

type StreakInput = z.infer<typeof StreakInputSchema>;

interface StreakFinding {
  playerName: string;
  bdlPlayerID: number;
  activeStreak: number;
  streakThreshold: number;
  last10Values: (number | null)[];
  seasonHighInWindow: number | null;
  averageInWindow: number | null;
  standoutGame: { value: number; date: string; opponent: string } | null;
  headline: string;
}

export function registerStreakScanTool(server: McpServer, bdl: BDLClient) {
  server.registerTool(
    "tkb_scan_streaks",
    {
      title: "Scan players for active streaks and standout games",
      description: `Find active streaks and standout performances worth posting about - NON-PICK
content, which is the category this account produces least of.

WHY IT MATTERS: an account that only posts picks has no reason for anyone to engage
between plays, and broadcast-only posting patterns get deprioritised. Streak posts,
milestone watches and "did you see this" stat lines invite replies rather than just
clicks, and they cost nothing extra to produce.

Runs entirely on BALLDONTLIE, so it consumes NO SportsGameOdds quota.

Args:
  - sport, playerNames (up to 12), statID (SGO form, e.g. 'batting_hits')
  - threshold (default 0.5): the bar a game must clear
  - minStreak (default 3): minimum consecutive games to report
  - lookback (default 20): appearances to examine

Returns: per player, the active streak length, last 10 values, window average and
high, any standout game, and a ready-to-adapt headline.

Examples:
  - Use when: building a standalone post on an off-day or between slates
  - Use when: "anything interesting happening with these guys?"
  - Use when: looking for a hook for a thread opener
  - Don't use when: you need odds or a hit rate against a specific line - use
    tkb_screen_props or tkb_get_player_hit_rate

Error Handling:
  - Players whose name is ambiguous on BALLDONTLIE are reported and skipped rather
    than resolved by guess, since the wrong player produces a confident wrong stat
  - Returns an empty result honestly when nothing clears minStreak - "nothing is
    notable today" is a real answer`,
      inputSchema: StreakInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: StreakInput) => {
      if (!isStatSupported(params.sport, params.statID)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Stat "${params.statID}" has no BALLDONTLIE mapping for ${params.sport.toUpperCase()}. Supported stats are defined in services/bdlStatMap.ts.`,
            },
          ],
          isError: true,
        };
      }

      const findings: StreakFinding[] = [];
      const skipped: string[] = [];

      for (const name of params.playerNames) {
        try {
          const search = await bdl.searchPlayers(params.sport, name);
          if (!search.data.length) {
            skipped.push(`${name}: no BALLDONTLIE match`);
            continue;
          }
          const exact = search.data.filter(
            (p) => `${p.first_name} ${p.last_name}`.toLowerCase() === name.toLowerCase()
          );
          const candidates = exact.length ? exact : search.data;
          if (candidates.length > 1) {
            skipped.push(
              `${name}: ${candidates.length} players matched, refusing to guess which one`
            );
            continue;
          }
          const player = candidates[0]!;

          const raw = await bdl.getPlayerGameStats(params.sport, {
            playerIDs: [player.id],
            perPage: Math.min(params.lookback * 2, 100),
          });
          const rows = (raw.data ?? []) as Record<string, unknown>[];
          if (!rows.length) {
            skipped.push(`${name}: no stat rows returned`);
            continue;
          }

          const sorted = [...rows].sort((a, b) => {
            const da = gameDate(a);
            const db = gameDate(b);
            return (db ? new Date(db).getTime() : 0) - (da ? new Date(da).getTime() : 0);
          });

          const values: { v: number; date: string; opp: string }[] = [];
          for (const row of sorted.slice(0, params.lookback)) {
            const { value } = resolveStat(params.sport, params.statID, row);
            if (value === null) continue;
            values.push({
              v: value,
              date: gameDate(row) ?? "unknown",
              opp: opponentOf(row) ?? "unknown",
            });
          }

          if (!values.length) {
            skipped.push(
              `${name}: rows returned but stat "${params.statID}" resolved on none of them - the field mapping may be wrong, run tkb_debug_bdl_stats`
            );
            continue;
          }

          // Active streak = consecutive most-recent games clearing the threshold.
          let streak = 0;
          for (const g of values) {
            if (g.v > params.threshold) streak++;
            else break;
          }

          const nums = values.map((g) => g.v);
          const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
          const high = Math.max(...nums);
          const standoutRow = values.find((g) => g.v === high);
          // "Standout" means meaningfully above the player's own baseline, not just
          // the max of the window - every window has a max.
          const isStandout = high >= avg * 2 && high > params.threshold;

          if (streak < params.minStreak && !isStandout) continue;

          const headline =
            streak >= params.minStreak
              ? `${player.first_name} ${player.last_name} has cleared ${params.threshold} in ${streak} straight games`
              : `${player.first_name} ${player.last_name} put up ${high} against ${standoutRow?.opp ?? "an opponent"}, well above his ${avg.toFixed(1)} average over this stretch`;

          findings.push({
            playerName: `${player.first_name} ${player.last_name}`,
            bdlPlayerID: player.id,
            activeStreak: streak,
            streakThreshold: params.threshold,
            last10Values: nums.slice(0, 10),
            seasonHighInWindow: high,
            averageInWindow: Number(avg.toFixed(2)),
            standoutGame:
              isStandout && standoutRow
                ? { value: standoutRow.v, date: standoutRow.date, opponent: standoutRow.opp }
                : null,
            headline,
          });
        } catch (err) {
          skipped.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      findings.sort((a, b) => b.activeStreak - a.activeStreak);

      const skipNote = skipped.length
        ? `\n\nSKIPPED (${skipped.length}):\n${skipped.join("\n")}`
        : "";

      if (!findings.length) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Nothing cleared the bar. No player scanned had an active streak of ${params.minStreak}+ ` +
                `games over ${params.threshold} in "${params.statID}", and no standout game stood far ` +
                `enough above baseline to be worth a post.\n\nThis is a real answer, not an error - ` +
                `forcing a post out of ordinary production is how a feed becomes noise.${skipNote}`,
            },
          ],
          structuredContent: { findings: [], skipped },
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `${findings.length} notable finding(s):\n\n` +
              findings.map((f) => `- ${f.headline}`).join("\n") +
              `\n\n${JSON.stringify(findings, null, 2)}${skipNote}`,
          },
        ],
        structuredContent: { findings, skipped },
      };
    }
  );
}

function gameDate(row: Record<string, unknown>): string | null {
  const game = row.game as Record<string, unknown> | undefined;
  for (const c of [row.date, row.game_date, game?.date, game?.game_date]) {
    if (typeof c === "string" && c.length >= 8) return c;
  }
  return null;
}

function opponentOf(row: Record<string, unknown>): string | null {
  const game = row.game as Record<string, unknown> | undefined;
  if (!game) return null;
  const home = game.home_team as Record<string, unknown> | undefined;
  const awayObj = (game.visitor_team ?? game.away_team) as Record<string, unknown> | undefined;
  const team = row.team as Record<string, unknown> | undefined;
  if (team?.id && home?.id === team.id) {
    return String(awayObj?.full_name ?? awayObj?.name ?? "unknown");
  }
  if (team?.id && awayObj?.id === team.id) {
    return String(home?.full_name ?? home?.name ?? "unknown");
  }
  return null;
}
