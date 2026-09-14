import axios, { type AxiosInstance } from "axios";
import type { CbbdPlayerRow } from "./cbbdStatMap.js";

/**
 * CollegeBasketballData CLIENT.
 *
 * ============================================================================
 * WHY THIS AND NOT BALLDONTLIE
 * ============================================================================
 *
 * BALLDONTLIE publishes /ncaab/v1/player_stats and gates it behind GOAT for that
 * sport, at $39.99 a month for NCAAB alone - BDL's paid tiers do not carry across
 * sports. CollegeBasketballData serves the same box scores free, on the same Bearer
 * auth this repo already speaks for CollegeFootballData, from the same organisation.
 *
 * SGO IS NOT AN OPTION EITHER, for the reason v2.7.0 recorded on the football side:
 * SGO carries college GAMES but not college player box scores outside the biggest
 * events, and falling back to it reported started games as DNPs and produced a
 * quarterback at a 0.2 play rate. With no CBBD_API_KEY the CBB hit-rate path
 * REFUSES rather than degrading to a source that cannot answer.
 *
 * ============================================================================
 * THE BUDGET IS SHARED WITH CFBD, WHICH MAKES IT TIGHTER THAN IT LOOKS
 * ============================================================================
 *
 * CBBD's key page states that access tiers determine the SHARED CollegeFootballData
 * and CollegeBasketballData quota. So this is not a second 1,000-a-month allowance;
 * it is the SAME allowance the CFB path is already spending, and November through
 * early December is the one stretch where both sports are in season at once.
 *
 * Confirmed from CBBD's own server source: exceeding it returns HTTP 429 with
 * "Monthly call quota exceeded.", and every response carries an
 * X-CallLimit-Remaining header. That header is read and surfaced here rather than
 * discarded, because this repo's standing complaint about the CFBD counter is that
 * an in-process number resets on every Render cold start and therefore cannot be
 * trusted as a budget. X-CallLimit-Remaining comes from the provider and does not.
 *
 * ============================================================================
 * FETCH BY DATE WINDOW, NEVER BY GAME
 * ============================================================================
 *
 * CBBD's /games/players takes startDateRange and endDateRange and has NO gameId
 * parameter, so the natural unit is a date window rather than CFBD's week number.
 * This client fetches a WEEK-SHAPED WINDOW and caches it, which keeps the football
 * design's economics: one request covers every game in that week, and the naive
 * shape - one call per game, or per player, from inside a thread builder - is what
 * exhausts the month.
 *
 * CACHING IS PERMANENT FOR A WINDOW THAT HAS CLOSED. A finished week's box scores
 * are immutable, so re-fetching one can only ever spend budget to receive identical
 * bytes. A window containing today gets a short TTL because games inside it are
 * still being played.
 *
 * ============================================================================
 * ONE PLACE CBBD IS STRICTLY BETTER THAN CFBD
 * ============================================================================
 *
 * The football client needs a SECOND endpoint (/games) purely to recover dates,
 * because /games/players returns a bare numeric game id and nothing else - the bug
 * that cost v2.8.6 a silent season-provenance failure. CBBD puts `startDate`
 * directly on every box-score row. No join, no second request, and the season and
 * staleness guardrails cannot go blind for lack of a date.
 */

const CBBD_BASE_URL = "https://api.collegebasketballdata.com";

/** A window whose games are all finished never changes. Anything else gets a TTL. */
const IN_PROGRESS_TTL_MS = 30 * 60 * 1000;

/**
 * One TEAM's box score for one game. CBBD returns one of these PER TEAM, so a
 * single game arrives as two rows - do not treat the array length as a game count.
 */
export interface CbbdTeamBoxScore {
  gameId: number;
  season: number;
  seasonType: string;
  startDate: string;
  teamId: number;
  team: string;
  conference: string | null;
  opponentId: number;
  opponent: string;
  neutralSite: boolean;
  isHome: boolean;
  players: CbbdPlayerRow[];
}

interface WindowCacheEntry {
  rows: CbbdTeamBoxScore[];
  fetchedAt: number;
  permanent: boolean;
}

export class CBBDClient {
  private http: AxiosInstance;
  private windowCache = new Map<string, WindowCacheEntry>();
  private inFlight = new Map<string, Promise<CbbdTeamBoxScore[]>>();

  /**
   * The provider's own remaining-call count, from X-CallLimit-Remaining. Null until
   * a request has been made. THIS IS THE AUTHORITATIVE NUMBER; the counters below
   * are in-process and reset on every Render cold start.
   */
  private callLimitRemaining: number | null = null;

  private stats = { requests: 0, hits: 0, misses: 0, coalesced: 0, errors: 0 };

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: CBBD_BASE_URL,
      timeout: 30_000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
  }

  private key(startISO: string, endISO: string): string {
    return `${startISO}|${endISO}`;
  }

  /**
   * Every player box score in a date window, in ONE request.
   *
   * `startISO` and `endISO` are full ISO timestamps; CBBD types both range
   * parameters as dates rather than plain days.
   */
  async getPlayerBoxScores(params: {
    startISO: string;
    endISO: string;
    /** Pass true for a window that has already closed. Never re-fetched if so. */
    permanent?: boolean;
  }): Promise<CbbdTeamBoxScore[]> {
    const cacheKey = this.key(params.startISO, params.endISO);

    const hit = this.windowCache.get(cacheKey);
    if (hit && (hit.permanent || Date.now() - hit.fetchedAt < IN_PROGRESS_TTL_MS)) {
      this.stats.hits++;
      return hit.rows;
    }

    // COALESCE CONCURRENT IDENTICAL FETCHES. The cache only writes after a fetch
    // resolves, so without this N concurrent callers all miss and all get billed -
    // the exact race v2.6.0 fixed in SGOClient, and worse here because the budget
    // is monthly and shared with CFBD.
    const pending = this.inFlight.get(cacheKey);
    if (pending) {
      this.stats.coalesced++;
      return pending;
    }

    this.stats.misses++;
    const work = this.fetchWindow(params.startISO, params.endISO);
    this.inFlight.set(cacheKey, work);

    try {
      const rows = await work;
      this.windowCache.set(cacheKey, {
        rows,
        fetchedAt: Date.now(),
        permanent: params.permanent ?? false,
      });
      if (this.windowCache.size > 60) {
        // Evict the oldest NON-permanent entry. A closed window is worth keeping.
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, v] of this.windowCache) {
          if (v.permanent) continue;
          if (v.fetchedAt < oldestAt) {
            oldestAt = v.fetchedAt;
            oldestKey = k;
          }
        }
        if (oldestKey) this.windowCache.delete(oldestKey);
      }
      return rows;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async fetchWindow(startISO: string, endISO: string): Promise<CbbdTeamBoxScore[]> {
    this.stats.requests++;
    try {
      const res = await this.http.get("/games/players", {
        params: { startDateRange: startISO, endDateRange: endISO },
      });

      const remaining = res.headers?.["x-calllimit-remaining"];
      if (remaining !== undefined) {
        const n = Number(remaining);
        if (Number.isFinite(n)) this.callLimitRemaining = n;
      }

      const raw = Array.isArray(res.data) ? res.data : [];
      return raw.map((r: Record<string, unknown>) => ({
        gameId: Number(r.gameId),
        season: Number(r.season ?? 0),
        seasonType: String(r.seasonType ?? "regular"),
        startDate: String(r.startDate ?? ""),
        teamId: Number(r.teamId ?? 0),
        team: String(r.team ?? ""),
        conference: (r.conference as string | null) ?? null,
        opponentId: Number(r.opponentId ?? 0),
        opponent: String(r.opponent ?? ""),
        neutralSite: Boolean(r.neutralSite),
        isHome: Boolean(r.isHome),
        players: (Array.isArray(r.players) ? r.players : []) as CbbdPlayerRow[],
      }));
    } catch (err: unknown) {
      this.stats.errors++;
      const status =
        typeof err === "object" && err !== null && "response" in err
          ? (err as { response?: { status?: number } }).response?.status
          : undefined;

      // NAME THE CAUSE. Three different 4xx conditions mean three different fixes,
      // and a message that blurs them costs a deploy cycle each time.
      if (status === 401)
        throw new Error(
          `CollegeBasketballData auth error (401). CBBD_API_KEY is missing, wrong, or not ` +
            `sent as a Bearer token. A CFBD key will NOT work here - they are separate keys ` +
            `on a shared quota. Get one free at collegebasketballdata.com/key. This is a ` +
            `configuration problem, not a data problem.`
        );
      if (status === 429)
        throw new Error(
          `CollegeBasketballData returned 429. TWO DIFFERENT CONDITIONS produce this and ` +
            `they need opposite responses. "Monthly call quota exceeded" is a MONTH-LONG ` +
            `wall that does NOT reset for days - do not retry, and check whether something ` +
            `is fetching per game instead of per date window. "Too many concurrent requests ` +
            `for this endpoint" is transient and clears in about a second. Read the message ` +
            `body before deciding. NOTE: this quota is SHARED with CollegeFootballData, so ` +
            `CFB usage can exhaust CBB.` +
            (this.callLimitRemaining !== null
              ? ` Last known X-CallLimit-Remaining: ${this.callLimitRemaining}.`
              : "")
        );
      if (status === 503)
        throw new Error(
          `CollegeBasketballData returned 503 while verifying the call quota. Transient - ` +
            `nothing is established about the data, and a retry shortly is reasonable.`
        );
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`CBBD /games/players failed for ${startISO}..${endISO}: ${msg}`);
    }
  }

  /** Counters plus the provider's own remaining-call figure, for tkb_get_api_usage. */
  getStats(): {
    requests: number;
    hits: number;
    misses: number;
    coalesced: number;
    errors: number;
    cachedWindows: number;
    permanentWindows: number;
    callLimitRemaining: number | null;
  } {
    let permanent = 0;
    for (const entry of this.windowCache.values()) if (entry.permanent) permanent++;
    return {
      ...this.stats,
      cachedWindows: this.windowCache.size,
      permanentWindows: permanent,
      callLimitRemaining: this.callLimitRemaining,
    };
  }

  /** Seed the cache from data shipped in the repo rather than fetched. */
  seedWindow(startISO: string, endISO: string, rows: CbbdTeamBoxScore[]): void {
    this.windowCache.set(this.key(startISO, endISO), {
      rows,
      fetchedAt: Date.now(),
      permanent: true,
    });
  }
}
