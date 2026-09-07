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

/** Rosters move slowly. A day is ample and keeps this to one fetch per process. */
const PLAYER_INDEX_TTL_MS = 12 * 60 * 60 * 1000;

export interface MlbProbablePitcher {
  id: number;
  fullName: string;
}

/** One player's identity and current club, from the season-wide player index. */
export interface MlbPlayerRef {
  id: number;
  fullName: string;
  teamId: number | null;
  teamName: string | null;
}

/**
 * WHY A PLAYER INDEX EXISTS AT ALL (added v2.8.1).
 *
 * v2.8.0 answered "is this hitter in tonight's lineup" by scanning the posted
 * lineups on the date and, finding none posted, replying "LINEUP NOT POSTED YET".
 * That validated the LINEUP STATE and never the PREMISE.
 *
 * MEASURED IN VERIFICATION: asking for Mookie Betts on 2026-08-31 returned a
 * confident "not posted yet" for a date the Dodgers were not playing at all. Asking
 * for "Zzzz Notaplayer" returned the identical reassuring message. Both are exactly
 * the failure this connector exists to prevent - a plausible, calm, wrong answer
 * that a polling job would wait on forever.
 *
 * The asymmetry was the tell. Once a lineup IS posted the tool hedges carefully on
 * spelling, because a posted lineup gives it a roster to check against. Before one
 * is posted it had nothing to check against, and absence of a way to verify became
 * absence of doubt.
 *
 * /sports/1/players returns every player for a season with currentTeam in ONE
 * unauthenticated call, which turns one guess into four distinguishable answers.
 */
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
  /**
   * TEAM IDS ARE THE JOIN KEY, NOT NAMES (added v2.8.2).
   *
   * v2.8.1 matched a player to a game by team NAME, read from the player index's
   * currentTeam.name. Verified broken the same day: for season 2026 that endpoint
   * returns currentTeam as {"id":144} with NO name field, while for 2025 it returns
   * both. So every 2026 player resolved to a null team and every query answered
   * "team not scheduled" - including Matt Olson, whose Braves were playing that
   * night. That is the v2.8.0 bug inverted: one confident wrong answer traded for
   * another, in the opposite direction.
   *
   * Numeric IDs are present in both the schedule and the player index, are stable
   * across seasons, and need no fuzzy matching. Names remain for display only.
   */
  homeTeamId: number | null;
  awayTeamId: number | null;
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
  private playerIndex: { byName: Map<string, MlbPlayerRef[]>; fetchedAt: number } | null = null;
  private playerIndexInFlight: Promise<Map<string, MlbPlayerRef[]>> | null = null;
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

  /**
   * EVERY PLAYER FOR A SEASON, WITH THEIR CURRENT CLUB, IN ONE CALL.
   *
   * PAGINATION IS HANDLED RATHER THAN ASSUMED AWAY. /sports/1/players is documented
   * as returning the full set, and a spot check showed roughly 1,400 entries, but
   * this repo has been burned once already by assuming a provider returned
   * everything: v2.0.3 found BDL paging at 100 rows ascending from season start, so
   * page one was always the OLDEST games and no amount of local sorting could
   * recover the recent ones. The cost of checking for a cursor is one comparison.
   */
  async getPlayerIndex(season: number): Promise<Map<string, MlbPlayerRef[]>> {
    if (this.playerIndex && Date.now() - this.playerIndex.fetchedAt < PLAYER_INDEX_TTL_MS) {
      this.stats.hits++;
      return this.playerIndex.byName;
    }
    if (this.playerIndexInFlight) {
      this.stats.coalesced++;
      return this.playerIndexInFlight;
    }

    const work = (async () => {
      this.stats.misses++;
      this.stats.requests++;
      const res = await this.http.get("/sports/1/players", { params: { season } });
      const people = Array.isArray(res.data?.people) ? res.data.people : [];
      const byName = new Map<string, MlbPlayerRef[]>();
      for (const raw of people as Record<string, unknown>[]) {
        const id = Number(raw.id);
        const fullName = firstString(raw.fullName, raw.nameFirstLast);
        if (!Number.isFinite(id) || !fullName) continue;
        const team = (raw.currentTeam ?? {}) as Record<string, unknown>;
        const ref: MlbPlayerRef = {
          id,
          fullName,
          teamId: Number.isFinite(Number(team.id)) ? Number(team.id) : null,
          teamName: firstString(team.name),
        };
        const key = normaliseName(fullName);
        const bucket = byName.get(key);
        // SAME NAME, DIFFERENT PLAYERS IS REAL. Kept as a list so the caller can
        // refuse on ambiguity rather than silently resolving to the first match,
        // which is the rule v2.0.1 set when eighteen "Marte" rows came back.
        if (bucket) bucket.push(ref);
        else byName.set(key, [ref]);
      }
      // A COUNT THAT LOOKS LIKE A PAGE SIZE IS A WARNING, NOT A RESULT. This
      // endpoint is documented as returning the full set and no cursor field is
      // present, but v2.0.3 was caused by exactly this assumption on another
      // provider, so an obviously-truncated response says so in the logs rather
      // than silently yielding a partial index that would report real players as
      // not existing.
      if ([100, 250, 500, 1000].includes(people.length)) {
        console.warn(
          `WARN: MLB player index returned exactly ${people.length} entries, which ` +
            `matches a common page size. If this endpoint has started paginating, ` +
            `the index is PARTIAL and real players will be reported as unknown.`
        );
      }
      this.playerIndex = { byName, fetchedAt: Date.now() };
      return byName;
    })();

    this.playerIndexInFlight = work;
    try {
      return await work;
    } catch (err) {
      this.stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`MLB Stats API player index failed for ${season}: ${msg}`);
    } finally {
      this.playerIndexInFlight = null;
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

  const numOrNull = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);

  return {
    gamePk: Number(g.gamePk),
    gameDate: firstString(g.gameDate) ?? "unknown",
    detailedState: firstString(status.detailedState, status.abstractGameState) ?? "unknown",
    homeTeam: firstString(homeTeamObj.name) ?? "unknown",
    awayTeam: firstString(awayTeamObj.name) ?? "unknown",
    homeTeamId: numOrNull(homeTeamObj.id),
    awayTeamId: numOrNull(awayTeamObj.id),
    homeProbablePitcher: readPitcher(home),
    awayProbablePitcher: readPitcher(away),
    homeLineup: readLineup(lineups.homePlayers),
    awayLineup: readLineup(lineups.awayPlayers),
  };
}

/** Accent- and case-insensitive key for name lookups. */
export function normaliseName(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Loose team-name matching across providers ("Athletics" vs "Oakland Athletics"). */
export function teamNamesMatch(a: string, b: string): boolean {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (na === nb) return true;
  // Nickname match on the last word, which is what actually differs between feeds.
  const lastA = na.split(" ").pop() ?? "";
  const lastB = nb.split(" ").pop() ?? "";
  return lastA.length > 3 && lastA === lastB;
}

/**
 * THE FOUR-STATE ANSWER TO "IS THIS HITTER PLAYING TONIGHT".
 *
 * v2.8.0 collapsed all of these into one reassuring "LINEUP NOT POSTED YET", which
 * is correct for exactly one of them and a confident falsehood for three:
 *
 *   asked for Mookie Betts on a date the Dodgers did not play  -> "not posted yet"
 *   asked for "Zzzz Notaplayer"                                -> "not posted yet"
 *
 * A polling job would wait forever on either. Splitting the states is the fix, and
 * the reason it is a pure function is the rule v2.6.1 and v2.6.3 both landed on:
 * logic that changes which answer reaches the user is correctness logic, and burying
 * it inside a function that needs a network client makes it unassertable.
 */
export type PlayerLineupStatus =
  | { kind: "in_lineup"; slot: MlbLineupSlot; teamName: string; opponent: string }
  | { kind: "not_in_posted_lineup"; teamName: string }
  | { kind: "lineup_pending"; teamName: string; opponent: string }
  | { kind: "team_not_scheduled"; teamName: string }
  | { kind: "team_unresolved" }
  | { kind: "player_unknown" }
  | { kind: "ambiguous"; candidates: MlbPlayerRef[] };

export function resolvePlayerLineupStatus(
  games: MlbGameMatchup[],
  candidates: MlbPlayerRef[] | undefined,
  playerName: string
): PlayerLineupStatus {
  // 1. DOES THIS PLAYER EXIST? Checked FIRST, because every downstream answer is a
  //    statement about a real person and saying anything reassuring about a name
  //    that resolves to nobody is the v2.8.0 bug.
  if (!candidates || candidates.length === 0) return { kind: "player_unknown" };
  if (candidates.length > 1) return { kind: "ambiguous", candidates };

  const player = candidates[0];

  // 2. IS HIS TEAM EVEN PLAYING? The premise v2.8.0 never checked.
  //
  // MATCH ON ID FIRST. v2.8.1 matched on name and broke the moment the player index
  // stopped returning currentTeam.name for the current season, silently answering
  // "team not scheduled" for every player in the league. The numeric id is present
  // on both sides and needs no normalisation; the name path survives only as a
  // fallback for a feed that omits the id instead.
  const byId =
    player.teamId !== null
      ? games.find((g) => g.homeTeamId === player.teamId || g.awayTeamId === player.teamId)
      : undefined;

  const byName =
    !byId && player.teamName
      ? games.find(
          (g) => teamNamesMatch(g.homeTeam, player.teamName!) || teamNamesMatch(g.awayTeam, player.teamName!)
        )
      : undefined;

  const game = byId ?? byName;

  if (!game) {
    // NO ID AND NO NAME IS NOT THE SAME AS "NOT PLAYING". If the index gave us
    // neither, we cannot place him, and saying his team is off would be exactly the
    // confident falsehood this whole release exists to remove.
    if (player.teamId === null && !player.teamName) {
      return { kind: "team_unresolved" };
    }
    return { kind: "team_not_scheduled", teamName: player.teamName ?? `team ${player.teamId}` };
  }

  const isHome =
    player.teamId !== null ? game.homeTeamId === player.teamId : teamNamesMatch(game.homeTeam, player.teamName!);
  const teamName = isHome ? game.homeTeam : game.awayTeam;
  const opponent = isHome ? game.awayTeam : game.homeTeam;
  const lineup = isHome ? game.homeLineup : game.awayLineup;

  // 3. IS THE LINEUP OUT YET? Only now is "not posted" the honest answer.
  if (lineup.length === 0) return { kind: "lineup_pending", teamName, opponent };

  // 4. POSTED. Absence here is real information.
  const want = normaliseName(playerName);
  const slot = lineup.find(
    (s) => normaliseName(s.fullName) === want || normaliseName(s.fullName) === normaliseName(player.fullName)
  );
  if (slot) return { kind: "in_lineup", slot, teamName, opponent };
  return { kind: "not_in_posted_lineup", teamName };
}
