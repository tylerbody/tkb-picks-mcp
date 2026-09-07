import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import { buildOddID } from "../services/oddIdBuilder.js";
import { OU_PROP_MARKETS } from "../services/marketCatalog.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";

/**
 * LIVE PICK MONITOR / EARLY CASHOUT DETECTOR
 *
 * WHAT THIS AUTOMATES: the EARLY CASHOUT post format already exists and is used,
 * but spotting the moment a prop clears means watching games and checking box
 * scores by hand while a slate is running. The window is short - once the game
 * ends the post is just a normal CASHED reply and loses its whole appeal, which
 * is that it lands while people can still act on it.
 *
 * THE GRADING RULE THIS ENFORCES, taken from the manual workflow that already
 * proved necessary: an OVER can be graded WIN mid-game the moment it clears,
 * because a counting stat cannot go back down. An UNDER cannot be graded until
 * the player is finished, because it can still be broken. Three grades were
 * previously stated wrong in a single pass by calling unders settled from a
 * partial read. This tool therefore reports CLEARED only for overs, and for
 * unders reports ON TRACK with the remaining margin - never "won".
 *
 * COST: only runs against live events, and only when called. Not part of the
 * thread-building path, so it adds nothing to the per-slate baseline.
 */

const LivePickSchema = z.object({
  ref: z.string().describe("Your label for this pick, echoed back."),
  eventID: z.string(),
  marketType: z.enum(["total", "player_prop"]),
  side: z.enum(["over", "under"]),
  line: z.number().describe("The line as posted."),
  marketLabel: z.string().optional().describe("Required for player_prop."),
  playerID: z.string().optional().describe("Required for player_prop."),
  playerName: z.string().optional(),
});

const LiveMonitorInputSchema = z
  .object({
    sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]),
    picks: z.array(LivePickSchema).min(1).max(40),
  })
  .strict();

type LiveMonitorInput = z.infer<typeof LiveMonitorInputSchema>;

interface LiveStatus {
  ref: string;
  status: "CLEARED" | "ON_TRACK" | "DEAD" | "IN_PROGRESS" | "NOT_STARTED" | "NO_DATA";
  currentValue: number | null;
  line: number;
  margin: number | null;
  detail: string;
  cashoutReady: boolean;
}

export function registerLiveMonitorTool(server: McpServer, sgo: SGOClient) {
  server.registerTool(
    "tkb_monitor_live_picks",
    {
      title: "Check posted picks against live game state",
      description: `Check posted picks against live stats to find which have already cleared -
the EARLY CASHOUT window - and which are mathematically dead.

WHY THIS MATTERS: an early cashout post only works while the game is still running.
Spotting the moment manually means watching box scores across a whole slate, and the
window closes fast.

Args:
  - sport
  - picks: array of { ref, eventID, marketType, side, line, marketLabel?, playerID?, playerName? }

Returns per pick: current value, margin to the line, and a status.

STATUS MEANINGS - the over/under asymmetry is deliberate and important:
  - CLEARED: an OVER that has already passed its line. A counting stat cannot go back
    down, so this is safe to post as cashed mid-game.
  - ON_TRACK: an UNDER currently below its line. NOT a win - it can still be broken.
    Never post an under as cashed before the player is done.
  - DEAD: an under that has already been exceeded.
  - IN_PROGRESS: live but undecided.

Examples:
  - Use when: a slate is running and you want a 💸 EARLY CASHOUT post
  - Use when: checking whether anything has already busted
  - Don't use when: games are final - use tkb_grade_slate

Error Handling:
  - NOT_STARTED for events without live data yet
  - NO_DATA rather than a guess when a stat is unavailable
  - Never reports an UNDER as cleared before the game is final`,
      inputSchema: LiveMonitorInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: LiveMonitorInput) => {
      try {
        const leagueID = sgo.leagueIDFor(params.sport);
        const byEvent = new Map<string, LiveMonitorInput["picks"]>();
        for (const p of params.picks) {
          const list = byEvent.get(p.eventID) ?? [];
          list.push(p);
          byEvent.set(p.eventID, list);
        }

        const statuses: LiveStatus[] = [];

        for (const [eventID, picks] of byEvent) {
          let event;
          try {
            // Deliberately NOT finalized-filtered - this path wants in-progress
            // games, which also means it never touches the historical cache.
            const events = await sgo.getAllEvents({
              leagueID,
              eventIDs: eventID,
              oddIDs: "points-home-game-ml-home",
            });
            event = events[0];
          } catch (err) {
            for (const p of picks) {
              statuses.push({
                ref: p.ref,
                status: "NO_DATA",
                currentValue: null,
                line: p.line,
                margin: null,
                detail: `Fetch failed: ${err instanceof Error ? err.message : String(err)}`,
                cashoutReady: false,
              });
            }
            continue;
          }

          if (!event) {
            for (const p of picks) {
              statuses.push({
                ref: p.ref,
                status: "NO_DATA",
                currentValue: null,
                line: p.line,
                margin: null,
                detail: `Event ${eventID} not found.`,
                cashoutReady: false,
              });
            }
            continue;
          }

          const started = event.status?.started === true;
          const completed = event.status?.completed === true;

          for (const p of picks) {
            if (!started) {
              statuses.push({
                ref: p.ref,
                status: "NOT_STARTED",
                currentValue: null,
                line: p.line,
                margin: null,
                detail: "Game has not started.",
                cashoutReady: false,
              });
              continue;
            }

            const value = readLiveStat(params.sport, event, p);
            if (value === null) {
              statuses.push({
                ref: p.ref,
                status: "NO_DATA",
                currentValue: null,
                line: p.line,
                margin: null,
                detail:
                  "No live value available for this market yet. Live results populate as the game progresses.",
                cashoutReady: false,
              });
              continue;
            }

            const margin = Number((value - p.line).toFixed(2));
            const label = p.playerName ?? p.marketLabel ?? p.marketType;

            if (p.side === "over") {
              if (value > p.line) {
                statuses.push({
                  ref: p.ref,
                  status: "CLEARED",
                  currentValue: value,
                  line: p.line,
                  margin,
                  detail: `${label} is at ${value}, past the ${p.line} line. Counting stats do not go back down - safe to post as cashed.`,
                  cashoutReady: true,
                });
              } else {
                statuses.push({
                  ref: p.ref,
                  status: "IN_PROGRESS",
                  currentValue: value,
                  line: p.line,
                  margin,
                  detail: `${label} at ${value}, needs ${Number((p.line - value).toFixed(2))} more.`,
                  cashoutReady: false,
                });
              }
              continue;
            }

            // UNDER - never callable as a win before the game is final.
            if (value > p.line) {
              statuses.push({
                ref: p.ref,
                status: "DEAD",
                currentValue: value,
                line: p.line,
                margin,
                detail: `${label} is at ${value}, already past ${p.line}. This under is gone.`,
                cashoutReady: false,
              });
            } else if (completed) {
              statuses.push({
                ref: p.ref,
                status: "CLEARED",
                currentValue: value,
                line: p.line,
                margin,
                detail: `${label} finished at ${value}, under ${p.line}. Game is final.`,
                cashoutReady: true,
              });
            } else {
              statuses.push({
                ref: p.ref,
                status: "ON_TRACK",
                currentValue: value,
                line: p.line,
                margin,
                detail: `${label} at ${value}, under ${p.line} with the game still live. DO NOT post this as cashed - an under can still be broken.`,
                cashoutReady: false,
              });
            }
          }
        }

        const cleared = statuses.filter((s) => s.status === "CLEARED");
        const dead = statuses.filter((s) => s.status === "DEAD");
        const onTrack = statuses.filter((s) => s.status === "ON_TRACK");

        const header =
          `${statuses.length} pick(s) checked across ${byEvent.size} event(s).\n` +
          `${cleared.length} CLEARED${cleared.length ? " (cashout-ready)" : ""}, ` +
          `${onTrack.length} on track, ${dead.length} dead.` +
          (cleared.length
            ? `\n\nREADY TO POST:\n${cleared.map((c) => `- ${c.detail}`).join("\n")}`
            : "") +
          (onTrack.length
            ? `\n\nDO NOT POST AS CASHED YET (unders still live):\n${onTrack.map((c) => `- ${c.ref}`).join("\n")}`
            : "");

        return {
          content: [
            { type: "text" as const, text: `${header}\n\n${JSON.stringify(statuses, null, 2)}` },
          ],
          structuredContent: {
            cashoutReady: cleared.map((c) => c.ref),
            dead: dead.map((c) => c.ref),
            statuses,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error monitoring live picks: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}

const PERIOD_FULL_GAME = "game";

function readLiveStat(
  sport: SportKey,
  event: { results?: Record<string, Record<string, Record<string, number>>>; teams: { home: { score?: number }; away: { score?: number } } },
  pick: LiveMonitorInput["picks"][number]
): number | null {
  if (pick.marketType === "total") {
    const h = event.teams.home.score;
    const a = event.teams.away.score;
    if (h === undefined || a === undefined) return null;
    return h + a;
  }

  if (!pick.playerID || !pick.marketLabel) return null;
  const market = OU_PROP_MARKETS[sport].find(
    (m) => m.label.toLowerCase() === pick.marketLabel!.toLowerCase()
  );
  if (!market) return null;

  const periodResults = event.results?.[PERIOD_FULL_GAME];
  const playerResults = periodResults?.[pick.playerID];
  const v = playerResults?.[market.statID];
  return typeof v === "number" ? v : null;
}

/** Kept for symmetry with other tools that construct oddIDs. */
export function livePickOddID(sport: SportKey, pick: LiveMonitorInput["picks"][number]): string | null {
  if (pick.marketType === "total") {
    return buildOddID({
      statID: "points",
      entity: "all",
      period: "full_game",
      betType: "ou",
      side: pick.side,
    });
  }
  if (!pick.playerID || !pick.marketLabel) return null;
  const market = OU_PROP_MARKETS[sport].find(
    (m) => m.label.toLowerCase() === pick.marketLabel!.toLowerCase()
  );
  if (!market) return null;
  return buildOddID({
    statID: market.statID,
    entity: pick.playerID,
    period: "full_game",
    betType: "ou",
    side: pick.side,
  });
}
