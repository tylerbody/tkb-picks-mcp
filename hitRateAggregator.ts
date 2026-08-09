import type { SGOClient } from "./sgoClient.js";
import type { SportKey } from "../constants.js";
import type { GameLogEntry, HitRateResult, SGOEvent } from "../types.js";
import { seasonForDate, summarizeSeasons } from "./seasonBoundary.js";

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
    sampleWarning: warning,
    playerRole: role,
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
  return typeof value === "number" ? value : null;
}
