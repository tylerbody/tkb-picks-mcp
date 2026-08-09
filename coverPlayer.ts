import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SGOClient } from "../services/sgoClient.js";
import type { BDLClient } from "../services/bdlClient.js";
import { SUPPORTED_SPORTS, type SportKey } from "../constants.js";
import type { BDLInjury, SGOEvent } from "../types.js";

/**
 * COVER PHOTO SUBJECT PICKER
 *
 * THE PROBLEM THIS SOLVES: every thread needs a graphic, and every graphic needs
 * one player who is (a) actually going to play, (b) recognisable enough to stop a
 * scroll, and (c) ideally attached to something that just happened. Doing that by
 * hand meant a schedule pull, an injury pull per team, and two or three web
 * searches per game. Across four WNBA games on 2026-08-09 that was over twenty
 * minutes, and it is the identical work every single day.
 *
 * WHY AVAILABILITY IS A HARD GATE RATHER THAN A RANKING INPUT: on that same
 * morning the obvious Aces graphic was A'ja Wilson, who was listed questionable
 * for rest. Two MLB names looked equally obvious and were worse: Bobby Witt Jr.
 * had sat 7 of Kansas City's last 12 games, and Jose Ramirez showed 11 DNPs in 15
 * Cleveland games. None of that was visible without reading raw game logs one row
 * at a time. A graphic built around a player who does not suit up is worse than no
 * graphic, because it publishes with the thread and cannot be quietly fixed.
 *
 * WHAT THIS RETURNS AND WHY: a primary pick, a backup ON THE OPPOSITE TEAM so a
 * late scratch does not kill the whole graphic, and an explicit `avoid` list with
 * reasons. The avoid list is the part that saves the most time - it surfaces the
 * traps that otherwise cost a full research cycle to discover.
 *
 * NOT A DATA SOURCE FOR PICKS. This ranks marketability and availability, not
 * betting value. Use tkb_screen_props for that.
 */

const RECENT_GAMES_WINDOW = 10;

/** Statuses that mean "do not build a graphic around this player". */
const HARD_OUT = ["out", "injured reserve", "il", "suspended", "doubtful"];
/** Statuses that mean "usable but flag it". */
const SOFT_RISK = ["questionable", "day-to-day", "day to day", "game-time decision", "probable"];

function resolveTeamName(injury: BDLInjury): string | null {
  const t = injury.player?.team;
  if (!t) return null;
  if (t.full_name) return t.full_name;
  if (t.display_name) return t.display_name;
  if (t.location && t.name) return `${t.location} ${t.name}`;
  if (t.name) return t.name;
  if (t.abbreviation) return t.abbreviation;
  return null;
}

function playerFullName(injury: BDLInjury): string {
  const p = injury.player;
  if (!p) return "";
  const first = (p as { first_name?: string }).first_name ?? "";
  const last = (p as { last_name?: string }).last_name ?? "";
  return `${first} ${last}`.trim().toLowerCase();
}

interface Candidate {
  playerName: string;
  playerID: string;
  teamID: string;
  teamName: string;
  gamesPlayedLast10: number;
  teamGamesSeen: number;
  injuryStatus: string | null;
  injuryNote: string | null;
  notableRecent: string | null;
  marketWeight: number;
  score: number;
  confidence: "high" | "medium" | "low";
  excludeReason: string | null;
}

export function registerCoverPlayerTool(
  server: McpServer,
  sgo: SGOClient,
  bdl: BDLClient
) {
  server.registerTool(
    "tkb_get_cover_player",
    {
      title: "Best cover-photo subject for a game",
      description: `Returns the player to build a thread graphic around: healthy, expected to play, recognisable, and ideally coming off something notable.

WHY THIS EXISTS: picking a graphic subject by hand means a schedule pull, an injury pull per team, and several web searches per game. This does it in one call.

AVAILABILITY IS A HARD GATE. A player listed OUT or DOUBTFUL is excluded outright. A player who has appeared in under 60% of his team's recent games is excluded with a reason, because a raw injury report will not catch a healthy player who is simply being sat.

RETURNS: a primary pick, a backup on the OPPOSITE team so a late scratch does not kill the graphic, and an 'avoid' list naming players who look like obvious choices but are not, with the reason for each.

Examples:
  - Use when: "who should I make the graphic for this game?"
  - Use when: building any pick thread that needs an image
  - Don't use when: choosing which prop to bet - use tkb_screen_props
  - Don't use when: you need full injury detail - use tkb_get_injuries

NOT a betting-value tool. It ranks marketability and availability only.`,
      inputSchema: {
        sport: z.enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]]),
        eventID: z.string().describe("SGO eventID from tkb_get_schedule."),
        preferTeam: z
          .enum(["home", "away", "either"])
          .default("either")
          .describe("Bias the primary pick toward one side, e.g. the team you're backing."),
        minPlayRate: z
          .number()
          .min(0)
          .max(1)
          .default(0.6)
          .describe(
            "Minimum share of recent team games the player appeared in. Below this they are excluded with a reason."
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
      const leagueID = sgo.leagueIDFor(input.sport as SportKey);

      const events = await sgo.getAllEvents({ leagueID, eventIDs: input.eventID });
      if (!events.length) {
        return {
          content: [
            { type: "text" as const, text: `No event found for eventID "${input.eventID}".` },
          ],
        };
      }

      const event = events[0]!;
      const homeID = event.teams.home.teamID;
      const awayID = event.teams.away.teamID;
      const teamNames: Record<string, string> = {
        [homeID]: event.teams.home.names?.long ?? homeID,
        [awayID]: event.teams.away.names?.long ?? awayID,
      };

      const roster = Object.values(event.players ?? {});
      if (roster.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No players attached to ${teamNames[awayID]} @ ${teamNames[homeID]} yet, so ` +
                `there is nothing to rank. SGO builds the roster from posted markets, so this ` +
                `means props are not priced yet rather than that the game has no players. ` +
                `Retry closer to game time.`,
            },
          ],
        };
      }

      // Injuries are pulled once for the league and matched locally. Two per-team
      // calls would be the obvious shape but doubles the upstream cost for data
      // that arrives in one payload anyway.
      let injuries: BDLInjury[] = [];
      try {
        injuries = await bdl.getAllInjuries(input.sport as SportKey);
      } catch {
        // An injury-feed outage must not take the whole tool down; it degrades to
        // availability-from-game-logs only, and that is stated in the output.
      }

      const injuryByName = new Map<string, BDLInjury>();
      for (const inj of injuries) {
        const name = playerFullName(inj);
        if (name) injuryByName.set(name, inj);
      }

      // Recent team games, used to measure who is actually being played. This is
      // the signal a pure injury report cannot give.
      const now = new Date();
      const windowStart = new Date(now);
      windowStart.setDate(windowStart.getDate() - 45);

      async function recentAppearances(teamID: string) {
        const teamEvents = await sgo.getAllEvents({
          leagueID,
          teamID,
          finalized: true,
          startsAfter: windowStart.toISOString(),
          startsBefore: now.toISOString(),
          oddIDs: "points-home-game-ml-home",
          limit: RECENT_GAMES_WINDOW,
        });
        return teamEvents.slice(0, RECENT_GAMES_WINDOW);
      }

      const [homeGames, awayGames] = await Promise.all([
        recentAppearances(homeID).catch(() => [] as SGOEvent[]),
        recentAppearances(awayID).catch(() => [] as SGOEvent[]),
      ]);

      const gamesByTeam: Record<string, SGOEvent[]> = {
        [homeID]: homeGames,
        [awayID]: awayGames,
      };

      /** Did this player record any stat in this game? */
      function appearedIn(ev: SGOEvent, playerID: string): boolean {
        const gameResults = ev.results?.["game"];
        if (!gameResults) return false;
        const line = gameResults[playerID];
        return !!line && Object.keys(line).length > 0;
      }

      /** Pull a headline number out of the most recent appearance, if there is one. */
      function notableFrom(
        games: SGOEvent[],
        playerID: string,
        sport: SportKey
      ): string | null {
        for (const ev of games) {
          const line = ev.results?.["game"]?.[playerID];
          if (!line) continue;

          const opp =
            ev.teams.home.teamID === playerID ? "" : ev.teams.away.names?.long ?? "";
          const date = ev.status?.startsAt?.slice(5, 10) ?? "";

          if (sport === "mlb") {
            const hr = line["batting_homeRuns"];
            const tb = line["batting_totalBases"];
            const k = line["pitching_strikeouts"];
            if (typeof hr === "number" && hr >= 1)
              return `${hr} HR on ${date}${opp ? ` vs ${opp}` : ""}`;
            if (typeof k === "number" && k >= 7)
              return `${k} strikeouts on ${date}`;
            if (typeof tb === "number" && tb >= 3)
              return `${tb} total bases on ${date}`;
          } else {
            const pts = line["points"];
            const reb = line["rebounds"];
            const ast = line["assists"];
            if (typeof pts === "number" && pts >= 20)
              return `${pts} points on ${date}`;
            if (typeof reb === "number" && reb >= 10)
              return `${reb} rebounds on ${date}`;
            if (typeof ast === "number" && ast >= 8)
              return `${ast} assists on ${date}`;
          }
        }
        return null;
      }

      // Fantasy-score line is a cheap proxy for who the market treats as a
      // headliner. It is already in the odds payload, so this costs nothing.
      const marketWeight = new Map<string, number>();
      for (const [oddID, odd] of Object.entries(event.odds ?? {})) {
        if (!oddID.startsWith("fantasyScore-")) continue;
        const entity = oddID.split("-")[1];
        const line = parseFloat(
          (odd as { fairOverUnder?: string; bookOverUnder?: string }).bookOverUnder ??
            (odd as { fairOverUnder?: string }).fairOverUnder ??
            ""
        );
        if (entity && !Number.isNaN(line)) {
          marketWeight.set(entity, Math.max(marketWeight.get(entity) ?? 0, line));
        }
      }

      const candidates: Candidate[] = roster.map((p) => {
        const games = gamesByTeam[p.teamID] ?? [];
        const played = games.filter((g) => appearedIn(g, p.playerID)).length;
        const teamGamesSeen = games.length;
        const playRate = teamGamesSeen > 0 ? played / teamGamesSeen : 1;

        const inj = injuryByName.get(p.name.toLowerCase());
        const rawStatus = (inj?.status ?? "").toLowerCase();
        const isHardOut = HARD_OUT.some((s) => rawStatus.includes(s));
        const isSoftRisk = SOFT_RISK.some((s) => rawStatus.includes(s));

        let excludeReason: string | null = null;
        if (isHardOut) {
          excludeReason = `listed ${inj?.status ?? "OUT"}`;
        } else if (teamGamesSeen > 0 && playRate < input.minPlayRate) {
          excludeReason = `appeared in only ${played} of the team's last ${teamGamesSeen} games`;
        }

        const notable = notableFrom(games, p.playerID, input.sport as SportKey);
        const weight = marketWeight.get(p.playerID) ?? 0;

        let score = 0;
        score += weight * 2; // market's own view of star power
        score += playRate * 20; // reliability of actually being in there
        if (notable) score += 15;
        if (isSoftRisk) score -= 25;
        if (input.preferTeam === "home" && p.teamID === homeID) score += 8;
        if (input.preferTeam === "away" && p.teamID === awayID) score += 8;

        const confidence: Candidate["confidence"] =
          isSoftRisk || playRate < 0.8 ? "medium" : teamGamesSeen === 0 ? "low" : "high";

        return {
          playerName: p.name,
          playerID: p.playerID,
          teamID: p.teamID,
          teamName: teamNames[p.teamID] ?? resolveTeamName(inj ?? ({} as BDLInjury)) ?? p.teamID,
          gamesPlayedLast10: played,
          teamGamesSeen,
          injuryStatus: inj?.status ?? null,
          injuryNote: (inj as { comment?: string; description?: string } | undefined)?.comment ??
            (inj as { description?: string } | undefined)?.description ??
            null,
          notableRecent: notable,
          marketWeight: weight,
          score,
          confidence,
          excludeReason,
        };
      });

      const usable = candidates
        .filter((c) => c.excludeReason === null)
        .sort((a, b) => b.score - a.score);

      const avoid = candidates
        .filter((c) => c.excludeReason !== null)
        .sort((a, b) => b.marketWeight - a.marketWeight)
        .slice(0, 6)
        .map((c) => ({
          playerName: c.playerName,
          teamName: c.teamName,
          reason: c.excludeReason,
        }));

      if (usable.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No player in ${teamNames[awayID]} @ ${teamNames[homeID]} cleared the ` +
                `availability gate. Everyone is either ruled out or has been playing ` +
                `irregularly.\n\n${JSON.stringify({ avoid }, null, 2)}`,
            },
          ],
          structuredContent: { primary: null, backup: null, avoid },
        };
      }

      const primary = usable[0]!;
      // Backup deliberately comes from the other team, so one scratch does not
      // invalidate both options.
      const backup =
        usable.find((c) => c.teamID !== primary.teamID) ?? usable[1] ?? null;

      const shape = (c: Candidate) => ({
        playerName: c.playerName,
        teamName: c.teamName,
        injuryStatus: c.injuryStatus,
        gamesPlayedLast10: `${c.gamesPlayedLast10} of ${c.teamGamesSeen}`,
        notableRecent: c.notableRecent,
        confidence: c.confidence,
      });

      const injuryNote =
        injuries.length === 0
          ? "\n\nNOTE: the injury feed returned nothing, so availability here is based on " +
            "game-log appearances only. Double-check the injury report before finalising."
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Cover subject for ${teamNames[awayID]} @ ${teamNames[homeID]}: ` +
              `${primary.playerName} (${primary.teamName}).` +
              (primary.notableRecent ? ` Recent: ${primary.notableRecent}.` : "") +
              (avoid.length
                ? `\n\n${avoid.length} player(s) excluded - see 'avoid' for why.`
                : "") +
              injuryNote +
              `\n\n${JSON.stringify(
                { primary: shape(primary), backup: backup ? shape(backup) : null, avoid },
                null,
                2
              )}`,
          },
        ],
        structuredContent: {
          matchup: `${teamNames[awayID]} @ ${teamNames[homeID]}`,
          primary: shape(primary),
          backup: backup ? shape(backup) : null,
          avoid,
        },
      };
    }
  );
}
