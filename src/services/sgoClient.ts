import axios, { type AxiosInstance, AxiosError } from "axios";
import { SGO_BASE_URL, SPORT_CONFIG, type SportKey } from "../constants.js";
import type { SGOEventsResponse, SGOTeam, SGOPlayer } from "../types.js";

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
   */
  async getAllEvents(
    params: Parameters<SGOClient["getEvents"]>[0],
    maxPages = 10
  ) {
    const allEvents = [];
    let cursor: string | undefined = undefined;
    let pages = 0;

    do {
      const page: SGOEventsResponse = await this.getEvents({
        ...params,
        cursor,
        limit: params.limit ?? 100,
      });
      allEvents.push(...page.data);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < maxPages);

    return allEvents;
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
   * tkb_debug_raw_event, which pulls the entire event object including its odds
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
