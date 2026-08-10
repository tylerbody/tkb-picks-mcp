import axios, { type AxiosInstance, AxiosError } from "axios";
import { BDL_BASE_URL, SPORT_CONFIG, type SportKey } from "../constants.js";
import type {
  BDLInjuriesResponse,
  BDLGamesResponse,
  BDLStandingsResponse,
  BDLTeam,
} from "../types.js";

/**
 * BALLDONTLIE API client - used ONLY for injuries in this build (per current scope;
 * SGO remains the sole source for odds/lines to avoid maintaining two odds pipelines).
 *
 * One account, one API key. Access per sport depends on which sport's subscription
 * tier is active on the account - this client does not enforce that, the API itself
 * will 401 if a sport isn't subscribed at ALL-STAR or above.
 *
 * Base path is per-sport: https://api.balldontlie.io/{sport}/v1/...
 * NOTE: MLB/NFL/NBA/NHL historically used un-prefixed /v1/ paths for some endpoints
 * (see docs). Confirm the exact path shape per sport on first live test - this
 * client assumes the {sport}/v1/ prefix pattern shown in BALLDONTLIE's EPL/Ligue1
 * docs is consistent across all sports. Adjust buildPath() below if a given sport
 * turns out to use a different convention.
 */

export class BDLClient {
  private http: AxiosInstance;

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
   * TIER REQUIREMENT: player stats are listed as ALL-STAR ($9.99/sport), the tier
   * already subscribed for MLB and WNBA. That is sourced from third-party
   * documentation rather than BDL's own pricing page, so it is UNVERIFIED until a
   * live call either returns data or 401s. tkb_debug_bdl_stats exists to settle it.
   */
  private statsPathFor(sport: SportKey): string {
    const { bdlPath } = SPORT_CONFIG[sport];
    // MLB and NFL use /stats; WNBA and NCAAF use /player_stats.
    const endpoint = sport === "mlb" || sport === "nfl" ? "stats" : "player_stats";
    return `/${bdlPath}/v1/${endpoint}`;
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
  ): Promise<{ data: unknown[]; meta?: { next_cursor?: number | null } }> {
    try {
      const response = await this.http.get<{
        data: unknown[];
        meta?: { next_cursor?: number | null };
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
      });
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} player game stats`, sport);
    }
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
    try {
      // Search the last token - BDL matches last name, not full name.
      const tokens = search.trim().split(/\s+/);
      const lastName = tokens.length > 1 ? tokens[tokens.length - 1]! : search;

      const response = await this.http.get<{
        data: { id: number; first_name: string; last_name: string; team?: BDLTeam }[];
      }>(this.buildPath(sport, "players"), {
        params: { search: lastName, per_page: 100 },
      });

      const all = response.data.data ?? [];

      // When a full name was supplied, narrow locally to those that actually
      // match it. Fall back to the unfiltered set so the caller still sees the
      // candidates and can decide, rather than getting a bare "not found".
      if (tokens.length > 1) {
        const full = search.trim().toLowerCase();
        const exact = all.filter(
          (p) => `${p.first_name} ${p.last_name}`.trim().toLowerCase() === full
        );
        if (exact.length) return { data: exact };

        const firstName = tokens[0]!.toLowerCase();
        const looseFirst = all.filter((p) => p.first_name.toLowerCase() === firstName);
        if (looseFirst.length) return { data: looseFirst };
      }

      return { data: all };
    } catch (err) {
      throw formatBDLError(err, `${sport} player search "${search}"`, sport);
    }
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
        `BALLDONTLIE API auth error while fetching ${context}. This usually means the ${sport.toUpperCase()} subscription on this BALLDONTLIE account isn't at ALL-STAR tier or above. Check the account dashboard at app.balldontlie.io.`
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
