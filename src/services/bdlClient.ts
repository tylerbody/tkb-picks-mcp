import axios, { type AxiosInstance, AxiosError } from "axios";
import { BDL_BASE_URL, SPORT_CONFIG, type SportKey } from "../constants.js";
import type { BDLInjuriesResponse, BDLGamesResponse } from "../types.js";

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
          },
        }
      );
      return response.data;
    } catch (err) {
      throw formatBDLError(err, `${sport} injuries`, sport);
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
