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
    /**
     * TOTAL events wanted across all pages. See getAllEvents for why this exists
     * and why `limit` alone was a trap. Ignored by this low-level method, which
     * issues exactly one request.
     */
    maxEvents?: number;
  }): Promise<SGOEventsResponse> {
    try {
      // maxEvents is OURS, not SGO's. Passing it upstream would be an unknown
      // query parameter - harmless today, but this connector has already been
      // bitten once by sending a parameter SGO does not recognise and having it
      // silently ignored (includeOpposingOdds, corrected 8 Aug 2026). Strip it
      // explicitly rather than relying on the API to overlook it.
      const { maxEvents: _maxEvents, ...apiParams } = params;
      const response = await this.http.get<SGOEventsResponse>("/events", {
        params: apiParams,
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

  /**
   * IN-FLIGHT REQUEST COALESCING (added v2.6.0).
   *
   * THE BUG: the history cache only writes AFTER a fetch resolves, so N callers
   * that miss the same key simultaneously all fetch, and all get billed. The
   * cache cannot collapse a duplicate it has not stored yet.
   *
   * MEASURED SHAPE OF IT: screenProps runs HIT_RATE_CONCURRENCY=3 workers, and
   * availabilityFor reads its team map, awaits a probe, then writes. All three
   * workers can pass the read before any of them writes, so a two-team game
   * could pay for up to six identical 30-event team-history probes instead of
   * two - roughly 60 wasted entities per screened game.
   *
   * THIS IS THE SAME RACE v2.4.0 FIXED for screenProps' rateCache, by storing
   * the in-flight PROMISE rather than the resolved value. That fix stopped one
   * function short of the client. Fixing it here instead means every caller
   * benefits from one change - hit rates, screening, splits, head-to-head - which
   * is the identical argument v1.2.0 made for putting the history cache at this
   * layer rather than inside hitRateAggregator.
   *
   * ONLY CACHEABLE KEYS ARE COALESCED. Live odds, schedules and any
   * non-finalized query legitimately change minute to minute and still hit the
   * network every time, exactly as before. Efficiency is never traded for
   * correctness here.
   */
  private inFlight = new Map<string, Promise<SGOEvent[]>>();

  /** Bucket an ISO timestamp to the day so near-simultaneous calls share a key. */
  private static dayBucket(iso: string | undefined): string {
    if (!iso) return "none";
    return iso.slice(0, 10);
  }

  private cacheStats = { hits: 0, misses: 0, upgrades: 0, coalesced: 0 };

  /**
   * ---- `limit` IS PAGE SIZE, `maxEvents` IS THE TOTAL (v2.6.0) ----
   *
   * v2.4.1 established that `limit` is the PER-PAGE size and that maxPages
   * defaults to 10, so `limit: 30` could pull up to 300 events. It fixed the one
   * call site it was looking at (screenProps' availability probe, via
   * maxPages: 1) and did not audit the others. Both remaining offenders were on
   * the paths that cost the most:
   *
   *   - hitRateAggregator asked for 30 team games (or 140 for a pitcher) against
   *     a 400-DAY window, which for an MLB club holds well over 200 finalized
   *     games. The cursor kept returning pages, so a request for 30 could bill
   *     for 300.
   *   - splitsAggregator asked for 100 with no page bound at all, so one
   *     home/road question could pull up to 1,000 events.
   *
   * Passing maxPages at every call site would have worked and would have been
   * forgotten again the next time someone adds a caller. So the parameter now
   * means what every caller already assumed it meant: `maxEvents` is a TOTAL,
   * enforced here, and paging stops as soon as it is reached.
   *
   * SGO caps /events at 100 per page, so `limit: 140` was already being clamped
   * upstream and then paged - which is precisely how a 140-game pitcher scan
   * turned into an unbounded crawl. Page size is clamped explicitly below so
   * that behaviour is visible in the code rather than happening in the API.
   */
  async getAllEvents(
    params: Parameters<SGOClient["getEvents"]>[0],
    maxPages = 10
  ): Promise<SGOEvent[]> {
    // The TOTAL number of events this call should ever return. Falls back to
    // `limit` so existing callers that pass only `limit` keep their intent
    // honoured rather than silently paging ten times past it.
    const ceiling = params.maxEvents ?? params.limit ?? 100;
    // SGO's own per-page maximum for /events.
    const pageSize = Math.min(params.limit ?? ceiling, 100);

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
      if (hit && fresh && hit.depth >= ceiling) {
        this.cacheStats.hits++;
        return hit.events;
      }

      // COALESCE. An identical cacheable fetch already running answers this one.
      // Without this, concurrent callers all miss the not-yet-written cache and
      // all get billed - see the inFlight declaration above for the measured case.
      const pending = this.inFlight.get(cacheKey);
      if (pending) {
        this.cacheStats.coalesced++;
        return pending;
      }

      if (hit && fresh) this.cacheStats.upgrades++;
      else this.cacheStats.misses++;
    }

    const work = this.fetchAllPages(params, { pageSize, ceiling, maxPages, cacheKey });

    if (cacheKey) {
      this.inFlight.set(cacheKey, work);
      // Clear on settle, success or failure. A rejected promise must not be left
      // in the map to be handed to every future caller of this key.
      void work.catch(() => undefined).finally(() => this.inFlight.delete(cacheKey));
    }

    return work;
  }

  private async fetchAllPages(
    params: Parameters<SGOClient["getEvents"]>[0],
    opts: { pageSize: number; ceiling: number; maxPages: number; cacheKey: string | null }
  ): Promise<SGOEvent[]> {
    const allEvents: SGOEvent[] = [];
    let cursor: string | undefined = undefined;
    let pages = 0;

    do {
      const page: SGOEventsResponse = await this.getEvents({
        ...params,
        cursor,
        limit: opts.pageSize,
      });
      allEvents.push(...page.data);
      cursor = page.nextCursor ?? undefined;
      pages++;
      // STOP AT THE CEILING. This is the actual fix - previously only the page
      // count bounded the loop, so the total was pageSize * maxPages.
    } while (cursor && pages < opts.maxPages && allEvents.length < opts.ceiling);

    if (opts.cacheKey) {
      this.historyCache.set(opts.cacheKey, {
        events: allEvents,
        // STORE WHAT WE ACTUALLY HOLD, NOT WHAT WAS ASKED FOR.
        //
        // depth was previously `params.limit`, i.e. the page size. Combined with
        // the unbounded paging above, a cached entry routinely held far more
        // events than its own depth claimed - and the consequence was a spurious
        // refetch on a path that runs constantly.
        //
        // A position-player rate (limit 30) and a pitcher rate (limit 140) on the
        // same team share a cache key: same league, same team, same 400-day date
        // bucket, same oddIDs. The pitcher then failed `depth >= ceiling`,
        // counted a depth upgrade, and refetched an entire team history the cache
        // very likely already held in full. Every MLB thread has at least one
        // pitcher prop and several hitter props, so this fired roughly once per
        // team per screen.
        //
        // events.length is the honest measure of what an entry can serve. The
        // Math.max keeps an exact-ceiling fetch recording its own ceiling, so a
        // short window that genuinely returned few games still satisfies later
        // requests for that same shallow depth instead of refetching forever.
        depth: Math.max(allEvents.length, opts.ceiling),
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
    coalesced: number;
    ttlMinutes: number;
  } {
    return {
      entries: this.historyCache.size,
      hits: this.cacheStats.hits,
      misses: this.cacheStats.misses,
      depthUpgrades: this.cacheStats.upgrades,
      // Concurrent duplicate fetches collapsed into one. Reported for the same
      // reason every other counter here is: a saving you cannot observe is a
      // saving you are assuming.
      coalesced: this.cacheStats.coalesced,
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
