import type { GameLogEntry, HitRateResult } from "../types.js";
import { seasonForDate } from "./seasonBoundary.js";
import {
  NHL_GAME_TYPE_REGULAR,
  nhlSaysFinal,
  nhlSeasonId,
  normaliseNhlName,
  type NHLStatsClient,
  type NhlGameLogEntry,
  type NhlPlayerRef,
} from "./nhlStatsClient.js";
import { isNhlStatSupported, lookupNhlStat, nhlStatUnavailableReason, supportedNhlStatIDs } from "./nhlStatMap.js";

/**
 * COUNTED NHL HIT RATES, FROM THE LEAGUE'S OWN GAME LOG.
 *
 * ============================================================================
 * TWO REQUESTS, TOTAL. THIS IS THE CHEAPEST HIT-RATE PATH IN THE CONNECTOR
 * ============================================================================
 *
 *   /v1/player/{id}/game-log/{season}/2      the player's whole season
 *   /v1/club-schedule-season/{team}/{season} the play-rate denominator
 *
 * Every other path in this repo pages through games and reads players out of each
 * one. The SGO path bills per event object; BDL is throttled per minute; CFBD and CBBD
 * draw on one shared 1,000-call monthly pool. This costs two calls against an endpoint
 * with no key and no quota, and the second one exists only to keep an honest play rate.
 *
 * ============================================================================
 * A DNP IS AN ABSENT ROW, NOT A ZERO. SAME AS THE CBBD PATH
 * ============================================================================
 *
 * The game log contains only games the player appeared in. So:
 *
 *   row present, stat present   -> an appearance, counted
 *   row present, stat absent    -> appearance, stat unsettled, NOT a miss
 *   row absent                  -> a DNP. Scratched, injured, or a backup goalie
 *                                  who did not start
 *
 * This is why the club schedule is fetched. Without it a goalie who started three of
 * his team's last ten would report "cleared 30 saves in 2 of 3" with no sign that the
 * other seven games happened. GOALIES ARE THE SHARP EDGE HERE: a backup's rate is
 * arithmetically fine and practically useless, and the play-rate flag is the only thing
 * that says so.
 */

export interface NhlHitRateParams {
  /** SGO's player name, e.g. "Zach Benson". Matched against the club roster. */
  playerName: string;
  /** NHL three-letter club code, e.g. "BUF". */
  teamAbbrev: string;
  statID: string;
  line: number;
  direction: "over" | "under";
  /** Stop counting once this many appearances are collected, newest first. */
  targetAppearances?: number;
  minSufficient?: number;
  /** Overridable for tests. Defaults to now. */
  asOf?: Date;
}

export interface NhlHitRateExtras {
  nhlPlayerId: number | null;
  matchedFields: string[];
  /** True when the resolved player is a goalie, whose stat vocabulary differs. */
  isGoalie: boolean;
  seasonId: string;
  teamGamesPlayed: number;
}

/**
 * PURE. Which season id does this date belong to, in the NHL's own "20262027" form?
 *
 * Derived from seasonBoundary rather than from a second copy of "October starts the
 * season". Two copies of a boundary rule is how a March game gets filed under a season
 * that has not started.
 */
export function nhlSeasonIdForDate(dateISO: string): string | null {
  const info = seasonForDate("nhl", dateISO);
  return info ? nhlSeasonId(info.seasonYear) : null;
}

/**
 * PURE. Resolve an SGO player name against a club roster.
 *
 * WHOLE NORMALISED NAMES ONLY, never containment. The BDL team reconciler makes the
 * same choice and states the reason: containment turns one string into two players.
 * "Sebastian Aho" is TWO active NHL players on two different clubs, which is why this
 * takes a roster for ONE team rather than a league-wide index.
 *
 * LAST-NAME FALLBACK IS DELIBERATELY NARROW. It fires only when exactly one player on
 * the roster carries that surname. Two Ahos on one roster, or two Hughes brothers on
 * the same club, produce no match rather than a coin flip.
 */
export function resolveNhlPlayer(
  roster: NhlPlayerRef[],
  playerName: string
): NhlPlayerRef | null {
  const wanted = normaliseNhlName(playerName);
  if (!wanted) return null;

  const exact = roster.filter((p) => normaliseNhlName(p.fullName) === wanted);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;

  // Surname only, and only when it is unambiguous on this roster.
  const parts = playerName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const surname = normaliseNhlName(parts[parts.length - 1]);
  if (!surname) return null;
  const bySurname = roster.filter((p) => {
    const pp = p.fullName.trim().split(/\s+/);
    return normaliseNhlName(pp[pp.length - 1]) === surname;
  });
  return bySurname.length === 1 ? bySurname[0] : null;
}

/** Newest first. Provider ordering is never trusted; the date decides. */
export function sortLogNewestFirst(log: NhlGameLogEntry[]): NhlGameLogEntry[] {
  return [...log].sort((a, b) => (a.gameDate < b.gameDate ? 1 : a.gameDate > b.gameDate ? -1 : 0));
}

/**
 * PURE. How many REGULAR-SEASON games has this club actually completed, on or before
 * the given date?
 *
 * Three filters, each load-bearing:
 *   gameType === 2   drops PRESEASON, which this endpoint includes. A preseason game
 *                    in the denominator understates every regular's availability.
 *   terminal state   drops scheduled games. A season schedule is the whole 82.
 *   date bound       drops anything after the cutoff, so a mid-season rate is not
 *                    divided by games that have not been played.
 */
export function countTeamGamesPlayed(
  games: { gameDate: string; gameType: number; gameState: string }[],
  onOrBefore: string
): number {
  return games.filter(
    (g) => g.gameType === NHL_GAME_TYPE_REGULAR && nhlSaysFinal(g.gameState) && g.gameDate <= onOrBefore
  ).length;
}

/** Over/under/push against a line, with pushes counted rather than lost to a miss. */
function scoreAgainstLine(value: number, line: number) {
  if (value > line) return "over" as const;
  if (value < line) return "under" as const;
  return "push" as const;
}

export async function getNhlPlayerHitRate(
  nhl: NHLStatsClient,
  params: NhlHitRateParams
): Promise<HitRateResult & NhlHitRateExtras> {
  // REFUSE BEFORE FETCHING. An unmapped stat is a code-level fact, and spending two
  // requests to discover it would be waste plus a worse error message.
  if (!isNhlStatSupported(params.statID)) {
    const reason = nhlStatUnavailableReason(params.statID);
    throw new Error(
      reason
        ? `No counted NHL rate is available for "${params.statID}". ${reason}`
        : `Stat "${params.statID}" has no NHL game-log mapping. Supported: ${supportedNhlStatIDs().join(", ")}. Do NOT substitute a value.`
    );
  }

  const asOf = params.asOf ?? new Date();
  const asOfDay = asOf.toISOString().slice(0, 10);
  const seasonId = nhlSeasonIdForDate(asOfDay);
  if (!seasonId) {
    throw new Error(`Could not determine an NHL season for ${asOfDay}.`);
  }

  const targetAppearances = params.targetAppearances ?? 10;
  const minSufficient = params.minSufficient ?? 5;

  const roster = await nhl.getRoster(params.teamAbbrev, seasonId);
  const player = resolveNhlPlayer(roster, params.playerName);

  if (!player) {
    // NAME THE ROSTER THAT WAS SEARCHED. The CFB outage of v2.8.6 was invisible for
    // several releases because a failed name match looked exactly like an absent
    // player, so a miss here reports what it looked in and how many names were there.
    throw new Error(
      `"${params.playerName}" did not match any player on the ${params.teamAbbrev} roster ` +
        `for season ${seasonId} (${roster.length} players checked). Matching is on whole ` +
        `names, with a surname fallback only when it is unambiguous on that roster - two ` +
        `players sharing a surname produce no match rather than a guess. Check the spelling, ` +
        `and check the club: a traded player is on his NEW team's roster.`
    );
  }

  const rawLog = await nhl.getPlayerGameLog(player.playerId, seasonId, NHL_GAME_TYPE_REGULAR);
  const ordered = sortLogNewestFirst(rawLog).filter((e) => !e.gameDate || e.gameDate <= asOfDay);

  const clubGames = await nhl.getClubSchedule(params.teamAbbrev, seasonId);
  const teamGamesPlayed = countTeamGamesPlayed(clubGames, asOfDay);

  const log: GameLogEntry[] = [];
  const matchedFields = new Set<string>();
  let overHits = 0;
  let underHits = 0;
  let pushCount = 0;
  let appearances = 0;
  let statUnsettled = 0;

  for (const entry of ordered) {
    if (appearances >= targetAppearances) break;

    const lookup = lookupNhlStat(entry, params.statID);
    const seasonInfo = entry.gameDate ? seasonForDate("nhl", entry.gameDate) : null;
    const isHome = entry.homeRoadFlag === "H";
    const opponent = entry.opponentAbbrev ?? "";

    if (lookup.kind !== "value") {
      // APPEARED BUT THE STAT IS NOT THERE. Not a DNP and emphatically not a miss.
      statUnsettled++;
      log.push({
        eventID: String(entry.gameId),
        date: entry.gameDate,
        opponent,
        isHome,
        statValue: null,
        dataStatus: "stat_unsettled",
        seasonYear: seasonInfo?.seasonYear,
      });
      continue;
    }

    matchedFields.add(lookup.matchedField);
    appearances++;
    const outcome = scoreAgainstLine(lookup.value, params.line);
    if (outcome === "over") overHits++;
    else if (outcome === "under") underHits++;
    else pushCount++;

    log.push({
      eventID: String(entry.gameId),
      date: entry.gameDate,
      opponent,
      isHome,
      statValue: lookup.value,
      dataStatus: "value",
      seasonYear: seasonInfo?.seasonYear,
    });
  }

  const gamesHit = params.direction === "over" ? overHits : underHits;
  const seasonsRepresented = [
    ...new Set(log.map((l) => l.seasonYear).filter((y): y is number => typeof y === "number")),
  ].sort();
  const currentSeason = seasonForDate("nhl", asOfDay)?.seasonYear ?? null;
  const currentSeasonGames = log.filter((l) => l.seasonYear === currentSeason).length;
  const priorSeasonGames = log.length - currentSeasonGames;

  // PLAY RATE. Denominator is the club's completed regular-season games, which is why
  // the second request exists. Without it this would be appearances over appearances,
  // which is 1.0 for a scratched player and therefore worse than no number.
  const playRate = teamGamesPlayed > 0 ? appearances / teamGamesPlayed : 0;

  let flag: "OK" | "IRREGULAR" | "ROTATION_NORMAL" | "UNKNOWN";
  let note: string | null;
  if (teamGamesPlayed === 0) {
    flag = "UNKNOWN";
    note =
      `The ${params.teamAbbrev} have no completed regular-season games in ${seasonId} yet, so a ` +
      `play rate cannot be computed. Early-season and preseason games are excluded from this ` +
      `denominator deliberately.`;
  } else if (player.isGoalie) {
    // A GOALIE IS NOT AN IRREGULAR SKATER. Starting half his team's games makes a
    // goalie a starter, not a question mark, so the same threshold cannot be used.
    flag = playRate >= 0.4 ? "OK" : "ROTATION_NORMAL";
    note =
      `GOALIE. Started ${appearances} of ${teamGamesPlayed} team games (${(playRate * 100).toFixed(0)}%). ` +
      (playRate >= 0.4
        ? `That is a starter's workload.`
        : `That is a BACKUP or timeshare workload, and a saves line is only playable once the ` +
          `start is confirmed - hockey clubs often confirm a starter at warmups. A counted rate ` +
          `across a handful of starts is arithmetically fine and practically thin.`);
  } else if (playRate >= 0.85) {
    flag = "OK";
    note = null;
  } else {
    flag = "IRREGULAR";
    note =
      `Played ${appearances} of ${teamGamesPlayed} team games (${(playRate * 100).toFixed(0)}%). ` +
      `Missing rows are DNPs - scratched, injured, or called up mid-season - and the rate below ` +
      `is computed only over the games he played. Check availability before posting.`;
  }

  const sampleSufficient = appearances >= minSufficient;

  return {
    playerName: player.fullName,
    statID: params.statID,
    line: params.line,
    direction: params.direction,
    gamesConsidered: appearances,
    gamesHit,
    // A DNP is an ABSENT ROW here, so there is nothing to exclude: rows that exist are
    // appearances by definition. The DNP count lives in the play rate instead, and
    // saying zero rather than guessing keeps the two from being double-counted.
    gamesExcludedDNP: 0,
    log,
    overHits,
    underHits,
    pushCount,
    teamGamesScanned: teamGamesPlayed,
    hitScanCeiling: appearances >= targetAppearances,
    sampleSufficient,
    sampleWarning: sampleSufficient
      ? null
      : `SAMPLE OF ${appearances}. A rate on fewer than ${minSufficient} appearances is not evidence and must not be quoted as one.`,
    playerRole: "position_player",
    recentAvailability: {
      gamesPlayed: appearances,
      teamGamesScanned: teamGamesPlayed,
      gamesWithData: appearances,
      playRate,
      flag,
      note,
    },
    gamesStatUnsettled: statUnsettled,
    currentSeasonGames,
    priorSeasonGames,
    seasonsRepresented,
    crossesSeasonBoundary: seasonsRepresented.length > 1,
    seasonWarning:
      priorSeasonGames > 0
        ? `${priorSeasonGames} of these games are from a PRIOR season. Do not describe them as current form.`
        : null,
    nhlPlayerId: player.playerId,
    matchedFields: [...matchedFields],
    isGoalie: player.isGoalie,
    seasonId,
    teamGamesPlayed,
  };
}
