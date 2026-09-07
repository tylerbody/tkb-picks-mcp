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
  /**
   * How many TEAM games pass per one appearance by this role. Used to size the
   * lookback WINDOW, which is what actually controls both cost and recency.
   */
  teamGamesPerAppearance: number;
}

/**
 * Roughly how many days pass between a team's games, per sport. Used only to
 * translate "we need about N team games" into a date window.
 *
 * Approximations on purpose, and deliberately generous. Undersizing the window
 * loses recent games; oversizing it costs a few extra event objects. Those are
 * not symmetric errors.
 */
const DAYS_PER_TEAM_GAME: Record<SportKey, number> = {
  mlb: 1.25,
  wnba: 2.6,
  nfl: 7.5,
  cfb: 7.5,
  // Tennis never reaches this aggregator - the capability guard in tools/hitRate.ts
  // refuses first. Present so the table stays exhaustive over SportKey.
  atp: 1,
  wta: 1,
};

/**
 * Appearance frequency drives how far back we must scan. A starter pitches every
 * fifth day; a batter plays nearly every day. One shared default cannot serve both.
 */
const ROLE_PROFILES: Record<PlayerRole, RoleProfile> = {
  // A starter pitches every 5th team game, so 10 starts needs ~50 team games of
  // scan. The 140 ceiling gives ~28 starts of runway before giving up.
  starting_pitcher: {
    defaultAppearances: 10,
    defaultMaxScan: 140,
    minSufficient: 5,
    teamGamesPerAppearance: 5,
  },
  // Everyday players appear in nearly every team game, so the scan stays shallow.
  // NFL/CFB weekly schedules also fit here since one appearance per team game.
  position_player: {
    defaultAppearances: 15,
    defaultMaxScan: 30,
    minSufficient: 8,
    teamGamesPerAppearance: 1,
  },
};

export function inferPlayerRole(statID: string, _sport: SportKey): PlayerRole {
  // The pitching_ prefix is the only reliable role signal SGO gives us.
  return statID.startsWith("pitching_") ? "starting_pitcher" : "position_player";
}

/**
 * How far back to look, in days, and roughly how many team games that covers.
 *
 * EXPORTED SO IT CAN BE TESTED WITHOUT A NETWORK. The bug this replaced shipped
 * because the sizing logic lived inline inside a function that needs an SGO
 * client, so nothing could assert on it. A cost change that alters WHICH data
 * comes back is a correctness change and needs a test.
 */
/**
 * THE OPENING-WEEKS PROBLEM, AND WHY THIS IS ONE FLAG RATHER THAN TWO NUMBERS.
 *
 * sizeLookbackWindow is built for a season in progress. An NFL position player
 * needs ~23 team games, which at 7.5 days a game is a 173-day window. That is
 * correct in November and useless in Week 1: 173 days before the 2026 opener is
 * mid-March 2026, which is empty offseason, so the window returns three preseason
 * games in which the starters sat.
 *
 * MEASURED 2026-08-31: tkb_screen_props on the Week 1 opener screened 70 priced
 * markets and qualified ZERO, because not one of them had a computable rate. That
 * is the identical shape of the CFB Week 0 failure that produced tkb_get_prop_board
 * in v2.6.4 - a full board discarded at the last step and reported as an answer.
 *
 * Widening to the 400-day ceiling reaches 2025 and returns real samples
 * (Jaxon Smith-Njigba, 14 of 21 on receiving yards, sampleSufficient true).
 *
 * WHY BOTH NUMBERS ARE NEEDED, which is exactly why this is a flag: raising
 * lookbackGames alone is silently clamped by the position_player defaultMaxScan of
 * 30, capping the window at 225 days. 225 days lands in January 2026, which
 * catches the NFL PLAYOFFS and misses the entire regular season - a half-applied
 * widening that looks like it worked. A single boolean cannot be half-applied.
 *
 * TAKE THIS OFF AROUND WEEK 5. Two independent reasons converge: cost roughly
 * doubles once a 400-day window holds a full prior season PLUS the current one,
 * and per seasonBoundary.ts current-season form overtakes prior-season form four
 * to six games in. Leaving it on past that point is both more expensive and less
 * accurate.
 */
export const PRIOR_SEASON_LOOKBACK = {
  lookbackGames: 40,
  maxTeamGamesScanned: 100,
} as const;

/** The window cap, in days. Exported so a test can assert the flag actually reaches it. */
export const MAX_WINDOW_DAYS = 400;

export function sizeLookbackWindow(params: {
  sport: SportKey;
  targetAppearances: number;
  teamGamesPerAppearance: number;
  maxScan: number;
}): { teamGamesNeeded: number; windowDays: number } {
  // Headroom for DNPs and rest days, bounded by the caller's safety ceiling.
  const teamGamesNeeded = Math.min(
    Math.ceil(params.targetAppearances * params.teamGamesPerAppearance * 1.5),
    params.maxScan
  );
  const windowDays = Math.min(
    MAX_WINDOW_DAYS,
    Math.max(30, Math.ceil(teamGamesNeeded * DAYS_PER_TEAM_GAME[params.sport]))
  );
  return { teamGamesNeeded, windowDays };
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

  // ---- WINDOW SIZING IS THE COST CONTROL. NOT A PAGE OR EVENT CAP. ----
  //
  // SGO's ordering for finalized events is confirmed NOT to be most-recent-first,
  // so the ONLY safe way to get a player's recent games is to fetch the whole
  // window and sort locally. That makes any event ceiling actively dangerous: it
  // truncates to whatever the API happened to return first, which is routinely
  // the OLDEST games in the window.
  //
  // v2.6.0 LEARNED THIS THE HARD WAY. Capping the fetch at maxScan events against
  // the old fixed 400-day window returned Spencer Torkelson's August 2025 games
  // on 24 Aug 2026 - fifteen real games, correctly counted, exactly one year
  // stale. Same failure as the Alejandro Kirk case in v2.5.0, on a different path.
  //
  // v2.5.0 already established the correct fix for that class of bug, in the
  // availability probe: "recency comes from the date bound rather than trusting
  // API ordering". Applying the same rule here. The window is sized to hold
  // roughly the number of team games this role actually needs, so exhausting it
  // is BOTH correct and cheap - a 400-day MLB window held 200+ games, a 30-day
  // one holds about 26.
  const now = new Date();
  const startsBefore = now.toISOString();

  const { teamGamesNeeded, windowDays } = sizeLookbackWindow({
    sport: params.sport,
    targetAppearances,
    teamGamesPerAppearance: profile.teamGamesPerAppearance,
    maxScan,
  });
  const lookbackWindowStart = new Date(now);
  lookbackWindowStart.setDate(lookbackWindowStart.getDate() - windowDays);

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
    limit: 100,
    // A SAFETY VALVE, NOT THE COST CONTROL. Set deliberately ABOVE what the sized
    // window can hold, so it never truncates a window and never silently drops
    // recent games. The window is what bounds cost; this only stops a runaway if
    // the window estimate is badly wrong for some sport or schedule quirk.
    maxEvents: Math.max(teamGamesNeeded * 3, 60),
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
  // GAMES THE PROVIDER HAS NO BOX SCORE FOR. Deliberately NOT counted as DNPs -
  // see GameDataStatus in types.ts. These are excluded from the playing-time
  // denominator entirely, because a game with no data says nothing either way
  // about whether this player was on the field.
  let gamesWithoutBoxScore = 0;
  let gamesStatUnsettled = 0;
  let appearances = 0;
  let teamGamesScanned = 0;

  for (const event of sorted) {
    // FIXED: break on APPEARANCES collected, not total log rows.
    if (appearances >= targetAppearances) break;
    if (teamGamesScanned >= maxScan) break;

    teamGamesScanned++;

    const lookup = lookupPlayerStat(event, params.playerID, params.statID);
    const isHome = event.teams.home.teamID === params.teamID;
    const opponentTeamID = isHome ? event.teams.away.teamID : event.teams.home.teamID;
    const opponentName =
      (isHome ? event.teams.away.names?.long : event.teams.home.names?.long) ??
      opponentTeamID;

    const gameDate = event.status?.startsAt ?? "unknown";
    const season = gameDate !== "unknown" ? seasonForDate(params.sport, gameDate) : null;

    if (lookup.kind !== "value") {
      // ONLY "player_absent" IS A DNP. A missing box score and an unsettled stat
      // are provider coverage gaps, and counting them as missed games is what
      // produced a 0.2 play rate for a quarterback who started every game.
      if (lookup.kind === "player_absent") gamesExcludedDNP++;
      else if (lookup.kind === "no_box_score") gamesWithoutBoxScore++;
      else gamesStatUnsettled++;

      log.push({
        eventID: event.eventID,
        date: gameDate,
        opponent: opponentName,
        isHome,
        statValue: null,
        dataStatus: lookup.kind,
        ...(season ? { seasonYear: season.seasonYear } : {}),
      });
      continue;
    }

    const statValue = lookup.value;
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
      dataStatus: "value",
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
    windowDays,
    gamesWithoutData: gamesWithoutBoxScore + gamesStatUnsettled,
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
  // A COVERAGE GAP IS NOT A PLAYING-TIME STORY, and it must not be silent either.
  // If most of the scanned window has no box score, the honest answer is that this
  // provider cannot describe this player's form, not that he barely played.
  const gamesWithoutData = gamesWithoutBoxScore + gamesStatUnsettled;
  const coverageWarning =
    gamesWithoutData > 0
      ? `PROVIDER COVERAGE GAP: ${gamesWithoutData} of the ${teamGamesScanned} team ` +
        `games scanned carry no box score for this stat ` +
        `(${gamesWithoutBoxScore} with no player results at all, ` +
        `${gamesStatUnsettled} where the player appears but the stat is unsettled). ` +
        `Those games are NOT counted as DNPs and are excluded from the play-rate ` +
        `denominator, because missing data says nothing about whether he played. ` +
        `The counted sample is drawn only from the ${teamGamesScanned - gamesWithoutData} ` +
        `game(s) that do carry data.`
      : null;

  const combinedWarning =
    [warning, recency.warning, coverageWarning].filter(Boolean).join(" ") || null;

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
    recentAvailability: assessAvailability(
      appearances,
      teamGamesScanned,
      gamesExcludedDNP,
      gamesWithoutBoxScore + gamesStatUnsettled,
      role
    ),
    gamesWithoutBoxScore,
    gamesStatUnsettled,
    coverageWarning,
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
  windowDays: number;
  gamesWithoutData: number;
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
    // WHY THIS WORDING CHANGED (v2.7.0). This branch used to read "The team's
    // available history is exhausted. This is all the data that exists." That was
    // written when cost was controlled by an EVENT CEILING, where not hitting the
    // ceiling really did mean the history had run out. v2.6.1 replaced the ceiling
    // with a sized WINDOW and did not revisit this string, so ever since, a window
    // that simply did not reach far enough has been reported as an absence of data.
    //
    // It is a confident, checkable, wrong claim, and it cost real time: the empty
    // NFL and CFB samples of 2026-08-31 were read as "SGO holds no prior season",
    // when in fact widening the window to its 400-day ceiling returned the entire
    // 2025 season for both. Same lesson v2.6.0 named - the fix was right, the audit
    // was scoped to the file the symptom appeared in.
    const tail = input.hitScanCeiling
      ? `The scan ceiling of ${input.teamGamesScanned} team games was reached. Raise ` +
        `maxTeamGamesScanned if this player has a longer history.`
      : input.gamesWithoutData > 0
        ? `The ${input.windowDays}-day lookback window held ${input.teamGamesScanned} team ` +
          `game(s), but ${input.gamesWithoutData} of them carry no box score for this stat. ` +
          `This is a PROVIDER COVERAGE GAP, not proof the games were missed. Widening the ` +
          `window will not help if the provider does not settle this stat for this sport.`
        : `The ${input.windowDays}-day lookback window contained no further games. This is ` +
          `the limit of the WINDOW, not necessarily of the provider's history - raise ` +
          `lookbackGames and maxTeamGamesScanned to reach further back (the window is ` +
          `capped at 400 days).`;
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

/**
 * A NULL IS THREE DIFFERENT ANSWERS. See GameDataStatus in types.ts for the
 * measured case that forced this apart (Dante Moore, 12 started games reported as
 * 12 DNPs).
 *
 * THE DISCRIMINATOR IS COMPUTED FROM THE EVENT, NOT ASSUMED. Rather than hardcode
 * what a CFB results object looks like, this asks the data: does this period carry
 * player-keyed entries for ANYONE on the event roster? If it carries none, the
 * provider has no box score for this game and no conclusion about any individual
 * can be drawn from it. If it carries entries for others but not this player, that
 * is a genuine absence. Deriving it this way means the check keeps working when a
 * provider changes shape, which is the failure mode this repo keeps hitting.
 */
export type StatLookup =
  | { kind: "value"; value: number }
  | { kind: "no_box_score" }
  | { kind: "player_absent" }
  | { kind: "stat_unsettled" };

export function lookupPlayerStat(
  event: SGOEvent,
  playerID: string,
  statID: string
): StatLookup {
  const periodResults = event.results?.[PERIOD_ID_FULL_GAME];
  if (!periodResults) return { kind: "no_box_score" };

  // Does this game carry player-level results for ANYONE? event.players is the
  // roster SGO attached to the event, so it is the right set to test against.
  const rosterIDs = Object.keys(event.players ?? {});
  const carriesAnyPlayerResults = rosterIDs.some(
    (id) => periodResults[id] !== undefined
  );
  if (!carriesAnyPlayerResults) return { kind: "no_box_score" };

  const playerResults = periodResults[playerID];
  if (!playerResults) return { kind: "player_absent" };

  const value = playerResults[statID];
  if (typeof value === "number") return { kind: "value", value };

  // Composite market with no settled value. Sum its components instead, but only
  // if EVERY component resolves - see the note above on partial sums.
  const components = COMPONENT_DERIVATIONS[statID];
  // The player IS in this box score, so this is an unsettled stat rather than an
  // absence. Reporting it as a DNP would understate his playing time.
  if (!components) return { kind: "stat_unsettled" };

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
    if (resolved === null) return { kind: "stat_unsettled" };
    sum += resolved;
  }
  return { kind: "value", value: sum };
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
/**
 * EXPORTED SO IT CAN BE TESTED WITHOUT A NETWORK, for the reason v2.6.1 learned the
 * hard way and v2.6.3 restated: logic that changes WHICH DATA REACHES THE USER is
 * correctness logic, and burying it inside a function that needs an API client makes
 * it unassertable. The 91-test suite passed against the broken v2.6.0 window for
 * exactly that reason.
 */
export function assessAvailability(
  appearances: number,
  teamGamesScanned: number,
  dnpCount: number,
  gamesWithoutData: number,
  role: PlayerRole
): {
  gamesPlayed: number;
  teamGamesScanned: number;
  gamesWithData: number;
  playRate: number;
  flag: "OK" | "IRREGULAR" | "ROTATION_NORMAL" | "UNKNOWN";
  note: string | null;
} {
  // ONLY GAMES THAT ACTUALLY CARRY DATA CAN SPEAK TO PLAYING TIME. Dividing by
  // every scanned game counted provider coverage gaps as missed games, which is
  // how a quarterback who started 15 of 15 was reported at a 0.2 play rate.
  const gamesWithData = Math.max(0, teamGamesScanned - gamesWithoutData);
  const playRate = gamesWithData > 0 ? appearances / gamesWithData : 0;

  // NO DATA IS NOT A CLEAN BILL OF HEALTH EITHER. With nothing to measure, the
  // honest answer is that availability is unknown, not OK.
  if (gamesWithData === 0) {
    return {
      gamesPlayed: appearances,
      teamGamesScanned,
      gamesWithData,
      playRate: 0,
      flag: "UNKNOWN",
      note:
        `AVAILABILITY UNKNOWN: none of the ${teamGamesScanned} team games scanned ` +
        `carry a box score for this stat, so playing time cannot be assessed from ` +
        `this source at all. Do NOT read this as a clean record - confirm the ` +
        `posted lineup before using any prop on this player.`,
    };
  }

  if (role === "starting_pitcher") {
    return {
      gamesPlayed: appearances,
      teamGamesScanned,
      gamesWithData,
      playRate,
      flag: "ROTATION_NORMAL",
      note: null,
    };
  }

  if (playRate < 0.7) {
    return {
      gamesPlayed: appearances,
      teamGamesScanned,
      gamesWithData,
      playRate,
      flag: "IRREGULAR",
      note:
        `PLAYING TIME RISK: appeared in only ${appearances} of the last ` +
        `${gamesWithData} team games that carry data (${dnpCount} DNPs). This player is not an ` +
        `everyday lock. CONFIRM THE POSTED LINEUP before using this prop, and do ` +
        `not describe the hit rate as current form without noting the missed time.`,
    };
  }

  return {
    gamesPlayed: appearances,
    teamGamesScanned,
    gamesWithData,
    playRate,
    flag: "OK",
    note: null,
  };
}
