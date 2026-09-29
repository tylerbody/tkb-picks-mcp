import axios, { type AxiosInstance } from "axios";

/**
 * ESPN public game-log client.
 *
 * NO API KEY. These are the same keyless endpoints espn.com's own pages call. Verified
 * reachable and parsed by hand on 2026-09-29; see claude/espn-gamelog-free-research-source.md
 * in the project for the measurement that produced the shapes below.
 *
 * WHY THIS EXISTS. BDL's GOAT tier was ruled out 2026-09-29. This is the free
 * alternative, and it is worth more than the minutes column that started the idea: the
 * same response carries points, rebounds, assists, steals, blocks, turnovers and threes
 * per game, which is a WNBA hit-rate source where the connector currently has none.
 *
 * ---- UNDOCUMENTED, AND TREATED AS SUCH ----
 *
 * There is no contract, no versioning and no deprecation notice on these paths. So every
 * parse in here REFUSES rather than coerces: a shape that does not match what was
 * measured returns a named failure, never a plausible number. A wrong hit rate is worse
 * than no hit rate, because it gets published.
 */

/** ESPN's URL takes a sport AND a league segment. Both are required and they differ. */
export interface EspnLeaguePath {
  sport: string;
  league: string;
}

/**
 * MEASURED, not guessed. wnba and nhl were both fetched live on 2026-09-29 and returned
 * valid gamelogs. The other three follow ESPN's documented-by-convention path shape and
 * are UNVERIFIED until the probe says otherwise, which is why the probe reports which
 * league it actually reached rather than assuming.
 */
export const ESPN_LEAGUE_PATHS: Record<string, EspnLeaguePath> = {
  wnba: { sport: "basketball", league: "wnba" },
  nba: { sport: "basketball", league: "nba" },
  nhl: { sport: "hockey", league: "nhl" },
  nfl: { sport: "football", league: "nfl" },
  mlb: { sport: "baseball", league: "mlb" },
};

export interface EspnGameRow {
  eventId: string;
  stats: string[];
}

export interface EspnCategory {
  displayName?: string;
  type?: string;
  events?: EspnGameRow[];
}

export interface EspnSeasonType {
  displayName?: string;
  categories?: EspnCategory[];
}

export interface EspnGamelog {
  labels?: string[];
  names?: string[];
  displayNames?: string[];
  seasonTypes?: EspnSeasonType[];
  events?: Record<string, unknown>;
}

export interface EspnRosterEntry {
  id: string;
  displayName: string;
}

export interface EspnFetchResult<T> {
  ok: boolean;
  status?: number;
  elapsedMs: number;
  url: string;
  data?: T;
  /** Named reason on failure. Never empty when ok is false. */
  reason?: string;
}

export class EspnClient {
  private http: AxiosInstance;

  constructor(timeoutMs = 12000) {
    this.http = axios.create({
      timeout: timeoutMs,
      // ESPN serves these to browsers. A plain identifying UA, not a secret.
      headers: { "User-Agent": "TKBPicksConnector (contact: tkb-picks-mcp-server)" },
      // Do not throw on 4xx/5xx: the probe's job is to REPORT the status, and an
      // exception loses it.
      validateStatus: () => true,
    });
  }

  private async get<T>(url: string): Promise<EspnFetchResult<T>> {
    const started = Date.now();
    try {
      const res = await this.http.get<T>(url);
      const elapsedMs = Date.now() - started;
      if (res.status < 200 || res.status >= 300) {
        return {
          ok: false,
          status: res.status,
          elapsedMs,
          url,
          reason: `ESPN returned HTTP ${res.status}.`,
        };
      }
      if (res.data === undefined || res.data === null || typeof res.data !== "object") {
        return {
          ok: false,
          status: res.status,
          elapsedMs,
          url,
          reason: `ESPN returned HTTP ${res.status} with a non-object body (${typeof res.data}).`,
        };
      }
      return { ok: true, status: res.status, elapsedMs, url, data: res.data };
    } catch (err) {
      const elapsedMs = Date.now() - started;
      const msg = err instanceof Error ? err.message : String(err);
      /* EGRESS IS THE THING THIS PROBE EXISTS TO TEST. Nothing has ever confirmed that
       * Render can reach ESPN, so a DNS or connection failure is the single most likely
       * outcome and it must be named as such rather than reported as "no data". */
      const looksLikeEgress =
        /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(msg);
      return {
        ok: false,
        elapsedMs,
        url,
        reason: looksLikeEgress
          ? `Could not reach ESPN from this server: ${msg}. This is a NETWORK/EGRESS failure, ` +
            `not a data problem. The host may be blocked outbound from Render.`
          : `Request failed: ${msg}`,
      };
    }
  }

  gamelogUrl(path: EspnLeaguePath, espnId: string, season?: number): string {
    const base =
      `https://site.web.api.espn.com/apis/common/v3/sports/` +
      `${path.sport}/${path.league}/athletes/${encodeURIComponent(espnId)}/gamelog`;
    return season ? `${base}?season=${season}` : base;
  }

  teamsUrl(path: EspnLeaguePath): string {
    return (
      `https://site.api.espn.com/apis/site/v2/sports/` +
      `${path.sport}/${path.league}/teams`
    );
  }

  rosterUrl(path: EspnLeaguePath, teamEspnId: string): string {
    return (
      `https://site.api.espn.com/apis/site/v2/sports/` +
      `${path.sport}/${path.league}/teams/${encodeURIComponent(teamEspnId)}/roster`
    );
  }

  fetchGamelog(path: EspnLeaguePath, espnId: string, season?: number) {
    return this.get<EspnGamelog>(this.gamelogUrl(path, espnId, season));
  }

  fetchTeams(path: EspnLeaguePath) {
    return this.get<unknown>(this.teamsUrl(path));
  }

  fetchRoster(path: EspnLeaguePath, teamEspnId: string) {
    return this.get<unknown>(this.rosterUrl(path, teamEspnId));
  }
}

/* ===========================================================================
 * PURE PARSERS. Exported and separately tested, per this repo's rule that pure logic
 * and the wiring that calls it are two different things and both get tested.
 */

/**
 * THE PATH THAT ACTUALLY HOLDS THE NUMBERS.
 *
 * `seasonTypes[].categories[].events[].stats`, aligned BY INDEX to the root `labels`.
 *
 * The numbers are NOT in the root `events` map. That map is game metadata keyed by ESPN
 * game id and each entry carries fifteen `links` objects, which makes the payload large
 * enough that a summarising fetch truncates before reaching seasonTypes and then reports
 * that seasonTypes does not exist. That happened three times during verification and is
 * the reason this path is written down rather than rediscovered.
 */
export const ESPN_STATS_PATH = "seasonTypes[].categories[].events[].stats";

export interface FlattenedGame {
  eventId: string;
  seasonType: string;
  category: string;
  stats: string[];
}

export interface FlattenOutcome {
  games: FlattenedGame[];
  /** seasonType displayName -> category displayName -> game count, as found. */
  structure: Record<string, Record<string, number>>;
  /** Rows whose stats array length disagrees with labels. Never silently dropped. */
  lengthMismatches: { eventId: string; length: number; expected: number }[];
}

/**
 * Flatten the gamelog into one row per game.
 *
 * THE MONTH TRAP. A regular season is split into one category PER MONTH. A'ja Wilson's
 * 2025 came back as september 4, august 13, july 11, june 8, may 5. Anything reading
 * `categories[0].events` gets ONE MONTH and would silently compute a hit rate over four
 * games while looking like a season. Every category is walked here, and the structure is
 * reported so the split stays visible to the caller.
 *
 * PRESEASON IS IN THE SAME PAYLOAD and is excluded by default, because a preseason game
 * is not evidence for a regular-season prop.
 */
export function flattenGamelog(
  log: EspnGamelog,
  opts: { includePreseason?: boolean } = {}
): FlattenOutcome {
  const expected = log.labels?.length ?? 0;
  const games: FlattenedGame[] = [];
  const structure: Record<string, Record<string, number>> = {};
  const lengthMismatches: { eventId: string; length: number; expected: number }[] = [];

  for (const st of log.seasonTypes ?? []) {
    const stName = st.displayName ?? "unknown season type";
    const isPre = /preseason/i.test(stName);
    structure[stName] = structure[stName] ?? {};
    for (const cat of st.categories ?? []) {
      const catName = cat.displayName ?? "unknown category";
      const rows = cat.events ?? [];
      structure[stName][catName] = rows.length;
      if (isPre && !opts.includePreseason) continue;
      for (const row of rows) {
        if (!row || typeof row.eventId !== "string" || !Array.isArray(row.stats)) continue;
        if (expected > 0 && row.stats.length !== expected) {
          lengthMismatches.push({
            eventId: row.eventId,
            length: row.stats.length,
            expected,
          });
          continue;
        }
        games.push({
          eventId: row.eventId,
          seasonType: stName,
          category: catName,
          stats: row.stats,
        });
      }
    }
  }

  return { games, structure, lengthMismatches };
}

/**
 * MADE-ATTEMPTED ARRIVES AS ONE STRING, and this is the detail most likely to ship a
 * wrong number.
 *
 * Index 9 on basketball is `"0-2"`, not `0`. So Three Pointers Made needs the left side
 * of a dash split. Reading it as a number gives NaN; reading it as a made total without
 * splitting is simply wrong. The percentage columns beside it ARE bare numbers, which
 * makes them the tempting shortcut, and they are rates rather than counts.
 *
 * Every value in the feed is a string, minutes included. Nothing here trusts a type.
 */
export function parseStatValue(raw: string | undefined): {
  value: number | null;
  made?: number;
  attempted?: number;
  form: "number" | "made-attempted" | "unparsable" | "absent";
} {
  if (raw === undefined || raw === null || raw === "") return { value: null, form: "absent" };
  const s = String(raw).trim();
  if (s === "" || s === "--") return { value: null, form: "absent" };

  const pair = /^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/.exec(s);
  if (pair) {
    const made = Number(pair[1]);
    const attempted = Number(pair[2]);
    if (!Number.isFinite(made) || !Number.isFinite(attempted)) {
      return { value: null, form: "unparsable" };
    }
    // The COUNT is the made side. Attempted is returned too so a caller that wants
    // attempts does not have to re-split.
    return { value: made, made, attempted, form: "made-attempted" };
  }

  const n = Number(s);
  if (Number.isFinite(n)) return { value: n, form: "number" };
  return { value: null, form: "unparsable" };
}

/** Which label indexes carry the made-attempted form, measured from real rows. */
export function detectPairedColumns(labels: string[], rows: FlattenedGame[]): number[] {
  const paired = new Set<number>();
  for (const row of rows) {
    row.stats.forEach((raw, i) => {
      if (parseStatValue(raw).form === "made-attempted") paired.add(i);
    });
  }
  return [...paired].sort((a, b) => a - b).filter((i) => i < labels.length);
}

/** Pull id + displayName pairs out of a roster response without assuming its nesting. */
export function extractRoster(payload: unknown): EspnRosterEntry[] {
  const out: EspnRosterEntry[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const id = obj.id;
    const displayName = obj.displayName;
    // An athlete entry, not a team: teams carry an `abbreviation` and no `firstName`.
    if (
      typeof id === "string" &&
      typeof displayName === "string" &&
      (typeof obj.firstName === "string" || typeof obj.jersey === "string")
    ) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, displayName });
      }
    }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  };
  walk(payload, 0);
  return out;
}
