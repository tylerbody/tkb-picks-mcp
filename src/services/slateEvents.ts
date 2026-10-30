import type { SGOClient } from "./sgoClient.js";
import { nextCursorOfEvents } from "./sgoClient.js";
import type { SGOEvent } from "../types.js";

/**
 * SLATE ENUMERATION THAT CANNOT BE HIDDEN BY THE ODD FILTER. ADDED v2.20.2.
 *
 * MEASURED 2026-10-30. Every ranged event fetch in this connector attached ONE
 * narrowing oddID (the home moneyline) to keep payloads small, on the documented
 * belief that the filter "shapes odds only, it does not decide WHICH EVENTS come
 * back". For NCAAB that belief failed the check: SGO returned 24 events for
 * Nov 1-12, while ESPN's Division I scoreboard for Nov 2 lists games SGO never
 * returned at all (Grambling @ Northern Illinois, App State @ Merrimack, Winthrop @
 * Queens, UTEP @ Northern Kentucky), and the owner counts 77 reachable games.
 *
 * So the slate is now enumerated TWICE and unioned by eventID:
 *   1. the filtered fetch (cheap, what every tool did before);
 *   2. an UNFILTERED fetch, paged by hand, with each page's odds and players
 *      stripped immediately so memory stays bounded to one page (the unfiltered
 *      payload carries every market; this connector has been OOM-killed once).
 * The result reports how many events ONLY the unfiltered fetch found, so the next
 * live run measures whether the filter was the cause instead of assuming it.
 *
 * Events found only by the unfiltered fetch have NO odds attached here. Callers
 * that need prices fetch them by eventID, which SGO documents as ignoring every
 * other filter.
 */

export interface SlateEnumeration {
  events: SGOEvent[];
  filteredCount: number;
  unfilteredCount: number;
  /** EventIDs that ONLY the unfiltered fetch returned. */
  onlyUnfiltered: string[];
  /** True when either pass could not prove it reached the end. */
  truncated: boolean;
  unfilteredError: string | null;
}

const UNFILTERED_MAX_PAGES = 25;
const UNFILTERED_PAGE = 100;

export async function enumerateSlate(
  sgo: Pick<SGOClient, "getAllEvents" | "getEvents" | "lastFetchTruncated">,
  params: { leagueID: string; startsAfter?: string; startsBefore?: string; oddIDs: string }
): Promise<SlateEnumeration> {
  const filtered = await sgo.getAllEvents({
    leagueID: params.leagueID,
    startsAfter: params.startsAfter,
    startsBefore: params.startsBefore,
    limit: 100,
    maxEvents: 1000,
    oddIDs: params.oddIDs,
  }, 25);
  let truncated = Boolean(sgo.lastFetchTruncated);

  const byID = new Map<string, SGOEvent>();
  for (const e of filtered) if (e.eventID) byID.set(e.eventID, e);

  let unfilteredCount = 0;
  const onlyUnfiltered: string[] = [];
  let unfilteredError: string | null = null;
  try {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await sgo.getEvents({
        leagueID: params.leagueID,
        startsAfter: params.startsAfter,
        startsBefore: params.startsBefore,
        limit: UNFILTERED_PAGE,
        cursor,
      });
      for (const raw of page.data ?? []) {
        unfilteredCount++;
        if (!raw.eventID || byID.has(raw.eventID)) continue;
        // Strip the heavy maps NOW; a schedule never reads them.
        const { odds: _o, players: _p, ...light } = raw as SGOEvent & { odds?: unknown; players?: unknown };
        byID.set(raw.eventID, { ...(light as SGOEvent), odds: {}, players: {} } as SGOEvent);
        onlyUnfiltered.push(raw.eventID);
      }
      cursor = nextCursorOfEvents(page);
      pages++;
    } while (cursor && pages < UNFILTERED_MAX_PAGES);
    if (cursor) truncated = true;
  } catch (err) {
    unfilteredError = err instanceof Error ? err.message : String(err);
  }

  const events = [...byID.values()].sort((a, b) =>
    String(a.status?.startsAt ?? "").localeCompare(String(b.status?.startsAt ?? ""))
  );
  return { events, filteredCount: filtered.length, unfilteredCount, onlyUnfiltered, truncated, unfilteredError };
}
