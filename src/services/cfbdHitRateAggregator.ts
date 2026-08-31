import type { CFBDClient, CfbdGameBoxScore, CfbdGameMeta } from "./cfbdClient.js";
import type { GameLogEntry, HitRateResult } from "../types.js";
import { lookupCfbdStat, isCfbdStatSupported, supportedCfbdStatIDs } from "./cfbdStatMap.js";
import { summarizeSeasons } from "./seasonBoundary.js";
import { describeRecency } from "./sampleRecency.js";

/**
 * COUNTED CFB HIT RATES FROM CollegeFootballData.
 *
 * WHY THIS IS A THIRD AGGREGATOR RATHER THAN A BRANCH IN AN EXISTING ONE.
 *
 * The SGO aggregator scans TEAM EVENTS backward through a date window and reads a
 * player's line out of each one. The BDL aggregator fetches ONE PLAYER'S rows and
 * joins them to a games list for dates. CFBD is a third shape again: box scores
 * arrive a WEEK AT A TIME, because that is the only unit that fits the call budget
 * (see CFBDClient - one request returns every game in a week).
 *
 * Forcing that into either existing aggregator would mean either fetching per game
 * (which exhausts a 1,000-a-month budget in a week) or pretending weeks are events.
 * Both are worse than a third file that says what it does.
 *
 * WHAT IT DELIBERATELY REUSES: summarizeSeasons and describeRecency. Those encode
 * hard-won rules about prior-season labelling and within-season staleness, and a CFB
 * rate needs both MORE than the other sports do, not less - in the opening weeks
 * every single CFB sample is prior-season by construction.
 */

/** Regular-season weeks to walk when reconstructing a season. */
const MAX_REGULAR_WEEKS = 15;

export interface CfbdHitRateParams {
  teamName: string;
  playerName: string;
  statID: string;
  line: number;
  direction: "over" | "under";
  /** Seasons to scan, newest first. Defaults to the prior season. */
  seasons: number[];
  /** Stop once this many appearances are collected. */
  targetAppearances?: number;
  minSufficient?: number;
}

/** Normalised comparison for team and player names. */
function norm(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

/**
 * Find a player's CFBD id by name within one team's box scores.
 *
 * REFUSES TO GUESS ON AMBIGUITY, for the reason v2.0.1 recorded: eighteen "Marte"
 * matches were correctly declined rather than resolved to the wrong player, because
 * a hit rate attached to the wrong man is worse than no hit rate. Same rule here.
 */
export function resolveCfbdPlayer(
  games: CfbdGameBoxScore[],
  teamName: string,
  playerName: string
): { id: string; name: string } | { error: string } {
  const wantTeam = norm(teamName);
  const wantPlayer = norm(playerName);
  const found = new Map<string, string>();

  for (const game of games) {
    for (const team of game.teams ?? []) {
      if (norm(team.team) !== wantTeam) continue;
      for (const category of team.categories ?? []) {
        for (const type of category.types ?? []) {
          for (const athlete of type.athletes ?? []) {
            if (norm(athlete.name) === wantPlayer) found.set(athlete.id, athlete.name);
          }
        }
      }
    }
  }

  if (found.size === 1) {
    const [id, name] = [...found.entries()][0];
    return { id, name };
  }
  if (found.size === 0) {
    return {
      error:
        `No CollegeFootballData player named "${playerName}" found on ${teamName} in ` +
        `the scanned weeks. Check the spelling against the roster, or the player may ` +
        `not have recorded a stat in any scanned game.`,
    };
  }
  return {
    error:
      `AMBIGUOUS PLAYER: ${found.size} players named "${playerName}" on ${teamName} ` +
      `(ids ${[...found.keys()].join(", ")}). Refusing to guess - a hit rate attached ` +
      `to the wrong player is worse than no hit rate.`,
  };
}

export async function getCfbdPlayerHitRate(
  cfbd: CFBDClient,
  params: CfbdHitRateParams
): Promise<HitRateResult & { cfbdPlayerID: string | null; matchedFields: string[] }> {
  if (!isCfbdStatSupported(params.statID)) {
    throw new Error(
      `Stat "${params.statID}" has no CollegeFootballData mapping. Supported: ` +
        `${supportedCfbdStatIDs().join(", ")}. Do NOT substitute a value.`
    );
  }

  const targetAppearances = params.targetAppearances ?? 15;
  const minSufficient = params.minSufficient ?? 8;

  // Walk newest season first, newest week first, so the sample is genuinely recent
  // rather than whatever arrives first. This is the v2.5.0 / v2.6.1 rule restated:
  // recency comes from the ORDER WE WALK, never from trusting provider ordering.
  const weeks: { year: number; week: number; seasonType: "regular" | "postseason" }[] = [];
  for (const year of params.seasons) {
    weeks.push({ year, week: 1, seasonType: "postseason" });
    for (let w = MAX_REGULAR_WEEKS; w >= 1; w--) {
      weeks.push({ year, week: w, seasonType: "regular" });
    }
  }

  // REAL DATES, JOINED BEFORE ANYTHING IS COUNTED.
  //
  // /games/players returns a bare numeric game id and nothing else identifying the
  // game. Without a date there is no sorting, no season attribution and no
  // staleness check - and critically, summarizeSeasons reports
  // crossesSeasonBoundary FALSE when it receives dates it cannot parse, so the
  // prior-season warning goes SILENT exactly when every game is prior-season.
  //
  // Caught by the first live run of this aggregator: fifteen correct 2025 values
  // returned with seasonWarning null. Same bug, same cause and same fix as v2.0.2
  // on the BDL path. One request per season, cached permanently.
  const gameDates = new Map<number, CfbdGameMeta>();
  for (const year of params.seasons) {
    try {
      const meta = await cfbd.getSeasonGames(year);
      for (const [id, g] of meta) gameDates.set(id, g);
    } catch {
      // Fall through - the hard refusal below catches an unusable result.
    }
  }

  const log: GameLogEntry[] = [];
  const matchedFields = new Set<string>();
  let overHits = 0;
  let underHits = 0;
  let pushCount = 0;
  let appearances = 0;
  let gamesScanned = 0;
  let playerID: string | null = null;

  for (const w of weeks) {
    if (appearances >= targetAppearances) break;

    let games: CfbdGameBoxScore[];
    try {
      // A PRIOR SEASON IS IMMUTABLE, so every week of it is cached permanently and
      // costs at most one request ever.
      games = await cfbd.getWeekPlayerStats({
        year: w.year,
        week: w.week,
        seasonType: w.seasonType,
        permanent: true,
      });
    } catch {
      // One unavailable week must not abort a season. Skipping is honest; the
      // sample size reported at the end reflects only what was actually read.
      continue;
    }

    if (!playerID) {
      const resolved = resolveCfbdPlayer(games, params.teamName, params.playerName);
      if ("error" in resolved) continue;
      playerID = resolved.id;
    }

    for (const game of games) {
      const team = (game.teams ?? []).find(
        (t) => norm(t.team) === norm(params.teamName)
      );
      if (!team) continue;

      gamesScanned++;
      const opponent =
        (game.teams ?? []).find((t) => norm(t.team) !== norm(params.teamName))?.team ??
        "unknown";

      const lookup = lookupCfbdStat(team.categories ?? [], playerID, params.statID);

      if (lookup.kind !== "value") {
        // A player who is not listed under this category simply did not record the
        // stat. Recorded as an absence, never as a zero.
        log.push({
          eventID: String(game.gameId),
          date: gameDates.get(game.gameId)?.startDate ?? "unknown",
          opponent,
          isHome: team.homeAway === "home",
          statValue: null,
          dataStatus: lookup.kind === "player_absent" ? "player_absent" : "stat_unsettled",
          seasonYear: w.year,
        });
        continue;
      }

      matchedFields.add(`${lookup.matchedCategory}/${lookup.matchedType}`);
      appearances++;
      if (lookup.value > params.line) overHits++;
      else if (lookup.value < params.line) underHits++;
      else pushCount++;

      log.push({
        eventID: String(game.gameId),
        date: gameDates.get(game.gameId)?.startDate ?? "unknown",
        opponent,
        isHome: team.homeAway === "home",
        statValue: lookup.value,
        dataStatus: "value",
        seasonYear: w.year,
      });
      if (appearances >= targetAppearances) break;
    }
  }

  const gamesHit = params.direction === "over" ? overHits : underHits;

  const countedDates = log.filter((g) => g.statValue !== null).map((g) => g.date);

  // HARD REFUSAL, not a warning. v2.0.2 established the rule on the BDL path: an
  // unsortable sample is not a recent-form hit rate, and returning one anyway is
  // the precise failure this connector exists to prevent - a fully populated,
  // plausible, wrong number. If nothing resolved to a date, the season and
  // staleness guardrails are both blind and CANNOT be trusted to fire.
  if (countedDates.length > 0 && countedDates.every((d) => d === "unknown")) {
    throw new Error(
      `DATE RESOLUTION FAILED: ${countedDates.length} CFBD stat row(s) for ` +
        `${params.playerName} could not be matched to a game date, so season ` +
        `provenance and staleness cannot be assessed. Refusing to return a rate - ` +
        `an unsortable sample is not a recent-form hit rate.`
    );
  }

  // Newest first, so the log reads the way every other path in this repo reads and
  // log[0] is genuinely the most recent appearance.
  log.sort((a, b) => {
    const ta = a.date === "unknown" ? 0 : new Date(a.date).getTime();
    const tb = b.date === "unknown" ? 0 : new Date(b.date).getTime();
    return tb - ta;
  });

  const seasons = summarizeSeasons("cfb", countedDates);
  const sufficient = appearances >= minSufficient;

  const sampleWarning = !playerID
    ? `NO SAMPLE. "${params.playerName}" was not found on ${params.teamName} in any ` +
      `scanned week. DO NOT WRITE REASONING AROUND THIS PROP.`
    : appearances === 0
      ? `NO SAMPLE. ${params.playerName} recorded no ${params.statID} in any of the ` +
        `${gamesScanned} scanned games. DO NOT WRITE REASONING AROUND THIS PROP.`
      : !sufficient
        ? `INSUFFICIENT SAMPLE: ${appearances} appearance(s), ${minSufficient} needed. ` +
          `A rate on ${appearances} game(s) is NOT a hit rate and must not be quoted as one.`
        : null;

  // EVERY CFB SAMPLE IS PRIOR-SEASON IN THE OPENING WEEKS. That is not a caveat to
  // bury; it is the single most important thing about this number, so it rides on
  // the warning the writer actually reads.
  const recency = describeRecency(log, {});
  const combinedWarning =
    [sampleWarning, seasons.warning, recency.warning].filter(Boolean).join(" ") || null;

  return {
    playerName: params.playerName,
    statID: params.statID,
    line: params.line,
    direction: params.direction,
    gamesConsidered: appearances,
    gamesHit,
    gamesExcludedDNP: log.filter((g) => g.dataStatus === "player_absent").length,
    log,
    overHits,
    underHits,
    pushCount,
    teamGamesScanned: gamesScanned,
    hitScanCeiling: false,
    sampleSufficient: sufficient,
    sampleWarning: combinedWarning,
    playerRole: "position_player",
    recentAvailability: {
      gamesPlayed: appearances,
      teamGamesScanned: gamesScanned,
      gamesWithData: gamesScanned,
      playRate: gamesScanned > 0 ? appearances / gamesScanned : 0,
      // CFBD lists a player only when he recorded something in that category, so a
      // "did not appear" here can mean a quiet game rather than an absence. Stating
      // that is better than an OK that would read as a confirmed clean record.
      flag: "UNKNOWN",
      note:
        `CollegeFootballData lists a player only in categories where he recorded a ` +
        `stat, so absence from a box score does not distinguish "did not play" from ` +
        `"had a quiet game". CONFIRM THE DEPTH CHART before using this prop.`,
    },
    currentSeasonGames: seasons.current,
    priorSeasonGames: seasons.prior,
    seasonsRepresented: seasons.seasonsRepresented,
    crossesSeasonBoundary: seasons.crossesSeasonBoundary,
    seasonWarning: seasons.warning,
    cfbdPlayerID: playerID,
    matchedFields: [...matchedFields],
  };
}
