import type { SGOClient } from "./sgoClient.js";
import type { SportKey } from "../constants.js";
import type { GameLogEntry, HitRateResult, SGOEvent } from "../types.js";

/**
 * Builds a real recent-game-log hit-rate check for a player against a stat line.
 *
 * This is NOT a single API call - SGO has no "last N games for player X" endpoint.
 * The pipeline is:
 *   1. Fetch the player's team's recent finalized events (paginated)
 *   2. For each event, pull the player's value for the requested statID out of
 *      the event's `results` object
 *   3. Exclude games where the player has no recorded value (DNP/inactive) -
 *      counting those as "cleared" or "missed" would misrepresent the true sample
 *   4. Tally hits vs. the line, report the REAL sample size (not padded/shrunk
 *      to a fixed window)
 *
 * statID/periodID/statEntityID keying: results are structured as
 *   results[periodID][statEntityID][statID] = number
 * For player-level stats, statEntityID is the playerID. periodID for full-game
 * stats is typically "game" - confirm this on first live test since it's not
 * independently verified here.
 */
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
    lookbackGames?: number; // how many recent games to pull before filtering DNPs
  }
): Promise<HitRateResult> {
  const lookback = params.lookbackGames ?? 10;
  const leagueID = sgo.leagueIDFor(params.sport);

  // Pull recent finalized events for this team. CRITICAL: must bound by date -
  // a live test showed that fetching finalized=true with no date bound and a
  // small limit can return games from a much earlier season (the underlying API's
  // default ordering for finalized events is not guaranteed to be most-recent-first,
  // and was confirmed NOT to be during testing - it returned Sept 2024 games when
  // today's date is Aug 2026). Explicitly bound to "before now" and pull a wider
  // window, relying on our own sort (below) rather than trusting API ordering.
  const now = new Date();
  const startsBefore = now.toISOString();
  // 220 days back is roughly a full MLB season's worth of games for one team;
  // generous enough to always find `lookback` real games even for a team with
  // many DNPs for this player, without pulling multiple seasons of history.
  const lookbackWindowStart = new Date(now);
  lookbackWindowStart.setDate(lookbackWindowStart.getDate() - 220);

  const events = await sgo.getAllEvents({
    leagueID,
    teamID: params.teamID,
    finalized: true,
    startsAfter: lookbackWindowStart.toISOString(),
    startsBefore,
    limit: Math.max(lookback * 3, 30),
  });

  // Events should already come back most-recent-first from the API, but sort
  // defensively by start date descending in case that's not guaranteed.
  const sorted = [...events].sort((a, b) => {
    const dateA = a.status?.startsAt ? new Date(a.status.startsAt).getTime() : 0;
    const dateB = b.status?.startsAt ? new Date(b.status.startsAt).getTime() : 0;
    return dateB - dateA;
  });

  const log: GameLogEntry[] = [];
  let gamesHit = 0;
  let gamesExcludedDNP = 0;

  for (const event of sorted) {
    if (log.length >= lookback) break;

    const statValue = extractPlayerStat(event, params.playerID, params.statID);
    const isHome = event.teams.home.teamID === params.teamID;
    const opponentTeamID = isHome ? event.teams.away.teamID : event.teams.home.teamID;
    const opponentName =
      (isHome ? event.teams.away.names?.long : event.teams.home.names?.long) ??
      opponentTeamID;

    if (statValue === null) {
      gamesExcludedDNP++;
      log.push({
        eventID: event.eventID,
        date: event.status?.startsAt ?? "unknown",
        opponent: opponentName,
        isHome,
        statValue: null,
      });
      continue;
    }

    const hit =
      params.direction === "over" ? statValue > params.line : statValue < params.line;
    if (hit) gamesHit++;

    log.push({
      eventID: event.eventID,
      date: event.status?.startsAt ?? "unknown",
      opponent: opponentName,
      isHome,
      statValue,
    });
  }

  const gamesConsidered = log.filter((g) => g.statValue !== null).length;

  return {
    playerName: params.playerName,
    statID: params.statID,
    line: params.line,
    direction: params.direction,
    gamesConsidered,
    gamesHit,
    gamesExcludedDNP,
    log,
  };
}

/**
 * Pull a single stat value for a player from an event's results object.
 * Returns null if the player has no recorded value for this stat in this event
 * (did not play, inactive, etc.) - NEVER coerce this to 0, since 0 could be a
 * real recorded value (e.g. 0 hits) vs. no game played at all being a different thing.
 *
 * UNVERIFIED: the exact periodID used for full-game stats (assumed "game" here).
 * Confirm against a live event response and adjust PERIOD_ID_FULL_GAME if wrong.
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
