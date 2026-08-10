import type { BDLClient } from "./bdlClient.js";
import type { SportKey } from "../constants.js";
import type { GameLogEntry, HitRateResult } from "../types.js";
import { seasonForDate, summarizeSeasons, currentSeason } from "./seasonBoundary.js";
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
): Promise<{ id: number; matchedName: string; note: string | null; teamID?: number }> {
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
      teamID: p.team?.id,
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
        teamID: p.team?.id,
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
      teamID: p.team?.id,
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
    lookbackDays?: number;
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
  let bdlTeamID: number | undefined;
  if (!bdlPlayerID) {
    const resolved = await resolveBdlPlayerID(
      bdl,
      params.sport,
      params.playerName,
      params.teamName
    );
    bdlPlayerID = resolved.id;
    resolutionNote = resolved.note;
    bdlTeamID = resolved.teamID;
  }

  // ---- RECENCY + SEASON BOUNDING ----
  //
  // BDL stat rows carry only a bare game_id: no date, no opponent, no season.
  // Confirmed via live probe 2026-08-10. Left unbounded, the endpoint returns
  // rows in arbitrary order spanning multiple seasons, and a cross-check against
  // SGO on the same player and line disagreed (10 of 15 vs 11 of 15) precisely
  // because the two were grading different sets of games.
  //
  // Sorting cannot fix that on its own - with every date unknown the comparator
  // is a no-op. So the query itself is bounded to a recent window, and the rows
  // that come back are then joined against the games endpoint to recover real
  // dates. Both halves are necessary: bounding controls WHICH games, the join
  // makes ordering and season provenance possible.
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - (params.lookbackDays ?? 75));
  const startDate = windowStart.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);
  const season = params.seasons ?? [currentSeason(params.sport).seasonYear];

  // Paginated: BDL returns rows ASCENDING from season start, so a single page is
  // the OLDEST games. Fetching one page and sorting locally cannot recover recent
  // games that were never in the response.
  const rows = await bdl.getAllPlayerGameStats(params.sport, {
    playerIDs: [bdlPlayerID],
    seasons: season,
    startDate,
    endDate,
  });

  // ---- DATE RESOLUTION ----
  // Join stat rows to games so each row gets a real date and opponent.
  const gameDates = new Map<
    string,
    { date: string; opponent: string; isHome: boolean }
  >();
  try {
    const teamIDs = bdlTeamID ? [bdlTeamID] : undefined;
    const games = await bdl.getAllGames(params.sport, {
      teamIDs,
      seasons: season,
      startDate,
      endDate,
    });
    for (const g of games) {
      const gid = String((g as unknown as { id?: number }).id ?? "");
      if (!gid) continue;
      const home = g.home_team;
      // Field name varies: MLB has used away_team where NBA-style feeds use
      // visitor_team. Checking both stops opponents rendering as "unknown" on
      // half the log, which is what happened on the first dated run.
      const away =
        g.visitor_team ??
        (g as unknown as { away_team?: typeof g.home_team }).away_team;
      const isHome = bdlTeamID !== undefined && home?.id === bdlTeamID;
      const opp = isHome ? away : home;
      gameDates.set(gid, {
        date: g.date,
        opponent:
          (opp as { full_name?: string; display_name?: string; name?: string })?.full_name ??
          (opp as { display_name?: string })?.display_name ??
          (opp as { name?: string })?.name ??
          "unknown",
        isHome,
      });
    }
  } catch {
    // Swallowed deliberately - handled by the hard check below, which refuses to
    // return a rate rather than returning an unsorted one.
  }

  // HARD REFUSAL. An unsortable sample is not a recent-form hit rate, and
  // returning one anyway is the precise failure this connector exists to avoid:
  // a fully populated, plausible, wrong number. Better to fail and fall back to
  // SGO than to publish that.
  const datedRows = rows.filter((r) => gameDates.has(String(r.game_id ?? "")));
  if (rows.length > 0 && datedRows.length === 0) {
    throw new Error(
      `DATE RESOLUTION FAILED: ${rows.length} BALLDONTLIE stat row(s) returned for ` +
        `${params.playerName}, but none could be matched to a game date. Without dates the ` +
        `sample cannot be ordered by recency or checked for season contamination, so any ` +
        `"last N games" figure would be N arbitrary games rather than the most recent ones. ` +
        `Refusing to return a hit rate - fall back to SportsGameOdds.`
    );
  }

  // Newest first, now on real dates.
  const sorted = [...datedRows].sort((a, b) => {
    const da = gameDates.get(String(a.game_id ?? ""))?.date ?? "";
    const db = gameDates.get(String(b.game_id ?? ""))?.date ?? "";
    return new Date(db).getTime() - new Date(da).getTime();
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

    const resolvedGame = gameDates.get(String(row.game_id ?? ""));
    const date = resolvedGame?.date ?? "unknown";
    const season = date !== "unknown" ? seasonForDate(params.sport, date) : null;
    const opponent = resolvedGame?.opponent ?? null;

    if (value === null) {
      gamesExcludedDNP++;
      log.push({
        eventID: String(row.game_id ?? row.id ?? "unknown"),
        date,
        opponent: opponent ?? "unknown",
        isHome: resolvedGame?.isHome ?? false,
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
      isHome: resolvedGame?.isHome ?? false,
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
      ? `NO SAMPLE. No usable stat rows found for ${params.playerName} across ${datedRows.length} ` +
        `dated BALLDONTLIE row(s). DO NOT WRITE REASONING AROUND THIS PROP. If rows were returned but ` +
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
    teamGamesScanned: datedRows.length,
    hitScanCeiling: false,
    sampleSufficient: sufficient,
    sampleWarning,
    playerRole: role,
    recentAvailability: {
      gamesPlayed: appearances,
      teamGamesScanned: datedRows.length,
      playRate: datedRows.length > 0 ? appearances / datedRows.length : 0,
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



