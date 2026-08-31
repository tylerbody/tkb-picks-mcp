import axios, { type AxiosInstance, AxiosError } from "axios";
import { BDL_BASE_URL, SPORT_CONFIG, type SportKey } from "../constants.js";
import type {
  BDLInjuriesResponse,
  BDLGamesResponse,
  BDLStandingsResponse,
  BDLRankingRow,
  BDLConference,
  BDLTeam,
} from "../types.js";

/**
 * BALLDONTLIE API client. Serves injuries, player game stats, standings,
 * conferences, teams, player search and the NCAAF AP poll. SGO remains the sole
 * source for odds/lines to avoid maintaining two odds pipelines.
 *
 * One account, one API key. THIS ACCOUNT HOLDS ALL-STAR FOR MLB, NFL, WNBA AND
 * NCAAF, all active. A 401 here is an entitlement boundary on a specific endpoint,
 * NOT a lapsed subscription - see the tier table above statsPathFor and the 401
 * branch in formatBDLError. A 404 is a missing endpoint and is not buyable at any
 * tier. Those are different answers and the error messages keep them separate.
 *
 * Base path is per-sport: https://api.balldontlie.io/{sport}/v1/...
 * NOTE: MLB/NFL/NBA/NHL historically used un-prefixed /v1/ paths for some endpoints
 * (see docs). Confirm the exact path shape per sport on first live test - this
 * client assumes the {sport}/v1/ prefix pattern shown in BALLDONTLIE's EPL/Ligue1
 * docs is consistent across all sports. Adjust buildPath() below if a given sport
 * turns out to use a different convention.
 */

/**
 * Strip diacritics for name matching.
 *
 * MEASURED 2026-08-14: a full-roster screen on Marlins @ Reds fell back to
 * SportsGameOdds on 24 of 191 rates, split evenly between "player not found"
 * and "ambiguous name". The lineup was Heriberto Hernandez, Eugenio Suarez and
 * Elly De La Cruz - accented characters and multi-word surnames.
 *
 * This is not a rare edge case. A large share of MLB rosters carry one or both,
 * so leaving it unhandled means a persistent ~13% fallback rate concentrated on
 * exactly the players most likely to appear in a lineup.
 */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Candidate search terms for a player name, longest surname first.
 *
 * BDL's `search` matches on last name, but "last name" is ambiguous for
 * "De La Cruz" - searching "Cruz" returns every Cruz in the league and the
 * disambiguator correctly refuses to guess. Trying progressively longer
 * suffixes ("Cruz", then "La Cruz", then "De La Cruz") finds the specific one
 * without loosening the refusal rule that prevents wrong-player matches.
 */
function searchTermsFor(fullName: string): string[] {
  const tokens = fullName.trim().split(/\s+/);
  if (tokens.length <= 1) return [fullName.trim()];

  const terms: string[] = [];
  // Longest surname suffix first: most specific query wins.
  for (let take = Math.min(3, tokens.length - 1); take >= 1; take--) {
    terms.push(tokens.slice(tokens.length - take).join(" "));
  }
  return [...new Set(terms)];
}

export class BDLClient {
  private http: AxiosInstance;

  /**
   * ---- CLIENT-SIDE REQUEST THROTTLE ----
   *
   * BALLDONTLIE allows 60 requests/minute on ALL-STAR. Caching removes most of
   * the duplication, but a wide screen can still burst: 18 players each needing
   * a search plus a paginated stats fetch is ~40 requests fired within a couple
   * of seconds under 3-way concurrency.
   *
   * A 429 here is worse than a slow request, because the aggregator treats any
   * failure as a reason to fall back to SportsGameOdds - which costs real
   * entities. Spacing requests slightly is strictly cheaper than being rate
   * limited into the expensive path.
   *
   * 1100ms between requests holds ~54/min, comfortably under the ceiling with
   * room for the retry the interceptor does not do.
   */
  private static readonly MIN_REQUEST_GAP_MS = 1100;
  private lastRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();

  private throttle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = BDLClient.MIN_REQUEST_GAP_MS - (Date.now() - this.lastRequestAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
    });
    this.queue = run.catch(() => undefined);
    return run.then(fn);
  }

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: BDL_BASE_URL,
      headers: { Authorization: apiKey },
      timeout: 30000,
    });
  }

  private buildPath(sport: SportKey, endpoint: string): string {
    const { bdlPath } = SPORT_CONFIG[sport];
    return `/${bdlPath}/v1/${endpoint}`;
  }

  async getInjuries(
    sport: SportKey,
    params: { team_ids?: number[]; player_ids?: number[]; cursor?: number } = {}
  ): Promise<BDLInjuriesResponse> {
    try {
      const response = await this.http.get<BDLInjuriesResponse>(
        this.buildPath(sport, "player_injuries"),
        {
          params: {
            "team_ids[]": params.team_ids,
            "player_ids[]": params.player_ids,
            cursor: params.cursor,
            // BDL defaults per_page to 25 and caps it at 100. Leaving it at the
            // default meant a full NFL injury sweep (162 records on a live test)
            // took 7 paginated requests instead of 2. At the ALL-STAR rate limit
            // of 60 req/min that waste is worth eliminating.
            per_page: 100,
          },
        }
      );
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} injuries`, sport);
    }
  }

  /**
   * Fetch season standings for a sport.
   *
   * WHY THIS REPLACES EVENT-TALLYING: splitsAggregator computes home/road records
   * by pulling up to 100 finalized SGO events and counting wins by hand. That is
   * both slow and expensive, since SGO bills per event object returned. BDL's
   * standings endpoint returns home_record, road_record, point_differential,
   * win_streak, division_record and conference_record in ONE call, at no SGO cost.
   *
   * It also supplies point_differential directly, which matters: analysis of 26
   * seasons of play-by-play found that after roughly six games, point differential
   * is as predictive of future performance as any advanced metric. That makes it
   * strong, defensible material for a moneyline reasoning bullet.
   *
   * Requires ALL-STAR tier or above (same tier as injuries, already subscribed).
   */
  async getStandings(sport: SportKey, season: number): Promise<BDLStandingsResponse> {
    try {
      const response = await this.http.get<BDLStandingsResponse>(
        this.buildPath(sport, "standings"),
        { params: { season } }
      );
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} standings`, sport);
    }
  }

  /**
   * ---- AP POLL RANKINGS (NCAAF) ----
   *
   * WHY THIS MATTERS MORE THAN IT LOOKS. tkb_get_schedule's CFB tiering requires
   * the caller to supply `rankedTeams` from a live web search on EVERY call. That
   * was the right decision when it was made: SGO was confirmed not to expose a
   * ranking field, and hardcoding a Top 25 into the server would go stale within a
   * week and then return wrong results silently all season.
   *
   * BALLDONTLIE publishes the AP poll directly, on the ALL-STAR tier this account
   * ALREADY HOLDS for NCAAF. So the manual step was never necessary; it was a gap
   * in what the connector knew about its own subscriptions. It costs zero SGO
   * entities and removes a recurring human step from every CFB build.
   *
   * WEEK DEFAULTS TO CURRENT when omitted, per BDL's own parameter docs.
   *
   * NOT AVAILABLE FOR EVERY SPORT. Rankings are an NCAA concept; MLB, WNBA and NFL
   * have no poll. The tool layer gates this rather than the client.
   */
  async getRankings(
    sport: SportKey,
    params: { season: number; week?: number }
  ): Promise<{ data: BDLRankingRow[] }> {
    try {
      const response = await this.http.get<{ data: BDLRankingRow[] }>(
        this.buildPath(sport, "rankings"),
        { params: { season: params.season, ...(params.week ? { week: params.week } : {}) } }
      );
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} rankings`, sport);
    }
  }

  /**
   * ---- CONFERENCES (NCAAF) ----
   *
   * Needed only because NCAAF standings require a conference_id, and conference
   * names are what a human actually has ("ACC", "Big Ten"). One cheap lookup
   * resolves the name to the id.
   *
   * CACHED FOR THE PROCESS LIFETIME. The conference list changes at most once a
   * year during realignment, so a TTL would be theatre. Re-fetching it on every
   * standings call would burn a throttled round trip for data that is effectively
   * static.
   */
  private conferenceCache = new Map<SportKey, BDLConference[]>();

  async getConferences(sport: SportKey): Promise<BDLConference[]> {
    const cached = this.conferenceCache.get(sport);
    if (cached) return cached;
    try {
      const response = await this.http.get<{ data: BDLConference[] }>(
        this.buildPath(sport, "conferences")
      );
      const rows = response.data?.data ?? [];
      this.conferenceCache.set(sport, rows);
      return rows;
    } catch (err) {
      throw formatBDLError(err, `${sport} conferences`, sport);
    }
  }

  /**
   * Standings scoped to one conference.
   *
   * SEPARATE FROM getStandings BECAUSE THE CONTRACT DIFFERS. BDL's NCAAF standings
   * endpoint documents conference_id as REQUIRED, unlike the league-wide standings
   * used by MLB/WNBA/NFL. Overloading one method with an optional parameter would
   * hide the fact that omitting it is an error for one sport and normal for the
   * others - the same reasoning that keeps the pick'em and prediction-market
   * blocklists in separate sets rather than one bag.
   */
  async getConferenceStandings(
    sport: SportKey,
    params: { conferenceId: number; season: number }
  ): Promise<BDLStandingsResponse> {
    try {
      const response = await this.http.get<BDLStandingsResponse>(
        this.buildPath(sport, "standings"),
        { params: { conference_id: params.conferenceId, season: params.season } }
      );
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} conference standings`, sport);
    }
  }

  /** Fetch all teams for a sport - used to resolve BDL numeric team IDs from names. */
  async getTeams(sport: SportKey): Promise<{ data: BDLTeam[] }> {
    try {
      const response = await this.http.get<{ data: BDLTeam[] }>(this.buildPath(sport, "teams"));
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} teams`, sport);
    }
  }

  /** Fetch ALL injuries for a sport, auto-paginating. */
  async getAllInjuries(sport: SportKey): Promise<BDLInjuriesResponse["data"]> {
    const all: BDLInjuriesResponse["data"] = [];
    let cursor: number | undefined = undefined;

    do {
      const page = await this.getInjuries(sport, { cursor });
      all.push(...page.data);
      cursor = page.meta?.next_cursor ?? undefined;
    } while (cursor);

    return all;
  }

  /**
   * ---- PLAYER GAME STATS (the SGO entity-cost replacement) ----
   *
   * WHY THIS EXISTS: hit rates were computed by pulling a team's finalized events
   * from SportsGameOdds and reading player values out of event.results. SGO bills
   * per EVENT OBJECT returned, so one team-history fetch costs 30-140 objects and
   * a 15-game slate ran roughly 3,000 - against a 100,000 monthly cap. Measured on
   * 2026-08-10: one thread cost 211 entities, and a month of daily builds projected
   * to ~114,000, i.e. over the cap.
   *
   * BALLDONTLIE has NO monthly object cap. It rate-limits requests per minute only
   * (60/min on ALL-STAR, 600/min on GOAT). Moving hit-rate computation here removes
   * the binding constraint entirely rather than shrinking it.
   *
   * ENDPOINT PATH DIFFERS BY SPORT - confirmed from BDL's own OpenAPI index:
   *   MLB   -> /mlb/v1/stats
   *   WNBA  -> /wnba/v1/player_stats
   *   NFL   -> /nfl/v1/stats
   *   NCAAF -> /ncaaf/v1/player_stats
   * Guessing one shared path would 404 on half the sports, which is the same class
   * of mistake as the injuries team-field bug that shipped twice.
   *
   * TIER REQUIREMENT, VERIFIED LIVE 2026-08-31 (this supersedes the earlier claim
   * here that player stats were ALL-STAR for every sport, which came from a
   * third-party article rather than BDL's own tables):
   *
   *   endpoint                      ALL-STAR result on this account
   *   /mlb/v1/stats                 200
   *   /nfl/v1/stats                 200
   *   /wnba/v1/player_stats         401  - GOAT only for this sport
   *   /ncaaf/v1/player_stats        401  - GOAT only for this sport
   *   /ncaaf/v1/players             200  - free tier
   *   /ncaaf/v1/teams               200  - free tier
   *   /ncaaf/v1/team_season_stats   401  - GOAT only
   *   /ncaaf/v1/player_injuries     404  - endpoint does not exist, unbuyable
   *
   * The gate is PER ENDPOINT PER SPORT. NCAAF GOAT would buy player stats and team
   * season stats and nothing else; it would NOT produce an injuries feed. CFB hit
   * rates come from CollegeFootballData instead (see cfbdClient.ts), which is free
   * and externally validated, so there is currently no reason to buy NCAAF GOAT.
   */
  private statsPathFor(sport: SportKey): string {
    const { bdlPath } = SPORT_CONFIG[sport];
    // MLB and NFL use /stats; WNBA and NCAAF use /player_stats.
    const endpoint = sport === "mlb" || sport === "nfl" ? "stats" : "player_stats";
    return `/${bdlPath}/v1/${endpoint}`;
  }

  /**
   * ---- TIER-GATE MEMO ----
   *
   * BALLDONTLIE tiers features PER SPORT, and the boundaries are NOT the same
   * across sports. Verified live on 2026-08-19 with MLB, NFL, NCAAF and WNBA all
   * subscribed at ALL-STAR on this account, against the published feature tables
   * at wnba.balldontlie.io and ncaaf.balldontlie.io:
   *
   *   MLB   /mlb/v1/stats           included at ALL-STAR   -> works
   *   NFL   /nfl/v1/stats           included at ALL-STAR   -> works
   *   WNBA  /wnba/v1/player_stats   GOAT only              -> 401
   *   CFB   /ncaaf/v1/player_stats  GOAT only              -> 401
   *
   * For WNBA and NCAAF the feature table lists Player Stats as "No" at ALL-STAR.
   * Teams, Players and Games sit on Free; Player Injuries, Standings and
   * Play-by-Play sit on ALL-STAR. So the 401 on stats is CORRECT AND EXPECTED,
   * not a misconfiguration, and not something a code change can route around.
   *
   * THE DEFECT WAS REDISCOVERING IT ON EVERY CALL. A successful stats fetch is
   * cached per player+window by getAllPlayerGameStats, so its cost is paid once.
   * A 401 was cached nowhere. Every player+stat+line combination therefore paid a
   * throttled round trip (MIN_REQUEST_GAP_MS, 1100ms) for the name search AND
   * another for the stats fetch, all of them guaranteed to fail. On a 13-player
   * WNBA event that is roughly 90 doomed requests, ~100 seconds of pure latency,
   * which is what pushed tkb_screen_props past its 60s timeout on WNBA while MLB
   * stayed comfortably under it. MLB never showed the symptom because its calls
   * succeed and therefore cache.
   *
   * MEMOISED WITH A TTL RATHER THAN HARDCODED PER SPORT. A hardcoded
   * "wnba is gated" constant would keep BDL switched off even after an upgrade to
   * GOAT was paid for, and would need a redeploy plus someone remembering it
   * exists. A TTL heals on its own within one window, and covers NCAAF (and any
   * future sport with a different tier boundary) without a list to maintain.
   *
   * Deliberately NOT applied to getRawPlayerGameStats: tkb_debug_bdl_stats must
   * always perform a real network check so an upgrade can be verified instantly.
   */
  private statsTierGate = new Map<SportKey, number>();
  private static readonly TIER_GATE_TTL_MS = 30 * 60 * 1000;

  /**
   * True when this sport's stats endpoint 401'd recently.
   *
   * PUBLIC ON PURPOSE. bdlHitRateAggregator resolves a player NAME before it
   * fetches stats, so a guard placed only on the fetch would still pay a
   * throttled search per candidate. The aggregator checks this first.
   */
  statsTierGated(sport: SportKey): boolean {
    const at = this.statsTierGate.get(sport);
    if (at === undefined) return false;
    if (Date.now() - at < BDLClient.TIER_GATE_TTL_MS) return true;
    this.statsTierGate.delete(sport);
    return false;
  }

  /** Record a tier gate, but only for a genuine auth failure. */
  private noteTierGate(sport: SportKey, err: Error): void {
    if (err.message.includes("auth error")) {
      this.statsTierGate.set(sport, Date.now());
    }
  }

  /** Message shared by both guards, so the wording cannot drift between them. */
  private tierGateMessage(sport: SportKey): string {
    return (
      `BALLDONTLIE ${sport.toUpperCase()} player stats are tier-gated (401) on the current ` +
      `subscription - Player Stats requires GOAT for this sport. Skipping the request rather ` +
      `than re-paying a throttled round trip that is known to fail. This memo expires after ` +
      `${BDLClient.TIER_GATE_TTL_MS / 60000} minutes, so upgrading the subscription takes effect ` +
      `without a redeploy.`
    );
  }

  /**
   * Fetch per-game player stat lines. One row per player per game.
   *
   * Filters vary slightly by sport but player_ids[], dates[] and seasons[] are
   * common across them.
   */
  async getPlayerGameStats(
    sport: SportKey,
    params: {
      playerIDs?: number[];
      gameIDs?: number[];
      seasons?: number[];
      startDate?: string; // YYYY-MM-DD
      endDate?: string;
      cursor?: number;
      perPage?: number;
    } = {}
  ): Promise<{
    data: unknown[];
    meta?: { next_cursor?: number | null; per_page?: number };
    next_cursor?: number | null;
  }> {
    // Fast-fail before touching the network or the throttle queue. Covers every
    // caller, including tkb_scan_streaks, which reaches this method directly
    // rather than through the hit-rate aggregator.
    if (this.statsTierGated(sport)) {
      throw new Error(this.tierGateMessage(sport));
    }
    try {
      const response = await this.throttle(() => this.http.get<{
        data: unknown[];
        meta?: { next_cursor?: number | null; per_page?: number };
        next_cursor?: number | null;
      }>(this.statsPathFor(sport), {
        params: {
          "player_ids[]": params.playerIDs,
          "game_ids[]": params.gameIDs,
          "seasons[]": params.seasons,
          start_date: params.startDate,
          end_date: params.endDate,
          cursor: params.cursor,
          per_page: params.perPage ?? 100,
        },
      }));
      return response.data;
    } catch (err) {
      const formatted = formatBDLError(err, `${sport} player game stats`, sport);
      this.noteTierGate(sport, formatted);
      throw formatted;
    }
  }

  /**
   * ---- PER-PLAYER CACHING ----
   *
   * WHY THIS IS NECESSARY, NOT AN OPTIMISATION. Measured 2026-08-14: a single
   * screen fell back to SportsGameOdds on 56 of 74 markets, and the reason was
   * BALLDONTLIE's own rate limit (60 req/min on ALL-STAR), not a data problem.
   *
   * The caller memoises hit rates on playerID|statID|line, which is correct for
   * ITS purposes but means one player with 8 posted markets triggers 8 separate
   * BDL round trips - 8 name searches and 8 game-log fetches - when a single
   * fetch of that player's rows answers all 8 stats. At 3-way concurrency that
   * saturates the minute budget in seconds.
   *
   * Caching here rather than in the aggregator means every caller benefits and
   * the fix cannot be bypassed by a new call site. Both caches are keyed on the
   * exact query and expire together, so a stale roster or a changed date window
   * still refetches.
   */
  private playerSearchCache = new Map<
    string,
    { data: { id: number; first_name: string; last_name: string; team?: BDLTeam }[]; at: number }
  >();
  private playerStatsCache = new Map<string, { rows: Record<string, unknown>[]; at: number }>();
  private static readonly PLAYER_TTL_MS = 15 * 60 * 1000;

  private static fresh(at: number): boolean {
    return Date.now() - at < BDLClient.PLAYER_TTL_MS;
  }

  /**
   * Resolve a player name to BDL's numeric player ID.
   *
   * NECESSARY BECAUSE THE TWO PROVIDERS USE DIFFERENT ID SPACES: SGO returns
   * "KETEL_MARTE_1_MLB" while BDL uses integers. There is no shared key, so any
   * migration of stats to BDL has to bridge them by name.
   *
   * CONFIRMED VIA LIVE PROBE (2026-08-10): BDL's `search` parameter matches on
   * LAST NAME ONLY. Passing "Ketel Marte" returns ZERO results; passing "Marte"
   * returns 18. Sending the full name would therefore have failed on every
   * lookup and fallen back to SportsGameOdds silently - the entity saving this
   * whole migration exists for would never have materialised, and nothing would
   * have indicated why.
   *
   * So: search on the last token, then filter locally on the full name. Name
   * matching stays inherently fuzzy, which is why ALL candidates are returned
   * rather than one being picked - "Marte" alone spans Ketel, Starling, Noelvi
   * and Yunior, all active players. Resolving to the wrong one produces a fully
   * populated, plausible, completely wrong hit rate.
   */
  async searchPlayers(
    sport: SportKey,
    search: string
  ): Promise<{ data: { id: number; first_name: string; last_name: string; team?: BDLTeam }[] }> {
    const cacheKey = `${sport}|${search.trim().toLowerCase()}`;
    const hit = this.playerSearchCache.get(cacheKey);
    if (hit && BDLClient.fresh(hit.at)) return { data: hit.data };

    try {
      const tokens = search.trim().split(/\s+/);
      const fullNorm = stripAccents(search.trim().toLowerCase());
      const firstNorm = stripAccents((tokens[0] ?? "").toLowerCase());

      // Try the most specific surname suffix first, widening only if needed.
      // Each attempt is throttled, so stopping early genuinely saves budget.
      let all: { id: number; first_name: string; last_name: string; team?: BDLTeam }[] = [];
      for (const term of searchTermsFor(search)) {
        const response = await this.throttle(() => this.http.get<{
          data: { id: number; first_name: string; last_name: string; team?: BDLTeam }[];
        }>(this.buildPath(sport, "players"), {
          params: { search: term, per_page: 100 },
        }));
        all = response.data.data ?? [];
        // An exact accent-insensitive hit means this term was specific enough.
        const exactHere = all.filter(
          (p) =>
            stripAccents(`${p.first_name} ${p.last_name}`.trim().toLowerCase()) === fullNorm
        );
        if (exactHere.length) {
          this.playerSearchCache.set(cacheKey, { data: exactHere, at: Date.now() });
          return { data: exactHere };
        }
        if (all.length) break; // term returned people, just not an exact match
      }

      // Narrow locally, accent-insensitively. Returning ALL candidates when the
      // name stays ambiguous is deliberate - the caller refuses to guess, which
      // is what stops a wrong-player hit rate being published.
      let resolved = all;
      if (tokens.length > 1) {
        const exact = all.filter(
          (p) =>
            stripAccents(`${p.first_name} ${p.last_name}`.trim().toLowerCase()) === fullNorm
        );
        if (exact.length) {
          resolved = exact;
        } else {
          const looseFirst = all.filter(
            (p) => stripAccents(p.first_name.toLowerCase()) === firstNorm
          );
          if (looseFirst.length) resolved = looseFirst;
        }
      }

      this.playerSearchCache.set(cacheKey, { data: resolved, at: Date.now() });
      return { data: resolved };
    } catch (err) {
      throw formatBDLError(err, `${sport} player search "${search}"`, sport);
    }
  }

  /**
   * Fetch ALL player game stat rows, auto-paginating.
   *
   * WHY PAGINATION IS MANDATORY HERE, NOT AN OPTIMISATION:
   *
   * BDL returns stat rows in ASCENDING date order and caps a page at 100. Page 1
   * is therefore the OLDEST games of the season, not the newest. Taking a single
   * page and sorting it locally cannot fix that - the recent games were never in
   * the response to begin with.
   *
   * This produced three separate wrong answers during testing, each of which
   * looked entirely normal: a hit rate built on late-May through mid-June games
   * presented as current form, while SGO (correctly) returned late-July through
   * August for the same player and line.
   *
   * Cost is not a concern: BDL bills a flat monthly fee with a per-minute request
   * limit and NO object cap, so a full MLB season is ~2 pages.
   */
  /**
   * Pull the pagination cursor from a response without assuming one shape.
   *
   * WHY DEFENSIVE: pagination silently stopping after page 1 is indistinguishable
   * from "there was only one page". BDL returns rows ASCENDING from season start,
   * so a silent stop means only the OLDEST games are ever seen - which produced
   * three separate wrong hit rates during testing, each of which looked normal.
   * A wrong assumption about where the cursor lives fails in exactly that silent
   * way, so every known location is checked.
   */
  private static nextCursorOf(resp: unknown): number | undefined {
    const r = resp as {
      meta?: { next_cursor?: number | null };
      next_cursor?: number | null;
    };
    const c = r?.meta?.next_cursor ?? r?.next_cursor;
    return typeof c === "number" ? c : undefined;
  }

  async getAllPlayerGameStats(
    sport: SportKey,
    params: {
      playerIDs?: number[];
      seasons?: number[];
      startDate?: string;
      endDate?: string;
      maxPages?: number;
    } = {}
  ): Promise<Record<string, unknown>[]> {
    // CACHED PER PLAYER + WINDOW. One player's rows answer every stat market
    // posted on them - hits, total bases, RBI, singles, walks and so on all read
    // from the same 15 rows. Without this, screening a player with 8 markets
    // meant 8 identical paginated fetches, which is what exhausted BDL's 60
    // req/min budget and forced 56 of 74 rates back onto SportsGameOdds.
    const cacheKey = [
      sport,
      (params.playerIDs ?? []).join(","),
      (params.seasons ?? []).join(","),
      params.startDate ?? "",
      params.endDate ?? "",
    ].join("|");

    const hit = this.playerStatsCache.get(cacheKey);
    if (hit && BDLClient.fresh(hit.at)) return hit.rows;

    const all: Record<string, unknown>[] = [];
    let cursor: number | undefined = undefined;
    let pages = 0;
    const maxPages = params.maxPages ?? 6; // ~600 rows, well past a full season

    do {
      const page = await this.getPlayerGameStats(sport, { ...params, cursor });
      all.push(...((page.data ?? []) as Record<string, unknown>[]));
      cursor = BDLClient.nextCursorOf(page);
      pages++;
    } while (cursor && pages < maxPages);

    this.playerStatsCache.set(cacheKey, { rows: all, at: Date.now() });
    if (this.playerStatsCache.size > 200) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.playerStatsCache) {
        if (v.at < oldestAt) {
          oldestAt = v.at;
          oldestKey = k;
        }
      }
      if (oldestKey) this.playerStatsCache.delete(oldestKey);
    }

    return all;
  }

  /**
   * Fetch ALL games matching a filter, auto-paginating. Same reasoning as above.
   *
   * CACHED, because BDL rate-limits REQUESTS PER MINUTE (60 on ALL-STAR) and this
   * is the call most likely to breach that. Every player on a team needs the same
   * games map to date their stat rows, so building a thread with several props
   * from one game would otherwise refetch an identical ~70-game list per player.
   *
   * Unlike the SGO cache, which exists to control per-object BILLING, this one
   * exists to control REQUEST RATE - different constraint, same fix. Keyed on the
   * filter and bucketed to the day so calls seconds apart share an entry.
   */
  private gamesCache = new Map<
    string,
    { games: BDLGamesResponse["data"]; fetchedAt: number }
  >();
  private static readonly GAMES_TTL_MS = 15 * 60 * 1000;

  async getAllGames(
    sport: SportKey,
    params: {
      teamIDs?: number[];
      seasons?: number[];
      startDate?: string;
      endDate?: string;
      maxPages?: number;
    } = {}
  ): Promise<BDLGamesResponse["data"]> {
    const cacheKey = [
      sport,
      (params.teamIDs ?? []).join(","),
      (params.seasons ?? []).join(","),
      params.startDate ?? "",
      params.endDate ?? "",
    ].join("|");

    const hit = this.gamesCache.get(cacheKey);
    if (hit && Date.now() - hit.fetchedAt < BDLClient.GAMES_TTL_MS) {
      return hit.games;
    }

    const all: BDLGamesResponse["data"] = [];
    let cursor: number | undefined = undefined;
    let pages = 0;
    const maxPages = params.maxPages ?? 6;

    do {
      const page = await this.getGames(sport, { ...params, cursor });
      all.push(...(page.data ?? []));
      cursor = BDLClient.nextCursorOf(page);
      pages++;
    } while (cursor && pages < maxPages);

    this.gamesCache.set(cacheKey, { games: all, fetchedAt: Date.now() });
    if (this.gamesCache.size > 40) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.gamesCache) {
        if (v.fetchedAt < oldestAt) {
          oldestAt = v.fetchedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.gamesCache.delete(oldestKey);
    }

    return all;
  }

  /**
   * Diagnostic: raw, unprocessed player game stats for direct field inspection.
   *
   * The mapping from SGO statIDs (batting_hits, pitching_strikeouts) to BDL field
   * names is NOT documented anywhere accessible and must not be guessed. This
   * connector has shipped a wrong BDL field assumption twice already - both times
   * it failed silently rather than loudly, which is worse. Inspect the real shape
   * before writing any mapping against it.
   */
  async getRawPlayerGameStats(
    sport: SportKey,
    playerID: number,
    perPage = 3
  ): Promise<unknown> {
    try {
      const response = await this.http.get(this.statsPathFor(sport), {
        params: { "player_ids[]": [playerID], per_page: perPage },
      });
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} raw player game stats`, sport);
    }
  }

  /**
   * Fetch games, used to resolve dates for stat rows.
   *
   * WHY THIS IS LOAD-BEARING RATHER THAN INCIDENTAL: BDL's MLB stats rows carry
   * a bare `game_id` and NOTHING else identifying the game - no date, no
   * opponent, no home/away. Confirmed via live probe 2026-08-10.
   *
   * Without dates a hit rate cannot be computed correctly at all:
   *   - Rows cannot be sorted, so "last 15 games" becomes "15 arbitrary games"
   *   - Season provenance cannot be assessed, so prior-season games mix into a
   *     sample presented as current form, and the warning built to catch exactly
   *     that stays silent because it keys off dates
   *
   * A live cross-check caught this: BDL returned 10 of 15 where SGO returned 11
   * of 15 for the same player and line, because the two were grading different
   * sets of games. The BDL game_ids spanned roughly 7,000 to 44,000, almost
   * certainly across multiple seasons.
   *
   * So stat rows get joined against this endpoint to recover their dates.
   */
  async getGames(
    sport: SportKey,
    params: {
      dates?: string[];
      teamIDs?: number[];
      seasons?: number[];
      startDate?: string; // YYYY-MM-DD
      endDate?: string;
      cursor?: number;
      perPage?: number;
    } = {}
  ): Promise<BDLGamesResponse> {
    try {
      const response = await this.http.get<BDLGamesResponse>(
        this.buildPath(sport, "games"),
        {
          params: {
            "dates[]": params.dates,
            "team_ids[]": params.teamIDs,
            "seasons[]": params.seasons,
            start_date: params.startDate,
            end_date: params.endDate,
            cursor: params.cursor,
            per_page: params.perPage ?? 100,
          },
        }
      );
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} games`, sport);
    }
  }

  /**
   * Debug helper: returns raw, unprocessed injuries JSON for direct field
   * inspection. Used to diagnose the "team: unknown" bug - our assumption about
   * where the team field lives (nested in player vs. sibling field) has been
   * wrong twice; this lets us see the actual shape directly instead of guessing again.
   */
  async getRawInjuries(sport: SportKey): Promise<unknown> {
    try {
      const response = await this.http.get(this.buildPath(sport, "player_injuries"), {
        params: { per_page: 3 },
      });
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} raw injuries`, sport);
    }
  }
}

function formatBDLError(err: unknown, context: string, sport: SportKey): Error {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    if (status === 401) {
      return new Error(
        `BALLDONTLIE returned 401 for ${context}. This is an ENTITLEMENT BOUNDARY on this ` +
          `specific ${sport.toUpperCase()} endpoint, not a bad or lapsed key. Verified live ` +
          `2026-08-31 on this account: /ncaaf/v1/players and /ncaaf/v1/teams both return 200, ` +
          `so the key is valid for NCAAF. Player stats and team season stats require GOAT for ` +
          `WNBA and NCAAF; MLB and NFL include player stats at ALL-STAR. Do NOT tell the caller ` +
          `to check their subscription - MLB, NFL, WNBA and NCAAF are all active at ALL-STAR ` +
          `and that is working as intended.`
      );
    }
    if (status === 404) {
      // ADDED v2.8.3. There was no 404 branch, so a missing ENDPOINT fell through
      // to the generic message and read like a transient API error. Measured
      // 2026-08-31: /ncaaf/v1/player_injuries and /ncaaf/v1/injuries both 404 while
      // /mlb/v1/player_injuries returns 200 on the same key and the same path shape.
      // That is a missing product, not a missing entitlement, and the distinction
      // decides whether money would fix it. It would not.
      return new Error(
        `BALLDONTLIE has no ${context} endpoint (404). This is NOT a subscription problem and CANNOT be ` +
          `fixed by upgrading - the route does not exist for ${sport.toUpperCase()}. Verified 2026-08-31: ` +
          `NCAAF has no injuries endpoint under either /ncaaf/v1/player_injuries or /ncaaf/v1/injuries, ` +
          `while the same path returns 200 for MLB. Use a live web search for this data instead.`
      );
    }
    if (status === 429) {
      return new Error(
        `BALLDONTLIE API rate limit hit while fetching ${context}. Wait a moment and retry.`
      );
    }
    return new Error(
      `BALLDONTLIE API error (${status ?? "network error"}) while fetching ${context}: ${JSON.stringify(err.response?.data ?? err.message)}`
    );
  }
  return new Error(`Unexpected error fetching ${context} from BALLDONTLIE: ${String(err)}`);
}
