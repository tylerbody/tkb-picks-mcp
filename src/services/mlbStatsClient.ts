import axios, { type AxiosInstance } from "axios";

/**
 * MLB STATS API CLIENT (statsapi.mlb.com).
 *
 * NO KEY, NO QUOTA, AND NO SGO OBJECTS. This is the only source in the connector
 * with no billing model at all, which changes the cost calculus: the constraint
 * here is LATENCY against the 60-second tool ceiling, not spend.
 *
 * WHAT GAP THIS CLOSES. The README has recorded, since v2.6.4, that SGO events carry
 * no `lineups` field - confirmed live via tkb_probe_event_fields against an upcoming
 * game - and that "confirmed starting pitchers still require a live web search, per
 * game, per date." That manual step exists because a Chris Sale rotation shuffle
 * produced a published error. This replaces the search with a real feed.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * NO BATTER-VS-PITCHER. The endpoint exists and needs no key, and it was left out on
 * purpose. Measured 2026-08-31: Aaron Judge against Clayton Kershaw returns TWO
 * career plate appearances. That is the typical BvP sample, not an unlucky draw.
 * This connector's own floor is eight appearances and its own words are "a rate on
 * 1 game is NOT a hit rate and must not be quoted as one". Shipping BvP would be the
 * first thing in the codebase to contradict its own sample-sufficiency rule, and it
 * would hand the writer a number that reads as evidence and is noise.
 *
 * NO UMPIRE. The assignment is real - boxscore `officials[]` carries officialType
 * "Home Plate", verified on a final game. But it is ABSENT from a scheduled game's
 * boxscore, so it arrives too late to inform a pre-game thread, and an assignment is
 * not a tendency: "this umpire runs high on strikeouts" needs a season aggregated per
 * umpire, which is its own project with its own budget. Left for later, deliberately.
 */

const MLB_BASE_URL = "https://statsapi.mlb.com/api/v1";

/** Schedules move as lineups post, so this is short. Nothing here is immutable. */
const SCHEDULE_TTL_MS = 5 * 60 * 1000;

export interface MlbProbablePitcher {
  id: number;
  fullName: string;
}

export interface MlbLineupSlot {
  /** 1 through 9. The array position in MLB's lineup array IS the batting slot. */
  battingOrder: number;
  playerId: number;
  fullName: string;
  position: string | null;
}

export interface MlbGameMatchup {
  gamePk: number;
  gameDate: string;
  detailedState: string;
  homeTeam: string;
  awayTeam: string;
  homeProbablePitcher: MlbProbablePitcher | null;
  awayProbablePitcher: MlbProbablePitcher | null;
  /** Empty until the lineup is posted, typically 3 to 4 hours before first pitch. */
  homeLineup: MlbLineupSlot[];
  awayLineup: MlbLineupSlot[];
}

interface CacheEntry {
  games: MlbGameMatchup[];
  fetchedAt: number;
}

export class MLBStatsClient {
  private http: AxiosInstance;
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<MlbGameMatchup[]>>();
  private stats = { requests: 0, hits: 0, misses: 0, coalesced: 0, errors: 0 };

  constructor() {
    this.http = axios.create({
      baseURL: MLB_BASE_URL,
      timeout: 15_000,
      headers: { Accept: "application/json" },
    });
  }

  /**
   * Every game on one date, with probable pitchers and lineups if posted.
   *
   * ONE REQUEST PER DATE, NOT PER GAME. A fifteen-game slate needs one call, and
   * every per-game consumer reads from it. There is no quota to protect here, but
   * the 60-second tool ceiling is real and fifteen sequential HTTP round trips
   * inside a screener would be felt.
   */
  async getScheduleForDate(dateISO: string): Promise<MlbGameMatchup[]> {
    const hit = this.cache.get(dateISO);
    if (hit && Date.now() - hit.fetchedAt < SCHEDULE_TTL_MS) {
      this.stats.hits++;
      return hit.games;
    }

    const pending = this.inFlight.get(dateISO);
    if (pending) {
      this.stats.coalesced++;
      return pending;
    }

    this.stats.misses++;
    const work = this.fetchSchedule(dateISO);
    this.inFlight.set(dateISO, work);
    try {
      const games = await work;
      this.cache.set(dateISO, { games, fetchedAt: Date.now() });
      return games;
    } finally {
      this.inFlight.delete(dateISO);
    }
  }

  private async fetchSchedule(dateISO: string): Promise<MlbGameMatchup[]> {
    this.stats.requests++;
    try {
      const res = await this.http.get("/schedule", {
        params: {
          sportId: 1,
          date: dateISO,
          hydrate: "probablePitcher,lineups,team",
        },
      });
      const dates = Array.isArray(res.data?.dates) ? res.data.dates : [];
      const out: MlbGameMatchup[] = [];
      for (const d of dates) {
        for (const g of d.games ?? []) {
          out.push(normaliseGame(g));
        }
      }
      return out;
    } catch (err) {
      this.stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MLB Stats API schedule failed for ${dateISO}: ${msg}`);
    }
  }

  getStats(): typeof this.stats & { cachedDates: number } {
    return { ...this.stats, cachedDates: this.cache.size };
  }
}

/**
 * READ THE PROVIDER'S SHAPE DEFENSIVELY, checking candidate keys in order.
 *
 * Same reasoning as bdlStatMap and cfbdStatMap. statsapi is unauthenticated and
 * UNVERSIONED, which makes it more likely than either paid provider to change a
 * field name without warning, not less. Everything unresolvable returns null rather
 * than a substituted value.
 */
function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return null;
}

function readPitcher(side: Record<string, unknown> | undefined): MlbProbablePitcher | null {
  const p = side?.probablePitcher as Record<string, unknown> | undefined;
  if (!p) return null;
  const id = Number(p.id);
  const fullName = firstString(p.fullName, p.lastFirstName);
  if (!Number.isFinite(id) || !fullName) return null;
  return { id, fullName };
}

/**
 * THE BATTING SLOT IS THE ARRAY POSITION.
 *
 * MLB returns lineups.homePlayers as an ordered array of nine, so index 0 is the
 * leadoff hitter. This is cleaner than the boxscore's per-player `battingOrder`
 * field, which encodes slot-plus-substitution as a string ("102" is the second
 * player to occupy the leadoff spot) and only populates once a game is underway.
 *
 * WHY THE SLOT IS WORTH CARRYING AT ALL: a leadoff hitter gets roughly 0.7 more
 * plate appearances than a seven-hole hitter, which is most of the edge on a 0.5
 * hits or 1.5 total bases line. It is the difference between a prop and the same
 * prop with a reason.
 */
function readLineup(players: unknown): MlbLineupSlot[] {
  if (!Array.isArray(players)) return [];
  const out: MlbLineupSlot[] = [];
  players.forEach((raw, i) => {
    const p = raw as Record<string, unknown>;
    const id = Number(p.id);
    const fullName = firstString(p.fullName, p.useName);
    if (!Number.isFinite(id) || !fullName) return;
    const pos = p.primaryPosition as Record<string, unknown> | undefined;
    out.push({
      battingOrder: i + 1,
      playerId: id,
      fullName,
      position: firstString(pos?.abbreviation, pos?.name),
    });
  });
  return out;
}

export function normaliseGame(g: Record<string, unknown>): MlbGameMatchup {
  const teams = (g.teams ?? {}) as Record<string, Record<string, unknown>>;
  const lineups = (g.lineups ?? {}) as Record<string, unknown>;
  const status = (g.status ?? {}) as Record<string, unknown>;
  const home = teams.home ?? {};
  const away = teams.away ?? {};
  const homeTeamObj = (home.team ?? {}) as Record<string, unknown>;
  const awayTeamObj = (away.team ?? {}) as Record<string, unknown>;

  return {
    gamePk: Number(g.gamePk),
    gameDate: firstString(g.gameDate) ?? "unknown",
    detailedState: firstString(status.detailedState, status.abstractGameState) ?? "unknown",
    homeTeam: firstString(homeTeamObj.name) ?? "unknown",
    awayTeam: firstString(awayTeamObj.name) ?? "unknown",
    homeProbablePitcher: readPitcher(home),
    awayProbablePitcher: readPitcher(away),
    homeLineup: readLineup(lineups.homePlayers),
    awayLineup: readLineup(lineups.awayPlayers),
  };
}

/** Loose team-name matching across providers ("Athletics" vs "Oakland Athletics"). */
export function teamNamesMatch(a: string, b: string): boolean {
  const n = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z ]/g, "")
      .trim();
  const na = n(a);
  const nb = n(b);
  if (na === nb) return true;
  // Nickname match on the last word, which is what actually differs between feeds.
  const lastA = na.split(" ").pop() ?? "";
  const lastB = nb.split(" ").pop() ?? "";
  return lastA.length > 3 && lastA === lastB;
}
