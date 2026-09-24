import type { GameLogEntry, HitRateResult } from "../types.js";
import { seasonForDate } from "./seasonBoundary.js";
import { describeRecency, type SampleRecency } from "./sampleRecency.js";
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
  /** The recency assessment every other aggregator in this repo already returns. */
  recency: SampleRecency;
  /** The club's completed regular-season games, whole season, for context. */
  teamGamesInSeason: number;
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
 * PURE. How many REGULAR-SEASON games has this club actually completed in a window?
 *
 * Three filters, each load-bearing:
 *   gameType === 2   drops PRESEASON, which this endpoint includes. A preseason game
 *                    in the denominator understates every regular's availability.
 *   terminal state   drops scheduled games. A season schedule is the whole 82.
 *   date bounds      drops anything outside the window being measured.
 *
 * ============================================================================
 * `onOrAfter` EXISTS BECAUSE v2.10.0 SHIPPED WITH A PLAY RATE THAT WAS NONSENSE
 * ============================================================================
 *
 * MEASURED LIVE 2026-09-24, Frank Vatrano, the same request twice:
 *
 *   lookbackGames 10  ->  playRate 0.12, flag IRREGULAR
 *   lookbackGames 40  ->  playRate 0.49, flag IRREGULAR
 *
 * The rate tracked the LOOKBACK, not the player. The numerator stops at
 * targetAppearances by design, and the denominator was the club's whole completed
 * season, so the two measured different spans and the quotient meant nothing. Every
 * NHL hit rate therefore carried "Played 10 of 82 team games (12%) ... Check
 * availability before posting" no matter how durable the player was.
 *
 * WHY THAT IS WORSE THAN NO FLAG, in this repo's own words from v2.5.0, when the
 * IRREGULAR flag was crying wolf on Cam Schlittler: "a flag that cries wolf on healthy
 * starters trains the reader to ignore it, and its whole value is the real catches."
 * A warning that fires on everyone is indistinguishable from no warning, except that
 * it also costs the reader's attention.
 *
 * So the denominator is now the club's completed games INSIDE the window the counted
 * appearances actually span. "He played 10 of his team's last 11" is a fact about the
 * player; "10 of 82" was a fact about the lookback argument.
 */
export function countTeamGamesPlayed(
  games: { gameDate: string; gameType: number; gameState: string }[],
  onOrBefore: string,
  onOrAfter?: string
): number {
  return games.filter(
    (g) =>
      g.gameType === NHL_GAME_TYPE_REGULAR &&
      nhlSaysFinal(g.gameState) &&
      g.gameDate <= onOrBefore &&
      (onOrAfter === undefined || g.gameDate >= onOrAfter)
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
  // Full-season figure, kept for context and for the zero-appearance case.
  const teamGamesInSeason = countTeamGamesPlayed(clubGames, asOfDay);

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

  // PLAY RATE, OVER THE WINDOW THE SAMPLE ACTUALLY SPANS. See countTeamGamesPlayed
  // for the v2.10.0 bug this replaces: comparing a capped numerator against a whole
  // season made the rate a function of the lookback argument rather than of the player.
  //
  // The window starts at the OLDEST COUNTED APPEARANCE, so the player is present at
  // its left edge by construction. That is the intended question - "of his team's
  // games since then, how many did he play" - and it is why a mid-sample absence still
  // shows up while a short lookback no longer invents one.
  const countedDates = log
    .filter((l) => l.dataStatus === "value" && l.date)
    .map((l) => l.date)
    .sort();
  const windowStart = countedDates.length ? countedDates[0] : undefined;
  const teamGamesPlayed = windowStart
    ? countTeamGamesPlayed(clubGames, asOfDay, windowStart)
    : teamGamesInSeason;

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
      `GOALIE. Started ${appearances} of the ${teamGamesPlayed} team games since ${windowStart} ` +
      `(${(playRate * 100).toFixed(0)}%). ` +
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
      `Played ${appearances} of the ${teamGamesPlayed} team games since ${windowStart} ` +
      `(${(playRate * 100).toFixed(0)}%). ` +
      `Missing rows are DNPs - scratched, injured, or called up mid-season - and the rate below ` +
      `is computed only over the games he played. Check availability before posting.`;
  }

  const sampleSufficient = appearances >= minSufficient;

  /* ------------------------------------------------------------------------
   * STALENESS. THE GUARD ALREADY EXISTED AND THIS AGGREGATOR DID NOT CALL IT.
   *
   * services/sampleRecency.ts was built in v2.5.2 for exactly this failure, after a
   * Chris Bassitt screen presented ninety-six-day-old form as current with
   * seasonWarning: null. All four other aggregators - bdl, sgo, cfbd, cbbd - call
   * describeRecency. The NHL one shipped without it in v2.10.0.
   *
   * WHAT THAT COST, MEASURED LIVE 2026-09-24: a Vatrano rate built entirely from games
   * dated November 2025 to April 2026 came back with `seasonWarning: null` and
   * `currentSeasonGames: 40`. Both fields were CORRECT - the NHL season year does not
   * roll over until October, so a game in April 2026 really does belong to the season
   * labelled 2025, which was still the current one that day. And the answer was still
   * useless: it was five-month-old form, from a season that had ended, two weeks before
   * a new one started, and nothing in the response said so.
   *
   * That is the gap sampleRecency.ts opens its own header by describing: season
   * labelling cannot see a sample that is stale WITHIN its season. Hockey has the
   * longest exposure to it of any sport here, because the June-to-October offseason sits
   * entirely inside one season year.
   * --------------------------------------------------------------------------*/
  const recency = describeRecency(log, {}, asOf);

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
    // COMBINED, the same way cbbd and cfbd combine them: a caller that reads one
    // warning field must not miss a second one that also fired.
    sampleWarning:
      [
        sampleSufficient
          ? null
          : `SAMPLE OF ${appearances}. A rate on fewer than ${minSufficient} appearances is not evidence and must not be quoted as one.`,
        recency.warning,
      ]
        .filter(Boolean)
        .join(" ") || null,
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
    // STALENESS IS ROUTED INTO seasonWarning ON PURPOSE, not only into sampleWarning.
    // The tool contract that thread-writers follow is "if seasonWarning is non-null, do
    // NOT present the number as current-season form", and a sample from a season that
    // has ENDED needs exactly that treatment even when the season label says it is
    // current. The offseason case is named explicitly rather than left to the generic
    // prose, because "five months old" and "he missed six weeks in February" call for
    // different sentences in a thread.
    seasonWarning:
      [
        priorSeasonGames > 0
          ? `${priorSeasonGames} of these games are from a PRIOR season. Do not describe them as current form.`
          : null,
        recency.isStale && recency.daysSinceMostRecent !== null && recency.daysSinceMostRecent > 60
          ? `THIS SAMPLE IS NOT CURRENT FORM. The most recent counted game was ` +
            `${recency.daysSinceMostRecent} days ago (${log.find((l) => l.dataStatus === "value")?.date ?? "unknown"}). ` +
            `The NHL season label does not roll over until October, so these games can be ` +
            `reported as "current season" and still be from a season that has finished. Say ` +
            `"last season" in the thread, or wait for current-season games.`
          : null,
      ]
        .filter(Boolean)
        .join(" ") || null,
    recency,
    teamGamesInSeason,
    nhlPlayerId: player.playerId,
    matchedFields: [...matchedFields],
    isGoalie: player.isGoalie,
    seasonId,
    teamGamesPlayed,
  };
}
