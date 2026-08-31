import axios, { type AxiosInstance } from "axios";
import type { CfbdCategory } from "./cfbdStatMap.js";

/**
 * CollegeFootballData CLIENT.
 *
 * WHY THIS EXISTS AT ALL. Measured 2026-08-31 against two teams:
 *
 *   Dante Moore   (Oregon)      15 team games in the 2025 window, 3 with a box score
 *   Maddux Madsen (Boise State) 14 team games in the 2025 window, 1 with a box score
 *
 * The populated games were Dec 21, Jan 1, Jan 10 and Dec 14 - all playoff games.
 * Every regular-season game from August through November returned null. SGO carries
 * CFB GAMES but not CFB PLAYER BOX SCORES outside the playoff, so it cannot be a
 * hit-rate source for this sport at all. BALLDONTLIE gates NCAAF player stats behind
 * GOAT. CFBD is the remaining source, and its free tier covers player statistics.
 *
 * THE CALL BUDGET IS THE WHOLE DESIGN. The free tier is 1,000 requests a MONTH
 * (3,000 on a verified .edu key). That sounds tight against a 392-game season and is
 * not, because of one property of the API: /games/players accepts YEAR + WEEK with
 * no team filter, and returns every player's box score for every game that week in a
 * SINGLE request.
 *
 *   A full 2025 season backfill          ~16 requests, once, ever
 *   In-season, one completed week        1 request per week, ~14 a season
 *
 * That is the entire ingest. The failure mode is the naive shape - calling per game,
 * or per player, from inside the thread builder - which is 392+ requests a month and
 * blows the budget in a week. THIS CLIENT THEREFORE FETCHES BY WEEK AND NEVER BY
 * GAME OR PLAYER, and every consumer reads from the week cache.
 *
 * CACHING IS PERMANENT, NOT TTL'd. This is the deliberate difference from SGOClient's
 * 15-minute history cache. A completed week's box scores are immutable - unlike odds,
 * which change minute to minute - so re-fetching one can only ever spend budget to
 * receive identical bytes. The current week is the one exception and is given a short
 * TTL, because games inside it are still finishing.
 */

const CFBD_BASE_URL = "https://api.collegefootballdata.com";

/** A week whose games are all final never changes. Anything else gets a short TTL. */
const IN_PROGRESS_TTL_MS = 30 * 60 * 1000;

export interface CfbdGameBoxScore {
  gameId: number;
  teams: {
    team: string;
    conference: string | null;
    homeAway: "home" | "away";
    points: number | null;
    categories: CfbdCategory[];
  }[];
}

interface WeekCacheEntry {
  games: CfbdGameBoxScore[];
  fetchedAt: number;
  /** Permanent entries are never re-fetched; provisional ones expire. */
  permanent: boolean;
}

export class CFBDClient {
  private http: AxiosInstance;
  private weekCache = new Map<string, WeekCacheEntry>();
  private inFlight = new Map<string, Promise<CfbdGameBoxScore[]>>();

  /**
   * OBSERVABILITY IS NOT OPTIONAL ON A 1,000-A-MONTH BUDGET. Every other cache in
   * this repo reports hits and misses (see tkb_get_api_usage) because a saving you
   * cannot observe is a saving you are assuming. Here the stakes are higher: an
   * un-noticed cache miss loop would exhaust a MONTH of quota, not a rate limit
   * that resets in sixty seconds.
   */
  private stats = { requests: 0, hits: 0, misses: 0, coalesced: 0, errors: 0 };

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: CFBD_BASE_URL,
      timeout: 30_000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  }

  private key(year: number, week: number, seasonType: string): string {
    return `${year}|${week}|${seasonType}`;
  }

  /**
   * Every player box score for one week, in ONE request.
   *
   * `permanent` marks a week as immutable. Callers pass true for any week that has
   * finished; the backfill passes true for every historical week. A permanent entry
   * is never re-fetched for the life of the process.
   */
  async getWeekPlayerStats(params: {
    year: number;
    week: number;
    seasonType?: "regular" | "postseason";
    permanent?: boolean;
  }): Promise<CfbdGameBoxScore[]> {
    const seasonType = params.seasonType ?? "regular";
    const cacheKey = this.key(params.year, params.week, seasonType);

    const hit = this.weekCache.get(cacheKey);
    if (hit) {
      const fresh =
        hit.permanent || Date.now() - hit.fetchedAt < IN_PROGRESS_TTL_MS;
      if (fresh) {
        this.stats.hits++;
        return hit.games;
      }
    }

    // COALESCE CONCURRENT IDENTICAL FETCHES. Exactly the race v2.6.0 fixed in
    // SGOClient: the cache only writes after a fetch resolves, so N concurrent
    // callers all miss and all get billed. On a monthly budget that is worse here
    // than it was there.
    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      this.stats.coalesced++;
      return pending;
    }

    this.stats.misses++;
    const work = this.fetchWeek(params.year, params.week, seasonType);
    this.inFlight.set(cacheKey, work);

    try {
      const games = await work;
      this.weekCache.set(cacheKey, {
        games,
        fetchedAt: Date.now(),
        permanent: params.permanent ?? false,
      });
      return games;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async fetchWeek(
    year: number,
    week: number,
    seasonType: string
  ): Promise<CfbdGameBoxScore[]> {
    this.stats.requests++;
    try {
      const res = await this.http.get("/games/players", {
        params: { year, week, seasonType },
      });
      const raw = Array.isArray(res.data) ? res.data : [];
      return raw.map((g: Record<string, unknown>) => ({
        gameId: Number(g.id),
        teams: (Array.isArray(g.teams) ? g.teams : []) as CfbdGameBoxScore["teams"],
      }));
    } catch (err: unknown) {
      this.stats.errors++;
      const status =
        typeof err === "object" && err !== null && "response" in err
          ? (err as { response?: { status?: number } }).response?.status
          : undefined;

      // NAME THE CAUSE. v2.2.1 established that a failure which hides its own
      // reason is indistinguishable from a failure that never happened, and that
      // guessing between five plausible causes wastes a deploy cycle each time.
      if (status === 401)
        throw new Error(
          `CFBD auth error (401). CFBD_API_KEY is missing, wrong, or not sent as a ` +
            `Bearer token. This is a configuration problem, not a data problem.`
        );
      if (status === 429)
        throw new Error(
          `CFBD rate limit / quota exhausted (429). The free tier is 1,000 requests ` +
            `a MONTH (3,000 on a verified .edu key) and does not reset for days. Do ` +
            `NOT retry in a loop. Check whether something is fetching per game or ` +
            `per player instead of per week.`
        );
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CFBD request failed for ${year} week ${week}: ${msg}`);
    }
  }

  /** Cache and request counters, for tkb_get_api_usage. */
  getStats(): {
    requests: number;
    hits: number;
    misses: number;
    coalesced: number;
    errors: number;
    cachedWeeks: number;
    permanentWeeks: number;
  } {
    let permanent = 0;
    for (const entry of this.weekCache.values()) if (entry.permanent) permanent++;
    return {
      ...this.stats,
      cachedWeeks: this.weekCache.size,
      permanentWeeks: permanent,
    };
  }

  /**
   * Seed the cache from data shipped in the repo rather than fetched.
   *
   * WHY THIS MATTERS ON RENDER: the container filesystem is ephemeral and a free
   * instance spins down, so anything written at runtime is gone on the next cold
   * start. A backfill that re-ran on every restart would quietly spend the month's
   * budget a few restarts in - the exact failure this budget cannot absorb. Prior
   * seasons are immutable, so they belong in the repo as data, alongside
   * data/cfbStadiums.ts and data/cfbTiers.ts, and cost zero requests forever.
   */
  seedWeek(
    year: number,
    week: number,
    seasonType: string,
    games: CfbdGameBoxScore[]
  ): void {
    this.weekCache.set(this.key(year, week, seasonType), {
      games,
      fetchedAt: Date.now(),
      permanent: true,
    });
  }
}
