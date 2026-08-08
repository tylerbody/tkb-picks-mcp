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

  async getGames(
    sport: SportKey,
    params: { dates?: string[]; team_ids?: number[]; cursor?: number } = {}
  ): Promise<BDLGamesResponse> {
    try {
      const response = await this.http.get<BDLGamesResponse>(
        this.buildPath(sport, "games"),
        {
          params: {
            "dates[]": params.dates,
            "team_ids[]": params.team_ids,
            cursor: params.cursor,
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
