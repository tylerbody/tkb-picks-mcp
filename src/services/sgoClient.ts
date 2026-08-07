import axios, { type AxiosInstance, AxiosError } from "axios";
import { SGO_BASE_URL, SPORT_CONFIG, type SportKey } from "../constants.js";
import type { SGOEventsResponse, SGOTeam } from "../types.js";

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
    includeOpposingOdds?: boolean;
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
