import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MLBStatsClient, MlbGameMatchup } from "../services/mlbStatsClient.js";
import {
  teamNamesMatch,
  normaliseName,
  resolvePlayerLineupStatus,
} from "../services/mlbStatsClient.js";

/**
 * CONFIRMED STARTERS AND POSTED LINEUPS, FROM MLB DIRECTLY.
 *
 * WHY THIS EXISTS: the README has recorded since v2.6.4 that SGO events carry no
 * lineups field, and that "confirmed starting pitchers still require a live web
 * search, per game, per date". That rule was written because a Chris Sale rotation
 * shuffle produced a published error. This replaces the search with MLB's own feed.
 *
 * ================= READ THIS BEFORE WIRING IT INTO A SCHEDULED JOB =================
 *
 * THE TWO FIELDS HAVE DIFFERENT AVAILABILITY WINDOWS, and confusing them is how this
 * tool would produce a false all-clear.
 *
 *   PROBABLE PITCHERS   available days ahead. Verified populated for games ten hours
 *                       out on 2026-08-31.
 *   LINEUPS             post roughly 3 to 4 hours before first pitch. Before that
 *                       the field EXISTS AND IS EMPTY.
 *
 * THE 10 PM PACIFIC MLB JOB CANNOT CONFIRM A LINEUP. It builds threads for the
 * following day, whose first pitches are 17 or more hours away, so lineups will not
 * exist yet. The 3:45 AM prop fill pass is too early for the same reason.
 *
 * So an empty lineup at build time means "not posted yet", NEVER "he is not playing",
 * and this tool says which of the two it is rather than returning an empty array that
 * a caller could read either way. Treating "not posted" as confirmation would be a
 * worse failure than the manual search it replaces.
 *
 * The lineup check belongs in a LATE pass, close to first pitch, before publishing.
 * The probable-pitcher check belongs at build time and works there today.
 *
 * Costs nothing: no key, no quota, no SGO objects, one request per DATE not per game.
 */
export function registerMlbMatchupTool(server: McpServer, mlb: MLBStatsClient): void {
  server.registerTool(
    "tkb_get_mlb_matchup",
    {
      title: "Confirmed starters, posted lineup and batting order for an MLB game",
      description:
        "MLB Stats API (no key, no quota, zero SGO objects). Returns CONFIRMED probable pitchers and, once posted, the batting order for both sides. TIMING MATTERS AND IS REPORTED: probable pitchers are available days ahead, but LINEUPS ONLY POST 3-4 HOURS BEFORE FIRST PITCH. An empty lineup means NOT POSTED YET, never 'this player is out' - the response says which. The 10 PM Pacific build job is too early for lineups (it builds next-day games) and should use this for probable pitchers only; run it again close to first pitch to confirm a lineup before publishing a hitter prop. Batting order slot is included because a leadoff hitter gets roughly 0.7 more plate appearances than a seven-hole hitter, which is most of the edge on a 0.5 hits or 1.5 total bases line.",
      inputSchema: {
        date: z
          .string()
          .describe("Date in YYYY-MM-DD, in US Eastern terms as MLB schedules it."),
        team: z
          .string()
          .optional()
          .describe("Optional team name filter, e.g. 'Braves' or 'Atlanta Braves'."),
        playerName: z
          .string()
          .optional()
          .describe(
            "Optional: check whether ONE specific hitter is in a posted lineup, and in which slot. Answers the question the nightly jobs actually need before firing a hitter prop."
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
      let games: MlbGameMatchup[];
      try {
        games = await mlb.getScheduleForDate(input.date);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // FAIL SOFT AND SAY SO. This is an extra network dependency inside a
        // 60-second ceiling; a thread must degrade to today's behaviour rather
        // than abort because a free feed blinked.
        return {
          content: [
            {
              type: "text" as const,
              text:
                `MLB STATS API UNAVAILABLE: ${msg}\n\n` +
                `This does not block a thread. Fall back to the existing workflow: ` +
                `confirm the starter by live web search, per game, per date, and do ` +
                `not claim a lineup is confirmed.`,
            },
          ],
        };
      }

      const filtered = input.team
        ? games.filter(
            (g) => teamNamesMatch(g.homeTeam, input.team!) || teamNamesMatch(g.awayTeam, input.team!)
          )
        : games;

      if (!filtered.length) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No MLB games found for ${input.date}` +
                (input.team ? ` matching team "${input.team}"` : "") +
                `. ${games.length} game(s) exist on that date. Check the date format ` +
                `(YYYY-MM-DD) and that the team name matches MLB's spelling.`,
            },
          ],
        };
      }

      // ---- Single-player question, answered through the four-state resolver ----
      //
      // v2.8.0 answered this by scanning posted lineups and, finding none, replying
      // "not posted yet" - which was a confident falsehood for a player whose team
      // was not playing, and for a name that resolved to nobody at all. The premise
      // is now checked before the lineup state.
      if (input.playerName) {
        let candidates;
        try {
          const season = new Date(input.date).getUTCFullYear();
          const index = await mlb.getPlayerIndex(
            Number.isFinite(season) ? season : new Date().getUTCFullYear()
          );
          candidates = index.get(normaliseName(input.playerName));
        } catch (err) {
          // The index is what makes the answer trustworthy. Without it, refuse
          // rather than fall back to v2.8.0's behaviour, which is the bug.
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `CANNOT VERIFY: the MLB player index is unavailable (${msg}), so this ` +
                  `tool cannot confirm that "${input.playerName}" exists or that his team ` +
                  `is playing today.\n\nIt deliberately does NOT fall back to reporting ` +
                  `"lineup not posted yet", because that message is indistinguishable from ` +
                  `an off day or a misspelt name. Confirm the lineup manually.`,
              },
            ],
          };
        }

        // Resolve against the FULL slate, not the team-filtered subset: a team that
        // is playing but excluded by the filter must not read as "not scheduled".
        const status = resolvePlayerLineupStatus(games, candidates, input.playerName);

        const text = (() => {
          switch (status.kind) {
            case "in_lineup":
              return (
                `CONFIRMED IN LINEUP: ${status.slot.fullName} is batting ` +
                `${status.slot.battingOrder}${ordinalSuffix(status.slot.battingOrder)} ` +
                `(${status.slot.position ?? "position unknown"}) for the ${status.teamName} ` +
                `vs ${status.opponent}.\n\n${slotContext(status.slot.battingOrder)}`
              );

            case "not_in_posted_lineup":
              return (
                `NOT IN THE POSTED LINEUP: the ${status.teamName} lineup IS posted for ` +
                `${input.date} and "${input.playerName}" is not in it. This is real ` +
                `information: he is out, resting, or has been moved off the roster. Treat ` +
                `it as a scratch and do not publish a prop on him.`
              );

            case "lineup_pending":
              return (
                `LINEUP NOT POSTED YET: the ${status.teamName} play ${status.opponent} on ` +
                `${input.date}, and "${input.playerName}" is on the roster, but the lineup ` +
                `has not been announced.\n\nThis is NOT evidence he is out. Lineups post ` +
                `roughly 3 to 4 hours before first pitch. Re-run closer to game time; do ` +
                `NOT publish a hitter prop describing the lineup as confirmed.`
              );

            case "team_not_scheduled":
              return (
                `TEAM NOT PLAYING: the ${status.teamName} have no game on ${input.date}, so ` +
                `there is no lineup to wait for.\n\nThis is the answer v2.8.0 got wrong - ` +
                `it reported "lineup not posted yet" here, which would leave a polling job ` +
                `waiting forever for a game that does not exist. Check the date, or pick a ` +
                `player from a team that is actually on the slate.`
              );

            case "team_unresolved":
              return (
                `CANNOT PLACE THIS PLAYER: "${input.playerName}" matches an MLB player, ` +
                `but the roster feed returned neither a team id nor a team name for him, ` +
                `so there is no way to tell which game he would be in.\n\nThis is NOT a ` +
                `statement that he is out or that his team is off. Confirm manually.`
              );

            case "player_unknown":
              return (
                `NO SUCH PLAYER: "${input.playerName}" does not match any player on an MLB ` +
                `roster for this season.\n\nThis is a NAME problem, not a lineup problem. ` +
                `Check the spelling against MLB's own spelling before treating it as a ` +
                `scratch. No conclusion about anyone's availability can be drawn from this.`
              );

            case "ambiguous":
              return (
                `AMBIGUOUS PLAYER: ${status.candidates.length} players match ` +
                `"${input.playerName}" (${status.candidates
                  .map((c) => `${c.fullName}, ${c.teamName ?? "no team"}`)
                  .join("; ")}).\n\nRefusing to guess. A lineup answer attached to the ` +
                `wrong player is worse than no answer. Pass the full name as MLB spells it.`
              );
          }
        })();

        return {
          content: [{ type: "text" as const, text: `${text}\n\n${JSON.stringify(status, null, 2)}` }],
          structuredContent: { status },
        };
      }

      // ---- Whole-slate or single-game view ----
      const blocks = filtered.map((g) => {
        const pitchers =
          `  ${g.awayTeam}: ${g.awayProbablePitcher?.fullName ?? "TBD"}\n` +
          `  ${g.homeTeam}: ${g.homeProbablePitcher?.fullName ?? "TBD"}`;

        const lineupBlock =
          g.awayLineup.length || g.homeLineup.length
            ? `\n  LINEUPS POSTED:\n` +
              renderLineup(g.awayTeam, g.awayLineup) +
              renderLineup(g.homeTeam, g.homeLineup)
            : `\n  LINEUPS NOT POSTED YET. This is not a scratch report - nothing has ` +
              `been announced. They post about 3 to 4 hours before first pitch.`;

        return `${g.awayTeam} @ ${g.homeTeam} (${g.detailedState}, ${g.gameDate})\n${pitchers}${lineupBlock}`;
      });

      const anyTBD = filtered.some((g) => !g.homeProbablePitcher || !g.awayProbablePitcher);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `MLB matchups for ${input.date} (${filtered.length} game(s)):\n\n` +
              blocks.join("\n\n") +
              (anyTBD
                ? `\n\nAt least one starter is TBD. Say so in the thread rather than ` +
                  `guessing - a TBD starter is exactly the case the per-game starter ` +
                  `rule was written for.`
                : "") +
              `\n\nSource: MLB Stats API. No key, no quota, zero SGO objects consumed.`,
          },
        ],
        structuredContent: { games: filtered.map(summarise) },
      };
    }
  );
}

/**
 * THE WARNING HAS TO REACH A MACHINE READER, NOT JUST A HUMAN ONE.
 *
 * v2.8.0 put all its careful "not posted yet" prose in the TEXT content and left
 * structuredContent as `lineupsPosted: false` plus two bare empty arrays. Verified
 * as a real gap: anything consuming the JSON rather than the prose got no warning at
 * all, and an empty array is exactly the shape that reads as "nobody is playing".
 *
 * So the status and its explanation are fields now. A consumer that never reads a
 * word of prose still cannot mistake "not announced" for "not playing".
 *
 * probablePitcherStatus exists for the same reason. The nullable pitcher object
 * STAYS null when unknown - substituting the string "TBD" into a typed field is the
 * exact class of thing the "null, never 0" rule forbids - but a consumer should not
 * have to infer meaning from a null, so the meaning is stated alongside it.
 */
function summarise(g: MlbGameMatchup) {
  const lineupsPosted = g.awayLineup.length > 0 || g.homeLineup.length > 0;
  return {
    gamePk: g.gamePk,
    gameDate: g.gameDate,
    detailedState: g.detailedState,
    awayTeam: g.awayTeam,
    homeTeam: g.homeTeam,
    awayProbablePitcher: g.awayProbablePitcher,
    homeProbablePitcher: g.homeProbablePitcher,
    awayProbablePitcherStatus: g.awayProbablePitcher ? "confirmed" : "tbd",
    homeProbablePitcherStatus: g.homeProbablePitcher ? "confirmed" : "tbd",
    lineupsPosted,
    lineupStatus: lineupsPosted ? "posted" : "not_posted",
    lineupStatusNote: lineupsPosted
      ? "Lineups are posted. An absence from these arrays is real information."
      : "LINEUPS NOT POSTED YET. These arrays are empty because nothing has been " +
        "announced, NOT because players are out. Lineups post roughly 3 to 4 hours " +
        "before first pitch. Do not treat an empty array as a scratch report.",
    awayLineup: g.awayLineup,
    homeLineup: g.homeLineup,
  };
}

function renderLineup(team: string, lineup: { battingOrder: number; fullName: string; position: string | null }[]) {
  if (!lineup.length) return `    ${team}: not posted\n`;
  return (
    `    ${team}:\n` +
    lineup.map((s) => `      ${s.battingOrder}. ${s.fullName} (${s.position ?? "?"})`).join("\n") +
    "\n"
  );
}

function ordinalSuffix(n: number): string {
  if (n === 1) return "st";
  if (n === 2) return "nd";
  if (n === 3) return "rd";
  return "th";
}

/**
 * The plate-appearance argument, stated where the writer will read it. Top-of-order
 * hitters see meaningfully more chances, and on a 0.5 hits or 1.5 total bases line
 * that volume difference is most of the edge.
 */
function slotContext(slot: number): string {
  if (slot <= 2)
    return `Batting ${slot} is a volume tailwind: top-of-order hitters get roughly 0.7 more plate appearances per game than the bottom third, which matters most on low counting lines like 0.5 hits or 1.5 total bases.`;
  if (slot <= 5)
    return `Batting ${slot} is a normal middle-order volume spot, with run-producing chances but no unusual plate-appearance edge either way.`;
  return `Batting ${slot} is a volume HEADWIND: bottom-third hitters get roughly 0.7 fewer plate appearances per game than the top of the order. On a 0.5 hits or 1.5 total bases line that is a real reduction in chances, not a rounding error.`;
}
