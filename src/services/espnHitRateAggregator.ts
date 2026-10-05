import type { SportKey } from "../constants.js";
import type { HitRateResult, GameLogEntry } from "../types.js";
import {
  EspnClient,
  ESPN_LEAGUE_PATHS,
  flattenGamelog,
  extractRoster,
  type EspnGamelog,
  type FlattenedGame,
} from "./espnClient.js";
import {
  extractTeams,
  resolveEspnTeam,
  resolveEspnAthlete,
  type EspnTeamEntry,
} from "./espnPlayerResolution.js";
import {
  resolveEspnStat,
  readEspnStat,
  espnStatUnavailableReason,
  supportedEspnStatIDs,
} from "./espnStatMap.js";
import { summarizeSeasons, seasonForDate } from "./seasonBoundary.js";
import { describeRecency, type SampleRecency } from "./sampleRecency.js";

/**
 * ============================================================================
 * HIT RATES FROM ESPN'S PUBLIC GAME LOG
 * ============================================================================
 *
 * Free, keyless, and the reason this exists: BALLDONTLIE prices per sport, so every
 * league added costs another subscription, while ESPN costs nothing and does not get
 * more expensive as leagues are added. Modelled on nhlHitRateAggregator.ts, which is
 * the closest existing path: free source, season-scoped fetch, explicit preseason
 * exclusion, play-rate denominator from the same fetch.
 *
 * ZERO SGO ENTITIES. That is the point on a Rookie key, where SGO's monthly entity
 * cap is the binding constraint and hit rates are the heaviest consumer.
 *
 * ============================================================================
 * REAL DATES, OR A REFUSAL. THE v2.7.1 LESSON, NOT REPEATED.
 * ============================================================================
 *
 * flattenGamelog returns eventId, seasonType, category and stats. NO DATE. The dates
 * live in the gamelog's TOP-LEVEL `events` map, keyed by event id, verified
 * 2026-10-05: each entry carries `gameDate` ("2025-05-01T02:00:00.000+00:00"),
 * `atVs` ("vs" or "@") and an `opponent` object.
 *
 * v2.7.0 built the CFB path, reused summarizeSeasons and describeRecency "on the
 * grounds that they encode hard-won rules", and stamped the log with a synthetic
 * "2025-W7" string because CFBD returned a bare game id. Both guardrails are
 * DATE-KEYED, so they received fifteen unparseable dates, counted zero of them, and
 * reported that nothing crossed a season boundary while every game was prior-season.
 * The changelog's own conclusion: "A guardrail with no input does not fail loudly;
 * it returns a clean result."
 *
 * So this file joins the events map by event id and REFUSES a row with no usable
 * date rather than inventing one. A row without a date cannot be sorted, cannot be
 * aged, and cannot be season-checked, so it is not evidence.
 *
 * ============================================================================
 * MULTI-SEASON IS CHEAP HERE, AND THAT CHANGES THE DEFAULT
 * ============================================================================
 *
 * On SGO, widening to a prior season roughly multiplies entity cost, which is why
 * PRIOR_SEASON_LOOKBACK is an explicit opt-in flag with a "take this off around Week
 * 5" instruction. Here a second season is one more free HTTP request, so reaching
 * back when the current season is too thin is the DEFAULT rather than a flag.
 *
 * It is still LABELLED. summarizeSeasons runs on real dates and its prior-season
 * warning is returned, because "free" changes the cost argument and changes nothing
 * about whether a bettor should be told the sample is last year's form.
 */

export interface EspnHitRateParams {
  sport: SportKey;
  /** SGO's player display name. Matched against the ESPN roster, never substituted. */
  playerName: string;
  /** SGO's team display name, e.g. "Buffalo Bills". Resolved to an ESPN team id. */
  teamName: string;
  statID: string;
  line: number;
  direction: "over" | "under";
  /** Stop once this many appearances are collected, newest first. */
  targetAppearances?: number;
  minSufficient?: number;
  /** Off by default. When false, only the current season is fetched. */
  allowPriorSeasons?: boolean;
  /** How many seasons back to reach at most, including the current one. Default 2. */
  maxSeasons?: number;
  asOf?: Date;
}

export interface EspnHitRateExtras {
  recency: SampleRecency;
  espnAthleteId: string | null;
  espnTeamId: string | null;
  espnTeamName: string | null;
  /** Which ESPN `season` params were actually fetched, newest first. */
  seasonsFetched: number[];
  /** ESPN's own seasonType -> category -> count tree, so a month split stays visible. */
  seasonStructure: Record<string, Record<string, number>>;
  /** Rows ESPN returned that carried no usable date. Never silently counted. */
  rowsWithoutDate: number;
  /** Rows whose stats array length disagreed with labels. */
  rowsWithLengthMismatch: number;
  preseasonExcluded: boolean;
  espnColumnsSeen: string[];
}

/* ============================================================================
 * THE `season` PARAM CONVENTION DIFFERS BY SPORT, AND IT IS MEASURED NOT ASSUMED
 * ============================================================================
 *
 * This is the kind of thing that looks like a detail and silently fetches the wrong
 * year. Measured live 2026-10-05:
 *
 *   NBA   season=2025 -> "2024-25 Regular Season" + "2024-25 Postseason"  (55 rows)
 *         season=2026 -> "2025-26 Regular Season" + "2025-26 Preseason"   (67 rows)
 *         So the param is the calendar year the season ENDS in.
 *
 *   NFL   season=2025 -> "2025 Regular Season" (17) + "2025 Postseason" (2)
 *         So the param is the year the season STARTS in. An NFL season is named for
 *         its start year, so "end year" is not even a meaningful idea there.
 *
 *   SOCCER  NOT MEASURED numerically. The default (no param) returned
 *           "2026-27 English Premier League Stats". Which integer selects a prior
 *           soccer season is unknown, so this file does not guess: soccer fetches the
 *           CURRENT season only and says so, rather than passing a number that might
 *           silently return a different year than intended.
 */
type SeasonConvention = "end-year" | "start-year" | "calendar-year" | "unmeasured";

const SEASON_CONVENTION: Partial<Record<SportKey, SeasonConvention>> = {
  nba: "end-year",
  nhl: "end-year",
  nfl: "start-year",
  // A WNBA season begins and ends inside one calendar year, so there is no ambiguity.
  wnba: "calendar-year",
  mlb: "calendar-year",
  epl: "unmeasured",
  ucl: "unmeasured",
};

/** Which months start a season, for the two-calendar-year sports. 0-indexed. */
const SEASON_START_MONTH: Partial<Record<SportKey, number>> = {
  nba: 9, // October
  nhl: 8, // September, per the 2026-27 opener measured on 2026-09-29
};

/**
 * PURE. Which ESPN `season` integers to try, newest first.
 *
 * Exported so the convention can be asserted without a network, which is the rule
 * this repo applies to every cost-or-correctness decision.
 */
export function espnSeasonsToFetch(
  sport: SportKey,
  asOf: Date,
  opts: { allowPriorSeasons?: boolean; maxSeasons?: number } = {}
): number[] {
  const convention = SEASON_CONVENTION[sport] ?? "unmeasured";
  if (convention === "unmeasured") return [];

  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth();

  let current: number;
  if (convention === "calendar-year") {
    current = year;
  } else if (convention === "end-year") {
    const startMonth = SEASON_START_MONTH[sport] ?? 9;
    current = month >= startMonth ? year + 1 : year;
  } else {
    // start-year
    const startMonth = 7; // August, so a January playoff game belongs to the prior season
    current = month >= startMonth ? year : year - 1;
  }

  const span = Math.max(1, Math.min(opts.maxSeasons ?? 2, 4));
  const count = opts.allowPriorSeasons === false ? 1 : span;
  return Array.from({ length: count }, (_, i) => current - i);
}

/** Dates and context pulled out of the gamelog's top-level `events` map. */
export interface EspnEventMeta {
  dateISO: string;
  opponent: string | null;
  isHome: boolean | null;
}

/**
 * PURE. Join the events map by event id.
 *
 * `atVs` is ESPN's home/away marker: "vs" for home, "@" for away. Verified on a log
 * where the player's own team id matched `homeTeamId` on a "vs" row.
 */
export function extractEventMeta(log: EspnGamelog): Map<string, EspnEventMeta> {
  const out = new Map<string, EspnEventMeta>();
  const events = log.events;
  if (!events || typeof events !== "object") return out;

  for (const [id, raw] of Object.entries(events)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const date = typeof e.gameDate === "string" ? e.gameDate : undefined;
    if (!date) continue;
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) continue;

    let opponent: string | null = null;
    const opp = e.opponent;
    if (opp && typeof opp === "object") {
      const o = opp as Record<string, unknown>;
      opponent =
        (typeof o.abbreviation === "string" && o.abbreviation) ||
        (typeof o.displayName === "string" && o.displayName) ||
        null;
    }

    const atVs = typeof e.atVs === "string" ? e.atVs : undefined;
    const isHome = atVs === "vs" ? true : atVs === "@" ? false : null;

    out.set(id, { dateISO: parsed.toISOString(), opponent, isHome });
  }
  return out;
}

/**
 * PURE. Which season does this GAME belong to, by its own date?
 *
 * ---- WHY NOT JUST ECHO ESPN'S `season` PARAM, WHICH WE ALREADY HAVE ----
 *
 * Because they are different numbers with different meanings, and the field they go
 * into has a documented contract. types.ts says seasonYear is "the year the season
 * STARTED". ESPN's param is the END year for NBA and NHL and the START year for NFL.
 *
 * CAUGHT ON A LIVE DEPLOY, not in review. Luka Doncic, dates in March and April 2026,
 * fetched under ESPN season=2026, came back as:
 *
 *     log[].seasonYear:    2026
 *     seasonsRepresented:  [2025]
 *     seasonWarning:       "EVERY game ... from a PRIOR season (2025)"
 *
 * Two conventions in one response, disagreeing about the same games. The prose was
 * right - those games ARE last season - and the per-row label was wrong, which is the
 * worse half: a reader scanning the log sees 2026 beside an April date and concludes
 * the sample is current.
 *
 * That is the NHL season-label bug recorded in
 * preseason-scope-corrected-and-nhl-season-label-bug.md, reproduced here by me, from
 * the same cause: a season label derived from something other than the game's date.
 *
 * So the label comes from seasonBoundary, the repo's ONE copy of the rule every other
 * aggregator already keys on. Rows and the summary then agree by construction, for
 * every sport, including the ones whose ESPN param convention is unmeasured and
 * therefore absent.
 */
export function espnRowSeasonYear(sport: SportKey, dateISO: string): number | undefined {
  return seasonForDate(sport, dateISO)?.seasonYear;
}

export class EspnRefusal extends Error {}

function refuse(message: string): never {
  throw new EspnRefusal(message);
}

export async function getEspnPlayerHitRate(
  espn: EspnClient,
  params: EspnHitRateParams
): Promise<HitRateResult & EspnHitRateExtras> {
  const asOf = params.asOf ?? new Date();
  const path = ESPN_LEAGUE_PATHS[params.sport];
  if (!path) {
    refuse(
      `ESPN has no configured game-log path for ${params.sport.toUpperCase()}. ` +
        `Configured: ${Object.keys(ESPN_LEAGUE_PATHS).join(", ")}.`
    );
  }

  /* ---- REFUSE BEFORE FETCHING. An unmapped stat is a code-level fact, and spending
   * three HTTP requests to discover it is waste plus a worse message. Same ordering
   * as nhlHitRateAggregator. */
  const namedRefusal = espnStatUnavailableReason(params.sport, params.statID);
  if (namedRefusal) {
    refuse(`No ESPN rate is available for "${params.statID}". ${namedRefusal}`);
  }
  const resolver = resolveEspnStat(params.sport, params.statID);
  if (!resolver) {
    refuse(
      `Stat "${params.statID}" has no ESPN game-log mapping for ` +
        `${params.sport.toUpperCase()}. Supported: ` +
        `${supportedEspnStatIDs(params.sport).join(", ")}. Do NOT substitute a value.`
    );
  }

  /* ---- HOP 1: SGO team name -> ESPN team id ---- */
  const teamsRes = await espn.fetchTeams(path);
  if (!teamsRes.ok || !teamsRes.data) {
    refuse(`ESPN team list unavailable for ${params.sport.toUpperCase()}: ${teamsRes.reason}`);
  }
  const teams: EspnTeamEntry[] = extractTeams(teamsRes.data);
  if (!teams.length) {
    refuse(
      `ESPN returned a team list for ${params.sport.toUpperCase()} that this parser ` +
        `found no teams in. The response shape may have changed; re-run ` +
        `tkb_probe_espn_gamelog before trusting any ESPN rate for this sport.`
    );
  }
  const teamMatch = resolveEspnTeam(teams, params.teamName);
  if (!teamMatch.ok) {
    refuse(
      `Could not map "${params.teamName}" to an ESPN team. ${teamMatch.reason}` +
        (teamMatch.candidates?.length ? ` Candidates: ${teamMatch.candidates.join("; ")}.` : "")
    );
  }

  /* ---- HOP 2: ESPN team id -> ESPN athlete id ---- */
  const rosterRes = await espn.fetchRoster(path, teamMatch.value.id);
  if (!rosterRes.ok || !rosterRes.data) {
    refuse(
      `ESPN roster unavailable for ${teamMatch.value.displayName}: ${rosterRes.reason}`
    );
  }
  const roster = extractRoster(rosterRes.data);
  const athlete = resolveEspnAthlete(roster, params.playerName);
  if (!athlete.ok) {
    refuse(
      `Could not map "${params.playerName}" to an ESPN athlete on ` +
        `${teamMatch.value.displayName}. ${athlete.reason}` +
        (athlete.candidates?.length ? ` Candidates: ${athlete.candidates.join("; ")}.` : "")
    );
  }

  /* ---- HOP 3: the game logs, newest season first, stopping once the sample is full ---- */
  const target = params.targetAppearances ?? 10;
  const minSufficient = params.minSufficient ?? 5;
  const seasons = espnSeasonsToFetch(params.sport, asOf, {
    allowPriorSeasons: params.allowPriorSeasons,
    maxSeasons: params.maxSeasons,
  });

  const collected: {
    game: FlattenedGame;
    meta: EspnEventMeta;
    season: number | null;
  }[] = [];
  const structure: Record<string, Record<string, number>> = {};
  const seasonsFetched: number[] = [];
  let rowsWithoutDate = 0;
  let rowsWithLengthMismatch = 0;
  let names: string[] = [];
  /* ---- DEDUPE BY EVENT ID ACROSS SEASON FETCHES ----
   *
   * CAUGHT BY A TEST, not by reasoning. The first cut appended every fetched season's
   * rows unconditionally, so a game returned by two season queries would be COUNTED
   * TWICE: three games became a six-game sample with each result duplicated, which
   * leaves the hit RATE unchanged while doubling the apparent sample size. That is the
   * worst shape for this particular bug, because `sampleSufficient` is what decides
   * whether a number is quotable at all - a 3-game sample would have passed an
   * 8-appearance bar by counting itself twice.
   *
   * Real ESPN is not expected to overlap seasons. "Not expected to" is exactly the
   * assumption this repo does not build on, and the guard costs one Set. */
  const seenEventIds = new Set<string>();

  // An empty `seasons` list means the convention is unmeasured for this sport, so
  // fetch the DEFAULT (no param) rather than guessing an integer.
  const fetchPlan: (number | undefined)[] = seasons.length ? seasons : [undefined];

  for (const season of fetchPlan) {
    const res = await espn.fetchGamelog(path, athlete.value.id, season);
    if (!res.ok || !res.data) {
      // A failed PRIOR season is not fatal; a failed FIRST season is.
      if (seasonsFetched.length === 0) {
        refuse(
          `ESPN game log unavailable for ${athlete.value.displayName}` +
            `${season ? ` (season ${season})` : ""}: ${res.reason}`
        );
      }
      break;
    }
    const log = res.data;
    if (season !== undefined) seasonsFetched.push(season);

    const theseNames = log.names ?? [];
    if (theseNames.length && !names.length) names = theseNames;

    const flat = flattenGamelog(log, { includePreseason: false });
    rowsWithLengthMismatch += flat.lengthMismatches.length;
    for (const [st, cats] of Object.entries(flat.structure)) {
      structure[st] = { ...(structure[st] ?? {}), ...cats };
    }

    const meta = extractEventMeta(log);
    for (const g of flat.games) {
      const m = meta.get(g.eventId);
      if (!m) {
        rowsWithoutDate++;
        continue;
      }
      if (seenEventIds.has(g.eventId)) continue;
      seenEventIds.add(g.eventId);
      collected.push({ game: g, meta: m, season: season ?? null });
    }

    if (collected.length >= target) break;
  }

  if (!names.length) {
    refuse(
      `ESPN returned a game log for ${athlete.value.displayName} with no column names, ` +
        `so nothing can be mapped. This is the "200 with no rows" shape measured on ` +
        `kickers: ESPN serves no data for some positions at this endpoint.`
    );
  }

  if (!collected.length) {
    refuse(
      `ESPN returned no dated regular-season games for ${athlete.value.displayName}` +
        `${seasonsFetched.length ? ` across season(s) ${seasonsFetched.join(", ")}` : ""}. ` +
        `${rowsWithoutDate} row(s) were dropped for carrying no usable date and ` +
        `${rowsWithLengthMismatch} for a column-count mismatch. A rate is not computed ` +
        `from undated rows.`
    );
  }

  /* ---- NEWEST FIRST. Provider ordering is never trusted; the date decides. ---- */
  collected.sort((a, b) => (a.meta.dateISO < b.meta.dateISO ? 1 : a.meta.dateISO > b.meta.dateISO ? -1 : 0));

  const log: GameLogEntry[] = [];
  let gamesHit = 0;
  let overHits = 0;
  let underHits = 0;
  let pushCount = 0;
  let appearances = 0;
  let wrongShapeRefusal: string | null = null;
  let unreadable = 0;

  for (const row of collected) {
    if (appearances >= target) break;
    const read = readEspnStat(resolver, names, row.game.stats);

    if (!read.ok) {
      /* A WRONG-SHAPE READ IS A HARD STOP, NOT A SKIPPED GAME.
       * If the witness is missing, it is missing for EVERY row in this log, so
       * continuing would quietly produce a zero-appearance sample. This is the
       * defense_sacks-pointed-at-a-quarterback case. */
      if (read.wrongShape) {
        wrongShapeRefusal = read.reason;
        break;
      }
      // A single unparseable cell is a coverage gap for that game, not a DNP.
      unreadable++;
      log.push({
        eventID: row.game.eventId,
        date: row.meta.dateISO,
        opponent: row.meta.opponent ?? "unknown",
        isHome: row.meta.isHome ?? false,
        statValue: null,
        dataStatus: "stat_unsettled",
        seasonYear: espnRowSeasonYear(params.sport, row.meta.dateISO),
      } as GameLogEntry);
      continue;
    }

    appearances++;
    const v = read.value;
    const hitOver = v > params.line;
    const hitUnder = v < params.line;
    if (hitOver) overHits++;
    else if (hitUnder) underHits++;
    else pushCount++;
    if (params.direction === "over" ? hitOver : hitUnder) gamesHit++;

    log.push({
      eventID: row.game.eventId,
      date: row.meta.dateISO,
      opponent: row.meta.opponent ?? "unknown",
      isHome: row.meta.isHome ?? false,
      statValue: v,
      dataStatus: "value",
      seasonYear: espnRowSeasonYear(params.sport, row.meta.dateISO),
    } as GameLogEntry);
  }

  if (wrongShapeRefusal) {
    refuse(
      `"${params.statID}" cannot be read from ${athlete.value.displayName}'s ESPN game ` +
        `log. ${wrongShapeRefusal}`
    );
  }

  const dates = log.filter((l) => l.statValue !== null).map((l) => l.date);
  const seasonSummary = summarizeSeasons(params.sport, dates);
  const recency = describeRecency(
    log.map((l) => ({ date: l.date, statValue: l.statValue })),
    {},
    asOf
  );

  const sampleSufficient = appearances >= minSufficient;
  const parts: string[] = [];
  if (!sampleSufficient) {
    parts.push(
      `INSUFFICIENT SAMPLE: ${appearances} appearance(s) found, ${minSufficient} needed. ` +
        `A rate on ${appearances} game(s) is NOT a hit rate and must not be quoted as one.`
    );
  }
  if (seasonSummary.warning) parts.push(seasonSummary.warning);
  if (recency.warning) parts.push(recency.warning);
  if (unreadable > 0) {
    parts.push(
      `${unreadable} game(s) carried no readable value for this stat and were EXCLUDED ` +
        `from the count rather than treated as zero.`
    );
  }

  const gamesWithData = log.length;
  const playRate = gamesWithData > 0 ? appearances / gamesWithData : 0;

  return {
    playerName: params.playerName,
    statID: params.statID,
    line: params.line,
    direction: params.direction,
    gamesConsidered: appearances,
    gamesHit,
    gamesExcludedDNP: 0,
    log,
    overHits,
    underHits,
    pushCount,
    teamGamesScanned: collected.length,
    hitScanCeiling: collected.length >= target,
    sampleSufficient,
    sampleWarning: parts.length ? parts.join(" ") : null,
    playerRole: "position_player",
    recentAvailability: {
      gamesPlayed: appearances,
      teamGamesScanned: collected.length,
      gamesWithData,
      playRate,
      /* ESPN's game log lists games the player APPEARED IN, so an absent game is
       * simply not a row. That makes a play rate from this source structurally
       * different from the SGO path's, where the team's whole schedule is scanned and
       * a DNP is visible. Reporting UNKNOWN rather than a flattering 1.0 that would
       * read as "never misses". */
      flag: "UNKNOWN",
      note:
        `ESPN's game log contains only games this player appeared in, so it cannot ` +
        `show DNPs and this is NOT an availability measure. Confirm the lineup or ` +
        `team news separately before posting.`,
    },
    gamesStatUnsettled: unreadable,
    currentSeasonGames: seasonSummary.current,
    priorSeasonGames: seasonSummary.prior,
    seasonsRepresented: seasonSummary.seasonsRepresented,
    crossesSeasonBoundary: seasonSummary.crossesSeasonBoundary,
    seasonWarning: seasonSummary.warning,
    recency,
    espnAthleteId: athlete.value.id,
    espnTeamId: teamMatch.value.id,
    espnTeamName: teamMatch.value.displayName,
    seasonsFetched,
    seasonStructure: structure,
    rowsWithoutDate,
    rowsWithLengthMismatch,
    preseasonExcluded: true,
    espnColumnsSeen: names,
  } as HitRateResult & EspnHitRateExtras;
}
