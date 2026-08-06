import axios, { type AxiosInstance, AxiosError } from "axios";
import { SGO_BASE_URL, SPORT_CONFIG, type SportKey } from "../constants.js";
import type { SGOEventsResponse } from "../types.js";

/**
 * SportsGameOdds API client.
 *
 * IMPORTANT - fields flagged as UNVERIFIED below have not been confirmed against
 * a live API response (this codebase was built without live network access to
 * SGO's API). Test these specifically on first real deployment:
 *
 *   1. `lineups` field on the event object - does it include confirmed/probable
 *      starting pitchers pre-game, or only post-game? (relevant for MLB pitcher props)
 *   2. Player `teamID` update speed after a real trade - test against a recently
 *      traded player and compare to when the trade was actually reported.
 *
 * If either of these don't match what's assumed here, update this file and
 * the tools that depend on it (getSchedule, getPlayerHitRate) accordingly.
 */

export class SGOClient {
  private http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: SGO_BASE_URL,
      headers: { "x-api-key": apiKey },
      timeout: 15000,
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
