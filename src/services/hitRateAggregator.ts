import type { SGOClient } from "./sgoClient.js";
import type { SportKey } from "../constants.js";
import type { GameLogEntry, HitRateResult, SGOEvent } from "../types.js";
import { seasonForDate, summarizeSeasons } from "./seasonBoundary.js";
import { describeRecency, STARTING_PITCHER_THRESHOLDS } from "./sampleRecency.js";

/**
 * Builds a real recent-game-log hit-rate check for a player against a stat line.
 *
 * This is NOT a single API call - SGO has no "last N games for player X" endpoint.
 * The pipeline is:
 *   1. Fetch the player's team's recent finalized events (paginated)
 *   2. For each event, pull the player's value for the requested statID out of
 *      the event's `results` object
 *   3. Exclude games where the player has no recorded value (DNP/inactive)
 *   4. Tally hits vs. the line, report the REAL sample size
 *
 * FIXED 2026-08-09 - lookbackGames counted APPEARANCES AND DNPs TOGETHER.
 * The old loop broke on `log.length >= lookback`, and `log` had a row pushed for
 * every event including DNPs. A starting pitcher appears in roughly 1 of every 5
 * team games, so asking for 30 returned ~5 starts and 25 DNP rows. Recently
 * promoted arms returned 1 start or none at all, and the tool reported that as a
 * hit rate rather than as an unusable sample.
 *
 * lookbackGames now means APPEARANCES. The scan walks back through team games
 * until it has collected that many real appearances or hits maxTeamGamesScanned.
 */

export type PlayerRole = "starting_pitcher" | "position_player";

interface RoleProfile {
  defaultAppearances: number;
  defaultMaxScan: number;
  minSufficient: number;
}

/**
 * Appearance frequency drives how far back we must scan. A starter pitches every
 * fifth day; a batter plays nearly every day. One shared default cannot serve both.
 */
const ROLE_PROFILES: Record<PlayerRole, RoleProfile> = {
  // A starter pitches every 5th team game, so 10 starts needs ~50 team games of
  // scan. The 140 ceiling gives ~28 starts of runway before giving up.
  starting_pitcher: { defaultAppearances: 10, defaultMaxScan: 140, minSufficient: 5 },
  // Everyday players appear in nearly every team game, so the scan stays shallow.
  // NFL/CFB weekly schedules also fit here since one appearance per team game.
  position_player: { defaultAppearances: 15, defaultMaxScan: 30, minSufficient: 8 },
};

export function inferPlayerRole(statID: string, _sport: SportKey): PlayerRole {
  // The pitching_ prefix is the only reliable role signal SGO gives us.
  return statID.startsWith("pitching_") ? "starting_pitcher" : "position_player";
}

export async function getPlayerHitRate(
  sgo: SGOClient,
  params: {
    sport: SportKey;
    teamID: string;
    playerID: string;
    playerName: string;
    statID: string;
    line: number;
    direction: "over" | "under";
    lookbackGames?: number;      // NOW MEANS: player appearances to collect
    maxTeamGamesScanned?: number; // safety ceiling on the backward scan
  }
): Promise<HitRateResult> {
  const role = inferPlayerRole(params.statID, params.sport);
  const profile = ROLE_PROFILES[role];

  const targetAppearances = params.lookbackGames ?? profile.defaultAppearances;
  const maxScan = params.maxTeamGamesScanned ?? profile.defaultMaxScan;
  const leagueID = sgo.leagueIDFor(params.sport);

  // Must bound by date. A live test showed finalized=true with no date bound can
  // return games from a much earlier season - the API's default ordering for
  // finalized events is not most-recent-first and was confirmed NOT to be
  // (returned Sept 2024 games when today is Aug 2026). Bound to "before now",
  // pull a wide window, and sort ourselves rather than trusting API ordering.
  const now = new Date();
  const startsBefore = now.toISOString();
  const lookbackWindowStart = new Date(now);
  lookbackWindowStart.setDate(lookbackWindowStart.getDate() - 400);

  const events = await sgo.getAllEvents({
    leagueID,
    teamID: params.teamID,
    finalized: true,
    startsAfter: lookbackWindowStart.toISOString(),
    startsBefore,
    // This function only reads event.results, never odds - but SGO always includes
    // some odds data unless oddIDs is passed. Requesting a single near-universal
    // moneyline oddID shrinks the odds payload to at most one market instead of
    // 1000+. This is the real fix for the OOM risk on this path.
    oddIDs: "points-home-game-ml-home",
    limit: maxScan,
  });

  const sorted = [...events].sort((a, b) => {
    const dateA = a.status?.startsAt ? new Date(a.status.startsAt).getTime() : 0;
    const dateB = b.status?.startsAt ? new Date(b.status.startsAt).getTime() : 0;
    return dateB - dateA;
  });

  const log: GameLogEntry[] = [];
  let overHits = 0;
  let underHits = 0;
  let pushCount = 0;
  let gamesExcludedDNP = 0;
  let appearances = 0;
  let teamGamesScanned = 0;

  for (const event of sorted) {
    // FIXED: break on APPEARANCES collected, not total log rows.
    if (appearances >= targetAppearances) break;
    if (teamGamesScanned >= maxScan) break;

    teamGamesScanned++;

    const statValue = extractPlayerStat(event, params.playerID, params.statID);
    const isHome = event.teams.home.teamID === params.teamID;
    const opponentTeamID = isHome ? event.teams.away.teamID : event.teams.home.teamID;
    const opponentName =
      (isHome ? event.teams.away.names?.long : event.teams.home.names?.long) ??
      opponentTeamID;

    const gameDate = event.status?.startsAt ?? "unknown";
    const season = gameDate !== "unknown" ? seasonForDate(params.sport, gameDate) : null;

    if (statValue === null) {
      gamesExcludedDNP++;
      log.push({
        eventID: event.eventID,
        date: gameDate,
        opponent: opponentName,
        isHome,
        statValue: null,
        ...(season ? { seasonYear: season.seasonYear } : {}),
      });
      continue;
    }

    appearances++;

    // FIXED: a push on a whole-number line (outs at 15, hits at 1) was previously
    // scored as a miss on both sides. Count it separately.
    if (statValue > params.line) overHits++;
    else if (statValue < params.line) underHits++;
    else pushCount++;

    log.push({
      eventID: event.eventID,
      date: gameDate,
      opponent: opponentName,
      isHome,
      statValue,
      ...(season ? { seasonYear: season.seasonYear } : {}),
    });
  }

  const gamesConsidered = appearances;
  const gamesHit = params.direction === "over" ? overHits : underHits;
  const hitScanCeiling = teamGamesScanned >= maxScan && appearances < targetAppearances;

  const countedDates = log.filter((g) => g.statValue !== null).map((g) => g.date);
  const seasons = summarizeSeasons(params.sport, countedDates);

  const { sufficient, warning } = assessSample({
    appearances,
    role,
    minSufficient: profile.minSufficient,
    teamGamesScanned,
    hitScanCeiling,
    seasonWarning: seasons.warning,
  });

  // WITHIN-SEASON STALENESS. summarizeSeasons above only fires across a SEASON
  // boundary, so a sample built entirely from May and June reads as clean in
  // August. Appended rather than replacing, because an insufficient sample and a
  // stale one are different problems and a caller may be facing both at once.
  // A starting pitcher works every fifth day, so its gap tolerance is widened -
  // otherwise normal rotation rest would flag as an absence.
  const recency = describeRecency(
    log,
    role === "starting_pitcher" ? STARTING_PITCHER_THRESHOLDS : {}
  );
  const combinedWarning =
    [warning, recency.warning].filter(Boolean).join(" ") || null;

  return {
    playerName: params.playerName,
    statID: params.statID,
    line: params.line,
    direction: params.direction,
    gamesConsidered,
    gamesHit,
    gamesExcludedDNP,
    log,
    overHits,
    underHits,
    pushCount,
    teamGamesScanned,
    hitScanCeiling,
    sampleSufficient: sufficient,
    sampleWarning: combinedWarning,
    playerRole: role,
    recentAvailability: assessAvailability(appearances, teamGamesScanned, gamesExcludedDNP, role),
    currentSeasonGames: seasons.current,
    priorSeasonGames: seasons.prior,
    seasonsRepresented: seasons.seasonsRepresented,
    crossesSeasonBoundary: seasons.crossesSeasonBoundary,
    seasonWarning: seasons.warning,
  };
}

/**
 * A rate computed on 1-2 appearances is a data point, not evidence. Returning it
 * without a hard flag invites it being written up as a hit rate. The warning text
 * is deliberately blunt because it gets surfaced verbatim in the tool response.
 */
function assessSample(input: {
  appearances: number;
  role: PlayerRole;
  minSufficient: number;
  teamGamesScanned: number;
  hitScanCeiling: boolean;
  seasonWarning: string | null;
}): { sufficient: boolean; warning: string | null } {
  const roleLabel = input.role.replace(/_/g, " ");

  if (input.appearances === 0) {
    return {
      sufficient: false,
      warning:
        `NO SAMPLE. This player did not appear in any of the ${input.teamGamesScanned} ` +
        `team games scanned. DO NOT WRITE REASONING AROUND THIS PROP and do not ` +
        `quote a hit rate. Choose a different player or market.`,
    };
  }

  if (input.appearances < input.minSufficient) {
    const tail = input.hitScanCeiling
      ? `The scan ceiling of ${input.teamGamesScanned} team games was reached. Raise ` +
        `maxTeamGamesScanned if this player has a longer history.`
      : `The team's available history is exhausted. This is all the data that exists.`;
    return {
      sufficient: false,
      warning:
        `INSUFFICIENT SAMPLE: ${input.appearances} appearance(s) found, ` +
        `${input.minSufficient} needed for a ${roleLabel}. A rate on ` +
        `${input.appearances} game(s) is NOT a hit rate and must not be quoted as ` +
        `one. ${tail}`,
    };
  }

  if (input.seasonWarning) {
    return { sufficient: true, warning: input.seasonWarning };
  }

  return { sufficient: true, warning: null };
}

/**
 * Pull a single stat value for a player from an event's results object.
 * Returns null if the player has no recorded value (DNP/inactive) - NEVER coerce
 * to 0, since 0 is a real recorded value (0 hits) and distinct from not playing.
 */
const PERIOD_ID_FULL_GAME = "game";

/**
 * COMPOSITE STATS, DERIVED BY SUMMING COMPONENTS.
 *
 * MEASURED 2026-08-19. SportsGameOdds PRICES combination markets - its statID
 * reference lists points+rebounds+assists, batting_hits+runs+rbi and the rest -
 * but does NOT settle them: the composite key is absent from an event's results
 * object. Same player, same 30 events, forced to the SGO path:
 *
 *   points                    -> real values on all 9 games she appeared in
 *   points+rebounds+assists   -> null on all 30, INCLUDING those same 9
 *
 * The components are all present on those same events under the same playerID.
 * Napheesa Collier's last 9: points 19/20/17/22/21/18/16/15/24, rebounds
 * 6/9/8/6/8/8/5/6/10, assists 2/2/3/3/6/7/2/3/1. Summing gives
 * 27/31/28/31/35/33/23/24/35, which is an EXACT count, not an approximation.
 *
 * So "SGO cannot count combos" was only ever true of SGO's results object, never
 * of this code. Deriving here unlocks combo markets on the SGO path for every
 * sport. That matters most for WNBA and NCAAF, where BALLDONTLIE gates player
 * stats behind GOAT (see the tier-gate memo in bdlClient.ts) and SGO is the ONLY
 * path available.
 *
 * WHY CANDIDATE ARRAYS PER COMPONENT: same defensive pattern as bdlStatMap.ts.
 * MLB runs scored were confirmed live to sit under "points" - SGO's
 * winner-determining stat, which in baseball is runs - with Trent Grisham
 * returning 1/0/0/1/0/3 there. "batting_runs" is still tried first in case the
 * feed ever exposes the explicit name.
 *
 * WHY A MISSING COMPONENT RETURNS null RATHER THAN A PARTIAL SUM: a
 * half-computed combo is exactly the "fully populated, plausible, completely
 * wrong" failure this connector exists to prevent. null routes the game to the
 * DNP branch, excluding it from the sample instead of under-counting it.
 *
 * SAFE BECAUSE ZEROS ARE REAL: SGO stores a genuine 0 rather than omitting the
 * key, verified on Courtney Williams (0 points on 7/22) and Grisham (0 runs on
 * three separate dates). Were zeros omitted, every summed line would silently
 * drop a player's quiet games and inflate the rate.
 */
const COMPONENT_DERIVATIONS: Record<string, string[][]> = {
  // WNBA / NBA
  "points+rebounds": [["points"], ["rebounds"]],
  "points+assists": [["points"], ["assists"]],
  "rebounds+assists": [["rebounds"], ["assists"]],
  "points+rebounds+assists": [["points"], ["rebounds"], ["assists"]],
  "blocks+steals": [["blocks"], ["steals"]],
  // MLB
  "batting_hits+runs+rbi": [["batting_hits"], ["batting_runs", "points"], ["batting_RBI"]],
  "batting_runs+rbi": [["batting_runs", "points"], ["batting_RBI"]],
  // NFL / CFB
  "passing+rushing_yards": [["passing_yards"], ["rushing_yards"]],
  "rushing+receiving_yards": [["rushing_yards"], ["receiving_yards"]],
};

function extractPlayerStat(
  event: SGOEvent,
  playerID: string,
  statID: string
): number | null {
  const periodResults = event.results?.[PERIOD_ID_FULL_GAME];
  if (!periodResults) return null;

  const playerResults = periodResults[playerID];
  if (!playerResults) return null;

  const value = playerResults[statID];
  if (typeof value === "number") return value;

  // Composite market with no settled value. Sum its components instead, but only
  // if EVERY component resolves - see the note above on partial sums.
  const components = COMPONENT_DERIVATIONS[statID];
  if (!components) return null;

  let sum = 0;
  for (const candidates of components) {
    let resolved: number | null = null;
    for (const candidate of candidates) {
      const raw = playerResults[candidate];
      if (typeof raw === "number") {
        resolved = raw;
        break;
      }
    }
    if (resolved === null) return null;
    sum += resolved;
  }
  return sum;
}

/**
 * PLAYING-TIME FLAG
 *
 * A hit rate says nothing about whether the player will actually be in there. On
 * 2026-08-09 two props were nearly written up before the DNP pattern surfaced:
 * Bobby Witt Jr. had sat 7 of Kansas City's last 12 games, and Jose Ramirez showed
 * 11 DNPs in 15 Cleveland games (a player just back from something). Both facts
 * were visible only by manually reading the log array, one row at a time.
 *
 * This turns that into a one-line read. IRREGULAR is the signal to confirm the
 * posted lineup before locking the pick, not necessarily to discard it.
 *
 * Starting pitchers are exempt from the ratio test - a starter appearing in 20% of
 * team games is a healthy starter on normal rest, not a red flag.
 */
function assessAvailability(
  appearances: number,
  teamGamesScanned: number,
  dnpCount: number,
  role: PlayerRole
): {
  gamesPlayed: number;
  teamGamesScanned: number;
  playRate: number;
  flag: "OK" | "IRREGULAR" | "ROTATION_NORMAL";
  note: string | null;
} {
  const playRate = teamGamesScanned > 0 ? appearances / teamGamesScanned : 0;

  if (role === "starting_pitcher") {
    return {
      gamesPlayed: appearances,
      teamGamesScanned,
      playRate,
      flag: "ROTATION_NORMAL",
      note: null,
    };
  }

  if (playRate < 0.7) {
    return {
      gamesPlayed: appearances,
      teamGamesScanned,
      playRate,
      flag: "IRREGULAR",
      note:
        `PLAYING TIME RISK: appeared in only ${appearances} of the last ` +
        `${teamGamesScanned} team games (${dnpCount} DNPs). This player is not an ` +
        `everyday lock. CONFIRM THE POSTED LINEUP before using this prop, and do ` +
        `not describe the hit rate as current form without noting the missed time.`,
    };
  }

  return {
    gamesPlayed: appearances,
    teamGamesScanned,
    playRate,
    flag: "OK",
    note: null,
  };
}
