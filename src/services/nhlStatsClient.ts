import axios, { type AxiosInstance } from "axios";

// The game-state vocabulary lives in its own pure module so that eventStatus.ts can
// use it without importing axios. Re-exported here so callers that already hold this
// client do not need a second import path.
export { nhlSaysFinal, nhlSaysLive, NHL_TERMINAL_GAME_STATES, NHL_LIVE_GAME_STATES } from "./nhlStatus.js";

/**
 * NHL API CLIENT (api-web.nhle.com).
 *
 * NO KEY, NO QUOTA, NO SGO OBJECTS, NO SUBSCRIPTION TO LAPSE. The second source in
 * this connector with no billing model at all, after statsapi.mlb.com, and the
 * constraint is the same: LATENCY against the 60-second tool ceiling, not spend.
 *
 * ============================================================================
 * WHY THIS EXISTS RATHER THAN A BALLDONTLIE PATH
 * ============================================================================
 *
 * BDL tiers are PER SPORT, and for hockey they gate the two things a connector needs:
 *
 *   /nhl/v1/games, /nhl/v1/standings      ALL-STAR, $9.99/mo
 *   /nhl/v1/player stats, injuries, odds  GOAT, $39.99/mo
 *
 * This account holds neither for hockey, so every NHL feature would have refused on
 * an entitlement the day it shipped. The league publishes the same facts for free.
 *
 * MEASURED 2026-09-24, all four against live data:
 *
 *   /v1/score/{date}                    gameState, both scores, gameOutcome
 *   /v1/player/{id}/game-log/{s}/{t}    82 games in ONE request
 *   /v1/gamecenter/{id}/boxscore        per-player rows keyed on playerId
 *   /v1/roster/{team}/{season}          firstName/lastName, full spellings
 *
 * THE GAME LOG IS THE WHOLE REASON THIS IS CHEAP. Every other hit-rate path in this
 * connector pages through games and then reads players out of each one. One request
 * here returns a player's entire season, so an NHL hit rate costs a single HTTP call
 * and zero billable objects. That is cheaper than BDL, which was already ~20x cheaper
 * than the SGO path.
 *
 * ============================================================================
 * IT IS UNDOCUMENTED, AND THAT IS A REAL LIABILITY, NOT A FOOTNOTE
 * ============================================================================
 *
 * The NHL publishes no OpenAPI spec and no stability promise for these paths. Every
 * field name in this file was read off a live response on the date above, which is
 * the same standard the rest of this repo holds itself to for SGO's `displayShort` -
 * but SGO at least has a docs page to disagree with. Here there is nothing to check
 * against, so:
 *
 *   - every read is defensive and returns undefined rather than 0 on absence
 *   - nothing throws on a shape surprise except the fetch wrappers, which say which
 *     endpoint and which argument failed
 *   - `gameState` is matched against an explicit allow-list of terminal values, never
 *     a "not in progress" inference
 *
 * If the league changes a field, the failure should be a refusal naming this file,
 * not a hit rate quietly computed from undefined.
 */

const NHL_BASE_URL = "https://api-web.nhle.com/v1";

/** Scores move minute to minute during a slate. Short on purpose. */
const SCORE_TTL_MS = 60 * 1000;

/**
 * A FINISHED game log never changes, but an in-season one gains a row every night,
 * so this cannot be long. Ten minutes keeps a screener's repeated lookups to one
 * fetch without ever serving a stale "last 10".
 */
const GAME_LOG_TTL_MS = 10 * 60 * 1000;

/** Rosters move slowly. A day keeps this to one fetch per club per process. */
const ROSTER_TTL_MS = 12 * 60 * 60 * 1000;

/** A season schedule gains a played game each night, so it cannot be cached all day. */
const SCHEDULE_TTL_MS = 30 * 60 * 1000;

export interface NhlGame {
  gameId: number;
  /** Raw gameState, echoed for the caller to report. */
  gameState: string;
  startTimeUTC?: string;
  homeAbbrev?: string;
  awayAbbrev?: string;
  homeName?: string;
  awayName?: string;
  /** Undefined rather than 0 when absent. A missing score must not read as nil-nil. */
  homeScore?: number;
  awayScore?: number;
  /** "REG" | "OT" | "SO" once decided. How the game ended. */
  lastPeriodType?: string;
}

export interface NhlPlayerRef {
  playerId: number;
  fullName: string;
  teamAbbrev: string;
  positionCode: string;
  /** True for G. Goalie stat rows have an entirely different shape. */
  isGoalie: boolean;
}

/** One row of a player's game log, normalised across the skater/goalie split. */
export interface NhlGameLogEntry {
  gameId: number;
  gameDate: string;
  teamAbbrev?: string;
  opponentAbbrev?: string;
  /** "H" or "R", as the league spells it. */
  homeRoadFlag?: string;
  /** Raw stat values, keyed by the NHL's own field names. Undefined = absent. */
  stats: Record<string, number | undefined>;
}

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/**
 * THE NHL'S SEASON ID IS A PAIR OF YEARS, e.g. "20262027".
 *
 * Derived from the season-start month rather than from a second hard-coded rule:
 * seasonBoundary.ts already owns "which season does this date belong to" for every
 * sport, and October for hockey is a row in that table. Two copies of a boundary rule
 * is how a January game ends up filed under a season that has not started.
 */
export function nhlSeasonId(seasonStartYear: number): string {
  return `${seasonStartYear}${seasonStartYear + 1}`;
}

/** Regular season. 1 is preseason, 3 is playoffs. */
export const NHL_GAME_TYPE_REGULAR = 2;
export const NHL_GAME_TYPE_PLAYOFF = 3;

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** The league nests every display string under a language key. "default" is English. */
function defaultString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { default?: unknown }).default === "string") {
    return (v as { default: string }).default;
  }
  return undefined;
}

/**
 * PURE. One row of /v1/score/{date}.
 *
 * Scores are read with numberOrUndefined rather than `?? 0` on purpose. The caller's
 * entire job is to compare this feed's numbers against SGO's, and a zero that means
 * "missing" would make two disagreeing feeds look like they agree on a 0-0. The BDL
 * reconciler makes the same choice for the same reason.
 */
export function normaliseNhlGame(raw: Record<string, unknown>): NhlGame {
  const home = (raw.homeTeam ?? {}) as Record<string, unknown>;
  const away = (raw.awayTeam ?? {}) as Record<string, unknown>;
  const outcome = (raw.gameOutcome ?? {}) as Record<string, unknown>;

  const teamName = (t: Record<string, unknown>): string | undefined => {
    const place = defaultString(t.placeName);
    const common = defaultString(t.commonName) ?? defaultString(t.name);
    if (place && common) return `${place} ${common}`;
    return common ?? place;
  };

  return {
    gameId: Number(raw.id),
    gameState: typeof raw.gameState === "string" ? raw.gameState : "",
    startTimeUTC: typeof raw.startTimeUTC === "string" ? raw.startTimeUTC : undefined,
    homeAbbrev: typeof home.abbrev === "string" ? home.abbrev : undefined,
    awayAbbrev: typeof away.abbrev === "string" ? away.abbrev : undefined,
    homeName: teamName(home),
    awayName: teamName(away),
    homeScore: numberOrUndefined(home.score),
    awayScore: numberOrUndefined(away.score),
    lastPeriodType:
      typeof outcome.lastPeriodType === "string" ? outcome.lastPeriodType : undefined,
  };
}

/**
 * PURE. One row of a game log, skater or goalie.
 *
 * THE GOALIE ROW HAS NO `saves` FIELD. Measured on a live goalie log, the fields are
 * `shotsAgainst`, `goalsAgainst`, `savePctg`, `decision`, `shutouts` - and nothing
 * else. So saves are DERIVED here as shotsAgainst minus goalsAgainst.
 *
 * That subtraction is exact arithmetic, not an estimate: every shot against is either
 * saved or a goal. It is computed in this one place and labelled `saves` so that the
 * stat map has a single field to point at, and it is only emitted when BOTH inputs are
 * present, because a derived number from one known and one missing input would be
 * confidently wrong.
 */
export function normaliseNhlGameLogEntry(raw: Record<string, unknown>): NhlGameLogEntry {
  const stats: Record<string, number | undefined> = {};
  const copy = [
    "goals",
    "assists",
    "points",
    "plusMinus",
    "powerPlayGoals",
    "powerPlayPoints",
    "shorthandedGoals",
    "shorthandedPoints",
    "gameWinningGoals",
    "otGoals",
    "shots",
    "shifts",
    "pim",
    "shotsAgainst",
    "goalsAgainst",
    "shutouts",
    "gamesStarted",
  ];
  for (const k of copy) stats[k] = numberOrUndefined(raw[k]);

  const shotsAgainst = stats.shotsAgainst;
  const goalsAgainst = stats.goalsAgainst;
  if (shotsAgainst !== undefined && goalsAgainst !== undefined) {
    stats.saves = shotsAgainst - goalsAgainst;
  }

  return {
    gameId: Number(raw.gameId),
    gameDate: typeof raw.gameDate === "string" ? raw.gameDate : "",
    teamAbbrev: typeof raw.teamAbbrev === "string" ? raw.teamAbbrev : undefined,
    opponentAbbrev: typeof raw.opponentAbbrev === "string" ? raw.opponentAbbrev : undefined,
    homeRoadFlag: typeof raw.homeRoadFlag === "string" ? raw.homeRoadFlag : undefined,
    stats,
  };
}

/**
 * Lowercase, strip diacritics, drop everything that is not a letter or digit.
 *
 * Same normalisation the BDL reconciler uses on team names, and it matters more here:
 * hockey rosters are full of names the two feeds punctuate differently. They agree
 * about letters and disagree about apostrophes and hyphens constantly.
 */
export function normaliseNhlName(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export interface NhlClubGame {
  gameId: number;
  gameDate: string;
  gameType: number;
  gameState: string;
  homeAbbrev?: string;
  awayAbbrev?: string;
}

export class NHLStatsClient {
  private http: AxiosInstance;
  private scoreCache = new Map<string, CacheEntry<NhlGame[]>>();
  private logCache = new Map<string, CacheEntry<NhlGameLogEntry[]>>();
  private rosterCache = new Map<string, CacheEntry<NhlPlayerRef[]>>();
  private scheduleCache = new Map<string, CacheEntry<NhlClubGame[]>>();
  private inFlight = new Map<string, Promise<unknown>>();
  private stats = { requests: 0, hits: 0, misses: 0, coalesced: 0, errors: 0 };

  constructor() {
    this.http = axios.create({
      baseURL: NHL_BASE_URL,
      timeout: 15_000,
      headers: { Accept: "application/json" },
    });
  }

  usage() {
    return { ...this.stats };
  }

  /**
   * Request coalescing, shared by all three endpoints.
   *
   * Two picks on the same game in one grade_slate call would otherwise fetch the same
   * scoreboard twice. There is no quota to protect, but the 60-second ceiling is real
   * and sequential duplicate round trips are felt on a fifteen-game slate.
   */
  private async cached<T>(
    store: Map<string, CacheEntry<T>>,
    key: string,
    ttlMs: number,
    work: () => Promise<T>
  ): Promise<T> {
    const hit = store.get(key);
    if (hit && Date.now() - hit.fetchedAt < ttlMs) {
      this.stats.hits++;
      return hit.value;
    }
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      this.stats.coalesced++;
      return pending;
    }
    this.stats.misses++;
    const p = work();
    this.inFlight.set(key, p);
    try {
      const value = await p;
      store.set(key, { value, fetchedAt: Date.now() });
      return value;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Every game on one date with its current state and score. ONE request per date.
   *
   * `/score/{date}` rather than `/schedule/{date}`: the schedule endpoint returns a
   * whole WEEK keyed by day and carries no scores on a finished game, so using it for
   * finality would mean a second call per game.
   */
  async getScoreboard(dateISO: string): Promise<NhlGame[]> {
    return this.cached(this.scoreCache, `score:${dateISO}`, SCORE_TTL_MS, async () => {
      this.stats.requests++;
      try {
        const res = await this.http.get(`/score/${dateISO}`);
        const games = Array.isArray(res.data?.games) ? res.data.games : [];
        return games.map((g: Record<string, unknown>) => normaliseNhlGame(g));
      } catch (err) {
        this.stats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`NHL API scoreboard failed for ${dateISO}: ${msg}`);
      }
    });
  }

  /**
   * A PLAYER'S WHOLE SEASON IN ONE REQUEST. This is the cheap path.
   *
   * Returns newest-last as the league sends it; callers that want "last 10" must take
   * from the END. v2.0.3 was a bug of exactly this kind against BDL, where page one
   * turned out to be the OLDEST games and no local sorting could recover the recent
   * ones, so the ordering is stated rather than assumed and the aggregator sorts by
   * date regardless.
   */
  async getPlayerGameLog(
    playerId: number,
    seasonId: string,
    gameType: number = NHL_GAME_TYPE_REGULAR
  ): Promise<NhlGameLogEntry[]> {
    const key = `log:${playerId}:${seasonId}:${gameType}`;
    return this.cached(this.logCache, key, GAME_LOG_TTL_MS, async () => {
      this.stats.requests++;
      try {
        const res = await this.http.get(`/player/${playerId}/game-log/${seasonId}/${gameType}`);
        const log = Array.isArray(res.data?.gameLog) ? res.data.gameLog : [];
        return log.map((g: Record<string, unknown>) => normaliseNhlGameLogEntry(g));
      } catch (err) {
        this.stats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `NHL API game log failed for player ${playerId}, season ${seasonId}, type ${gameType}: ${msg}`
        );
      }
    });
  }

  /**
   * A club's roster with FULL first names.
   *
   * WHY THIS IS NEEDED AT ALL, and it is the one non-obvious call in this file: the
   * BOX SCORE abbreviates. Measured on a live game, a skater's name arrives as
   * `{"default":"Z. Benson"}` - an initial, not a first name - which cannot be matched
   * against SGO's "Zach Benson" by any normalisation. The roster endpoint carries
   * `firstName` and `lastName` in full alongside the same `id`, so this is what turns
   * an SGO player name into an NHL playerId.
   */
  async getRoster(teamAbbrev: string, seasonId: string): Promise<NhlPlayerRef[]> {
    const team = teamAbbrev.toUpperCase();
    const key = `roster:${team}:${seasonId}`;
    return this.cached(this.rosterCache, key, ROSTER_TTL_MS, async () => {
      this.stats.requests++;
      try {
        const res = await this.http.get(`/roster/${team}/${seasonId}`);
        const out: NhlPlayerRef[] = [];
        for (const group of ["forwards", "defensemen", "goalies"]) {
          const rows = Array.isArray(res.data?.[group]) ? res.data[group] : [];
          for (const r of rows) {
            const first = defaultString(r.firstName);
            const last = defaultString(r.lastName);
            if (!first && !last) continue;
            const positionCode = typeof r.positionCode === "string" ? r.positionCode : "";
            out.push({
              playerId: Number(r.id),
              fullName: [first, last].filter(Boolean).join(" "),
              teamAbbrev: team,
              positionCode,
              isGoalie: positionCode.toUpperCase() === "G" || group === "goalies",
            });
          }
        }
        return out;
      } catch (err) {
        this.stats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`NHL API roster failed for ${team}, season ${seasonId}: ${msg}`);
      }
    });
  }

  /** A club's full season schedule. See fetchClubSchedule below for why it is needed. */
  async getClubSchedule(teamAbbrev: string, seasonId: string): Promise<NhlClubGame[]> {
    const team = teamAbbrev.toUpperCase();
    const key = `clubsched:${team}:${seasonId}`;
    return this.cached(this.scheduleCache, key, SCHEDULE_TTL_MS, async () => {
      this.stats.requests++;
      try {
        const res = await this.http.get(`/club-schedule-season/${team}/${seasonId}`);
        const games = Array.isArray(res.data?.games) ? res.data.games : [];
        return games.map((g: Record<string, unknown>) => {
          const home = (g.homeTeam ?? {}) as Record<string, unknown>;
          const away = (g.awayTeam ?? {}) as Record<string, unknown>;
          return {
            gameId: Number(g.id),
            gameDate: typeof g.gameDate === "string" ? g.gameDate : "",
            gameType: typeof g.gameType === "number" ? g.gameType : 0,
            gameState: typeof g.gameState === "string" ? g.gameState : "",
            homeAbbrev: typeof home.abbrev === "string" ? home.abbrev : undefined,
            awayAbbrev: typeof away.abbrev === "string" ? away.abbrev : undefined,
          };
        });
      } catch (err) {
        this.stats.errors++;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`NHL API club schedule failed for ${team}, season ${seasonId}: ${msg}`);
      }
    });
  }
}

/**
 * A CLUB'S WHOLE SEASON SCHEDULE, used only to get a PLAY-RATE DENOMINATOR.
 *
 * WHY THIS SECOND CALL EXISTS. A player's game log contains only the games he
 * PLAYED: a DNP is an absent row, exactly as it is on the CBBD path. So the log alone
 * can produce "cleared this in 6 of 10" while hiding that those ten appearances span
 * fifteen team games because he was scratched five times. That play-rate signal has
 * mattered enough in this connector to be a first-class field on HitRateResult.
 *
 * It is the difference between a hit rate and a hit rate you can publish, and it
 * costs one extra request against an endpoint with no quota, so it is made.
 *
 * FILTER ON gameType YOURSELF. Measured 2026-09-24: this endpoint returns PRESEASON
 * games (gameType 1) alongside the regular season, and a preseason game in a play-rate
 * denominator would understate every regular's availability in October. The connector
 * already holds, in seasonBoundary.ts, that preseason GAME results have effectively no
 * predictive value and should never be used.
 */
export async function fetchClubSchedule(
  client: NHLStatsClient,
  teamAbbrev: string,
  seasonId: string
): Promise<NhlClubGame[]> {
  return client.getClubSchedule(teamAbbrev, seasonId);
}
