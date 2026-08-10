import axios, { type AxiosInstance, AxiosError } from "axios";
import { SGO_BASE_URL, SPORT_CONFIG, type SportKey } from "../constants.js";
import type { SGOEvent, SGOEventsResponse, SGOTeam, SGOPlayer } from "../types.js";

/**
 * SportsGameOdds API client.
 *
 * CONFIRMED via live test (see src/types.ts and README for details):
 *   - Event start time is at `status.startsAt`, NOT `info.date` (that assumption was wrong, now fixed)
 *   - oddID construction pattern (statID-entity-period-betType-side) is exactly correct
 *   - No `lineups` field exists on the event object - SGO does not expose
 *     probable/confirmed starting pitchers pre-game. Use web search for this.
 *   - A single event's `odds` object can contain 1000+ markets - never dump this
 *     raw in a response without capping/summarizing it first.
 *   - CONFIRMED via SGO's own docs/FAQ: request-level filtering (oddIDs, playerID,
 *     bookmakerID) dramatically reduces response size vs. fetching the full event
 *     and filtering client-side. This is the real fix for the earlier OOM crash -
 *     tools now request only the specific line(s) needed instead of pulling 1000+
 *     markets and discarding almost all of them after the fact.
 *
 * STILL UNVERIFIED:
 *   - Player `teamID` update speed after a real trade
 *   - `periodID` for full-game stats results (assumed "game")
 */

export class SGOClient {
  private http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: SGO_BASE_URL,
      headers: { "x-api-key": apiKey },
      // Raised from 15s to 30s - wide lookbackGames requests (e.g. pitcher
      // strikeout checks, which have to skip non-start games to find enough
      // real starts) were timing out at 15s under real use.
      timeout: 30000,
    });
  }

  /**
   * Low-level events fetch. Most tools should use the higher-level helpers below
   * rather than calling this directly.
   */
  async getEvents(params: {
    leagueID?: string;
    eventIDs?: string;
    teamID?: string;
    playerID?: string;
    oddIDs?: string;
    bookmakerID?: string;
    // CORRECTED (8 Aug 2026): this param was previously declared as
    // `includeOpposingOdds`, which is not a real SGO parameter - it was being
    // silently ignored on every request. SGO's own optimization guide names it
    // `includeOpposingOddIDs`. With it set true, passing a single oddID also
    // returns the opposite side, which halves the request count for any
    // two-sided market (every prop, spread, total, and moneyline we fetch).
    includeOpposingOddIDs?: boolean;
    // Include alternate spread / over-under lines. Off by default because it
    // materially increases response size, which is the OOM risk this connector
    // has already been bitten by once.
    includeAltLines?: boolean;
    // Opening odds alongside current. Rides on the same event fetch, so line
    // movement costs no additional request - see tools/lineMovement.ts.
    includeOpenCloseOdds?: boolean;
    startsAfter?: string;
    startsBefore?: string;
    oddsAvailable?: boolean;
    finalized?: boolean;
    live?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<SGOEventsResponse> {
    try {
      const response = await this.http.get<SGOEventsResponse>("/events", {
        params,
      });
      return response.data;
    } catch (err) {
      throw formatSGOError(err, "events");
    }
  }

  /**
   * Fetch ALL events matching a filter, auto-paginating via cursor.
   * Use with caution on broad queries - prefer narrow date/team filters.
   *
   * ============================================================
   * ENTITY-COST CACHE (added 2026-08-10 after a measured blowout)
   * ============================================================
   *
   * MEASURED, NOT ESTIMATED: one tkb_screen_props call on a single MLB game cost
   * 1,610 entities and 286 requests. A 15-game slate at that rate is ~24,000
   * entities, roughly a quarter of the Rookie plan's 100,000 monthly allowance.
   * A day that combined a slate with other work consumed 67,697 and exhausted
   * the plan outright.
   *
   * THE CAUSE WAS DUPLICATION, NOT PAYLOAD SIZE. getPlayerHitRate issues an
   * IDENTICAL team-history query for every player it evaluates - same leagueID,
   * teamID, date window and finalized flag - and filters by playerID locally
   * afterwards. Screening 18 players across 2 teams therefore re-fetched the same
   * two histories dozens of times. screenProps does memoise, but on
   * `playerID|statID|line`, which only collapses the two sides of one market and
   * cannot see that different players share a team.
   *
   * Caching at this layer rather than inside hitRateAggregator means every caller
   * benefits from one change: hit rates, screening, splits and head-to-head.
   *
   * ---- Three implementation details that matter ----
   *
   * 1. SUBSET-AWARE ON `limit`. Role profiles request different depths for the
   *    same team: 140 team games for a starting pitcher, 30 for a position
   *    player. Keying on limit would defeat the cache exactly when it matters
   *    most. Instead the fetched depth is stored, and a cached entry serves any
   *    request for the same or shallower depth. A deeper request re-fetches and
   *    upgrades the entry. Callers already slice locally, so extra events are
   *    harmless.
   *
   * 2. DATE BUCKETING. hitRateAggregator derives its window from `new Date()` at
   *    call time, so two calls milliseconds apart produce different ISO strings.
   *    Keying on the raw values would miss on every single call. Dates are
   *    bucketed to the day, which is far finer than the 400-day window needs.
   *
   * 3. FINALIZED-ONLY. Completed games are immutable, so a cache hit returns
   *    byte-identical data and accuracy is untouched. Live odds, schedules and
   *    any non-finalized query bypass the cache entirely and always hit the
   *    network, because those legitimately change minute to minute. This buys
   *    efficiency without trading away correctness - the one trade this
   *    connector never makes.
   */
  private historyCache = new Map<
    string,
    { events: SGOEvent[]; depth: number; fetchedAt: number }
  >();
  private static readonly HISTORY_TTL_MS = 15 * 60 * 1000;
  private static readonly MAX_CACHE_ENTRIES = 60;

  /** Bucket an ISO timestamp to the day so near-simultaneous calls share a key. */
  private static dayBucket(iso: string | undefined): string {
    if (!iso) return "none";
    return iso.slice(0, 10);
  }

  private cacheStats = { hits: 0, misses: 0, upgrades: 0 };

  async getAllEvents(
    params: Parameters<SGOClient["getEvents"]>[0],
    maxPages = 10
  ): Promise<SGOEvent[]> {
    const requestedDepth = params.limit ?? 100;

    // Only immutable historical queries are cacheable.
    const cacheable = params.finalized === true;
    const cacheKey = cacheable
      ? [
          params.leagueID ?? "",
          params.teamID ?? "",
          params.playerID ?? "",
          params.eventIDs ?? "",
          SGOClient.dayBucket(params.startsAfter),
          SGOClient.dayBucket(params.startsBefore),
          params.oddIDs ?? "",
        ].join("|")
      : null;

    if (cacheKey) {
      const hit = this.historyCache.get(cacheKey);
      const fresh = hit && Date.now() - hit.fetchedAt < SGOClient.HISTORY_TTL_MS;
      // A cached deeper fetch satisfies any shallower request.
      if (hit && fresh && hit.depth >= requestedDepth) {
        this.cacheStats.hits++;
        return hit.events;
      }
      if (hit && fresh) this.cacheStats.upgrades++;
      else this.cacheStats.misses++;
    }

    const allEvents: SGOEvent[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;

    do {
      const page: SGOEventsResponse = await this.getEvents({
        ...params,
        cursor,
        limit: requestedDepth,
      });
      allEvents.push(...page.data);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < maxPages);

    if (cacheKey) {
      this.historyCache.set(cacheKey, {
        events: allEvents,
        depth: requestedDepth,
        fetchedAt: Date.now(),
      });
      // Bound memory. A full slate touches roughly 30 team histories.
      if (this.historyCache.size > SGOClient.MAX_CACHE_ENTRIES) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [k, v] of this.historyCache) {
          if (v.fetchedAt < oldestAt) {
            oldestAt = v.fetchedAt;
            oldestKey = k;
          }
        }
        if (oldestKey) this.historyCache.delete(oldestKey);
      }
    }

    return allEvents;
  }

  /**
   * Cache effectiveness, surfaced through tkb_get_api_usage so the saving is
   * observable rather than assumed. A high hit count during a slate build is the
   * signal that duplicate team-history fetches are actually being collapsed.
   */
  getCacheStats(): {
    entries: number;
    hits: number;
    misses: number;
    depthUpgrades: number;
    ttlMinutes: number;
  } {
    return {
      entries: this.historyCache.size,
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      depthUpgrades: this.cacheStats.upgrades,
      ttlMinutes: SGOClient.HISTORY_TTL_MS / 60000,
    };
  }

  /** Convenience: resolve our internal sport key to SGO's leagueID */
  leagueIDFor(sport: SportKey): string {
    return SPORT_CONFIG[sport].sgoLeagueID;
  }

  /**
   * Fetch team data including real standings (wins/losses/record/streak) directly
   * from SGO - confirmed via their OpenAPI spec to be a real field, not something
   * we need to compute ourselves from event tallying. Use this for overall
   * team record; event-tallying is still needed for home/road or opponent-specific
   * splits since standings doesn't break those out separately.
   */
  /**
   * Fetch players directly from SGO's /players endpoint.
   *
   * WHY THIS EXISTS: before this, the only way to discover a playerID was
   * pulling the entire event object including its odds
   * map (1,180 markets on a live MLB game). That is exactly the fetch-everything
   * pattern that caused the earlier out-of-memory crashes on Render. This
   * endpoint returns player records only - no odds - so it is both correct and
   * dramatically cheaper.
   *
   * Max limit is 250 for /players (vs 25-100 for /events), per SGO's pagination guide.
   */
  async getPlayers(params: {
    playerID?: string;
    teamID?: string;
    leagueID?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ data: SGOPlayer[]; nextCursor?: string | null }> {
    try {
      const response = await this.http.get<{ data: SGOPlayer[]; nextCursor?: string | null }>(
        "/players",
        { params: { ...params, limit: params.limit ?? 250 } }
      );
      return response.data;
    } catch (err) {
      throw formatSGOError(err, "players");
    }
  }

  /** Fetch all players for a team/league, auto-paginating. */
  async getAllPlayers(
    params: Parameters<SGOClient["getPlayers"]>[0],
    maxPages = 5
  ): Promise<SGOPlayer[]> {
    const all: SGOPlayer[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;
    do {
      const page = await this.getPlayers({ ...params, cursor });
      all.push(...page.data);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < maxPages);
    return all;
  }

  /**
   * Fetch current API quota and rate-limit usage.
   *
   * WHY THIS MATTERS FOR THIS ACCOUNT SPECIFICALLY: SGO bills per EVENT OBJECT
   * returned, not per market. A single hit-rate check pulls up to `lookback * 3`
   * events and can auto-paginate, so one prop check can consume 30-90+ objects.
   * At 15-20 threads/day with 2 props each, plus splits, monthly consumption can
   * plausibly approach or exceed the Rookie plan's 100,000 object allowance -
   * and until now there was no way to see that from inside the workflow.
   */
  async getUsage(): Promise<unknown> {
    try {
      const response = await this.http.get("/account/usage");
      return response.data;
    } catch (err) {
      throw formatSGOError(err, "account usage");
    }
  }

  async getTeam(teamID: string): Promise<SGOTeam | null> {
    try {
      const response = await this.http.get<{ data: SGOTeam[] }>("/teams", {
        params: { teamID },
      });
      return response.data.data[0] ?? null;
    } catch (err) {
      throw formatSGOError(err, `team ${teamID}`);
    }
  }
}

function formatSGOError(err: unknown, context: string): Error {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const body = err.response?.data;
    if (status === 401 || status === 403) {
      return new Error(
        `SportsGameOdds API auth error (${status}) while fetching ${context}. Check that SGO_API_KEY is set correctly on this server. Response: ${JSON.stringify(body)}`
      );
    }
    if (status === 429) {
      return new Error(
        `SportsGameOdds API rate limit hit while fetching ${context}. Wait a moment and retry, or reduce request frequency.`
      );
    }
    return new Error(
      `SportsGameOdds API error (${status ?? "network error"}) while fetching ${context}: ${JSON.stringify(body ?? err.message)}`
    );
  }
  return new Error(`Unexpected error fetching ${context} from SportsGameOdds: ${String(err)}`);
}
