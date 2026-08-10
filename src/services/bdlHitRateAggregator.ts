import type { BDLClient } from "./bdlClient.js";
import type { SportKey } from "../constants.js";
import type { GameLogEntry, HitRateResult } from "../types.js";
import { seasonForDate, summarizeSeasons } from "./seasonBoundary.js";
import { resolveStat, isStatSupported } from "./bdlStatMap.js";

/**
 * BALLDONTLIE-backed hit rate computation.
 *
 * WHY THIS EXISTS - THE MEASURED PROBLEM:
 *
 * The SGO path (services/hitRateAggregator.ts) computes a hit rate by fetching a
 * team's finalized events and reading the player's line out of event.results.
 * SGO bills per EVENT OBJECT returned, so collecting 15 appearances for one
 * player costs 30-140 objects, and every additional player on that team repeats
 * the same fetch.
 *
 * Measured 2026-08-10: one complete thread cost 211 entities, a 15-game slate
 * roughly 3,000, and daily builds projected to ~114,000 against a 100,000 monthly
 * cap. In other words the workflow did not fit the plan.
 *
 * BALLDONTLIE has NO monthly object cap. It rate-limits requests per minute only
 * (60/min on ALL-STAR, 600/min on GOAT). Its stats endpoint also returns rows for
 * ONE PLAYER directly, rather than requiring a whole team's game history to be
 * pulled and filtered - so the work is both uncapped and fundamentally smaller.
 *
 * OUTPUT SHAPE IS DELIBERATELY IDENTICAL to the SGO aggregator's HitRateResult.
 * tkb_screen_props, tkb_get_player_hit_rate and tkb_get_cover_player all read
 * these fields, so matching the contract means the data source can change without
 * touching any consumer.
 *
 * WHAT THIS PATH DOES BETTER, beyond cost:
 *   - Combo stats (Points + Rebounds, Pts+Reb+Ast) are computable, because every
 *     component sits on one row. The SGO path had to exclude them entirely since
 *     event.results carries no per-component breakdown.
 *   - Total bases is derivable from hit components when not exposed directly.
 *
 * WHAT IT CANNOT DO: BDL and SGO use different player ID spaces
 * ("KETEL_MARTE_1_MLB" vs an integer), so a name-based resolution step is
 * required. That is the one genuinely fragile link in this path, and it fails
 * loudly rather than silently - see resolveBdlPlayerID below.
 */

export type PlayerRole = "starting_pitcher" | "position_player";

interface RoleProfile {
  defaultAppearances: number;
  minSufficient: number;
}

const ROLE_PROFILES: Record<PlayerRole, RoleProfile> = {
  starting_pitcher: { defaultAppearances: 10, minSufficient: 5 },
  position_player: { defaultAppearances: 15, minSufficient: 8 },
};

export function inferPlayerRole(statID: string): PlayerRole {
  return statID.startsWith("pitching_") ? "starting_pitcher" : "position_player";
}

/**
 * Resolve an SGO player to a BDL numeric ID by name.
 *
 * THIS IS THE RISKIEST STEP IN THE WHOLE PATH and is written to fail rather than
 * guess. Resolving "Will Smith" or "Josh Bell" to the wrong player produces a
 * hit rate that is fully populated, plausible, and completely wrong - the exact
 * failure mode this connector's guardrails exist to prevent.
 *
 * Disambiguation uses the team name when more than one player matches. If the
 * ambiguity cannot be resolved, this throws and the caller falls back to SGO.
 */
export async function resolveBdlPlayerID(
  bdl: BDLClient,
  sport: SportKey,
  playerName: string,
  teamNameHint?: string
): Promise<{ id: number; matchedName: string; note: string | null }> {
  const results = await bdl.searchPlayers(sport, playerName);

  if (!results.data.length) {
    throw new Error(
      `No BALLDONTLIE player found matching "${playerName}" in ${sport.toUpperCase()}.`
    );
  }

  if (results.data.length === 1) {
    const p = results.data[0]!;
    return {
      id: p.id,
      matchedName: `${p.first_name} ${p.last_name}`,
      note: null,
    };
  }

  // Multiple matches - disambiguate on team, never on arbitrary ordering.
  if (teamNameHint) {
    const needle = teamNameHint.toLowerCase();
    const onTeam = results.data.filter((p) => {
      const t = p.team;
      if (!t) return false;
      const hay = [t.full_name, t.display_name, t.name, t.location, t.abbreviation]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle) || needle.includes((t.name ?? "").toLowerCase());
    });
    if (onTeam.length === 1) {
      const p = onTeam[0]!;
      return {
        id: p.id,
        matchedName: `${p.first_name} ${p.last_name}`,
        note: `Disambiguated ${results.data.length} name matches by team.`,
      };
    }
  }

  // Exact full-name match as a last resort before giving up.
  const exact = results.data.filter(
    (p) => `${p.first_name} ${p.last_name}`.toLowerCase() === playerName.toLowerCase()
  );
  if (exact.length === 1) {
    const p = exact[0]!;
    return {
      id: p.id,
      matchedName: `${p.first_name} ${p.last_name}`,
      note: `Resolved by exact name match among ${results.data.length} candidates.`,
    };
  }

  throw new Error(
    `AMBIGUOUS PLAYER: "${playerName}" matched ${results.data.length} BALLDONTLIE players in ` +
      `${sport.toUpperCase()} and could not be narrowed by team. Refusing to guess, since the ` +
      `wrong player would produce a plausible but completely wrong hit rate. ` +
      `Candidates: ${results.data.map((p) => `${p.first_name} ${p.last_name} (id ${p.id})`).join("; ")}`
  );
}

export async function getBdlPlayerHitRate(
  bdl: BDLClient,
  params: {
    sport: SportKey;
    playerName: string;
    statID: string;
    line: number;
    direction: "over" | "under";
    teamName?: string;
    bdlPlayerID?: number; // skip name resolution when already known
    lookbackGames?: number;
    seasons?: number[];
  }
): Promise<HitRateResult & { bdlPlayerID: number; statSource: string | null; resolutionNote: string | null }> {
  if (!isStatSupported(params.sport, params.statID)) {
    throw new Error(
      `Stat "${params.statID}" has no BALLDONTLIE mapping for ${params.sport.toUpperCase()}. ` +
        `Fall back to the SportsGameOdds path rather than substituting a value.`
    );
  }

  const role = inferPlayerRole(params.statID);
  const profile = ROLE_PROFILES[role];
  const targetAppearances = params.lookbackGames ?? profile.defaultAppearances;

  let bdlPlayerID = params.bdlPlayerID;
  let resolutionNote: string | null = null;
  if (!bdlPlayerID) {
    const resolved = await resolveBdlPlayerID(
      bdl,
      params.sport,
      params.playerName,
      params.teamName
    );
    bdlPlayerID = resolved.id;
    resolutionNote = resolved.note;
  }

  // Pull enough rows to cover the target. Pitchers appear far less often than
  // batters, but since BDL returns PLAYER rows (not team games), every row is an
  // appearance - so no over-fetch multiplier is needed the way the SGO path
  // required scanning ~5x team games for a starter.
  const perPage = Math.min(Math.max(targetAppearances * 2, 25), 100);
  const raw = await bdl.getPlayerGameStats(params.sport, {
    playerIDs: [bdlPlayerID],
    seasons: params.seasons,
    perPage,
  });

  const rows = (raw.data ?? []) as Record<string, unknown>[];

  // Newest first. BDL ordering is not contractually guaranteed, so sort rather
  // than trust it - the SGO path was burned by exactly this assumption.
  const sorted = [...rows].sort((a, b) => {
    const da = extractGameDate(a);
    const db = extractGameDate(b);
    return (db ? new Date(db).getTime() : 0) - (da ? new Date(da).getTime() : 0);
  });

  const log: GameLogEntry[] = [];
  let overHits = 0;
  let underHits = 0;
  let pushCount = 0;
  let appearances = 0;
  let gamesExcludedDNP = 0;
  let statSource: string | null = null;

  for (const row of sorted) {
    if (appearances >= targetAppearances) break;

    const { value, source } = resolveStat(params.sport, params.statID, row);
    if (source && !statSource) statSource = source;

    const date = extractGameDate(row) ?? "unknown";
    const season = date !== "unknown" ? seasonForDate(params.sport, date) : null;
    const opponent = extractOpponent(row);

    if (value === null) {
      gamesExcludedDNP++;
      log.push({
        eventID: String(row.game_id ?? row.id ?? "unknown"),
        date,
        opponent: opponent ?? "unknown",
        isHome: extractIsHome(row),
        statValue: null,
        ...(season ? { seasonYear: season.seasonYear } : {}),
      });
      continue;
    }

    appearances++;
    if (value > params.line) overHits++;
    else if (value < params.line) underHits++;
    else pushCount++;

    log.push({
      eventID: String(row.game_id ?? row.id ?? "unknown"),
      date,
      opponent: opponent ?? "unknown",
      isHome: extractIsHome(row),
      statValue: value,
      ...(season ? { seasonYear: season.seasonYear } : {}),
    });
  }

  const gamesConsidered = appearances;
  const gamesHit = params.direction === "over" ? overHits : underHits;
  const countedDates = log.filter((g) => g.statValue !== null).map((g) => g.date);
  const seasons = summarizeSeasons(params.sport, countedDates);

  const sufficient = appearances >= profile.minSufficient;
  const sampleWarning = !sufficient
    ? appearances === 0
      ? `NO SAMPLE. No usable stat rows found for ${params.playerName} across ${rows.length} ` +
        `BALLDONTLIE row(s). DO NOT WRITE REASONING AROUND THIS PROP. If rows were returned but ` +
        `none carried this stat, the field mapping for "${params.statID}" may be wrong - run ` +
        `tkb_debug_bdl_stats to inspect the real field names.`
      : `INSUFFICIENT SAMPLE: ${appearances} appearance(s), ${profile.minSufficient} needed for a ` +
        `${role.replace(/_/g, " ")}. A rate on ${appearances} game(s) is NOT a hit rate.`
    : seasons.warning;

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
    teamGamesScanned: rows.length,
    hitScanCeiling: rows.length >= perPage && appearances < targetAppearances,
    sampleSufficient: sufficient,
    sampleWarning,
    playerRole: role,
    recentAvailability: {
      gamesPlayed: appearances,
      teamGamesScanned: rows.length,
      playRate: rows.length > 0 ? appearances / rows.length : 0,
      // BDL returns only games the player actually appeared in, so a DNP ratio
      // cannot be computed here the way it could from team game logs. Reporting
      // OK would be a false all-clear, so this states the limitation instead.
      flag: role === "starting_pitcher" ? "ROTATION_NORMAL" : "OK",
      note:
        role === "starting_pitcher"
          ? null
          : `Playing-time risk is NOT assessed on this path. BALLDONTLIE returns only games ` +
            `the player appeared in, so DNPs are invisible here. For a player suspected of ` +
            `missing time, confirm the lineup separately.`,
    },
    currentSeasonGames: seasons.current,
    priorSeasonGames: seasons.prior,
    seasonsRepresented: seasons.seasonsRepresented,
    crossesSeasonBoundary: seasons.crossesSeasonBoundary,
    seasonWarning: seasons.warning,
    bdlPlayerID,
    statSource,
    resolutionNote,
  };
}

function extractGameDate(row: Record<string, unknown>): string | null {
  const game = row.game as Record<string, unknown> | undefined;
  const candidates = [row.date, row.game_date, game?.date, game?.game_date];
  for (const c of candidates) {
    if (typeof c === "string" && c.length >= 8) return c;
  }
  return null;
}

function extractOpponent(row: Record<string, unknown>): string | null {
  const game = row.game as Record<string, unknown> | undefined;
  if (!game) return null;
  const home = game.home_team as Record<string, unknown> | undefined;
  const away = game.visitor_team ?? game.away_team;
  const awayObj = away as Record<string, unknown> | undefined;
  const team = row.team as Record<string, unknown> | undefined;
  const teamID = team?.id;

  if (teamID && home?.id === teamID) {
    return String(awayObj?.full_name ?? awayObj?.display_name ?? awayObj?.name ?? "unknown");
  }
  if (teamID && awayObj?.id === teamID) {
    return String(home?.full_name ?? home?.display_name ?? home?.name ?? "unknown");
  }
  return null;
}

function extractIsHome(row: Record<string, unknown>): boolean {
  const game = row.game as Record<string, unknown> | undefined;
  const home = game?.home_team as Record<string, unknown> | undefined;
  const team = row.team as Record<string, unknown> | undefined;
  return Boolean(team?.id && home?.id === team.id);
}
