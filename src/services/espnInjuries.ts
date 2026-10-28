import type { SportKey } from "../constants.js";
import { ESPN_LEAGUE_PATHS, type EspnClient, type EspnFetchResult } from "./espnClient.js";
import { normaliseEspnName, normaliseEspnTeamName, extractTeams } from "./espnPlayerResolution.js";

/**
 * ESPN INJURY FEED. ADDED v2.19.0.
 *
 * WHY. BALLDONTLIE was cancelled in v2.16.0, and its injury feed was the only one this
 * connector had. NBA never had one at all (BDL had no nba injuries path wired), so every
 * NBA thread checked injuries by live web search. ESPN publishes a keyless league-wide
 * injury feed for the sports below, in one request per sport.
 *
 * MEASURED 2026-10-19, from Render via tkb_probe_espn_gamelog rawUrl:
 *   site.web.api.espn.com/.../basketball/nba/injuries  200, 31ms
 *   site.web.api.espn.com/.../football/nfl/injuries    200, 224ms
 *   site.web.api.espn.com/.../hockey/nhl/injuries      200, 14ms
 *   site.api.espn.com/.../basketball/nba/injuries      200, 68ms  (this host 403'd
 *     for teams and rosters in v2.12.2, but answers 200 for injuries today)
 * Top-level keys on all of them: injuries, season, status, timestamp.
 *
 * ---- THE TWO HOSTS SERVE DIFFERENT SNAPSHOTS, AND THAT DECIDES THE DESIGN ----
 *
 * Read on the same day (2026-10-19), the same NBA path returned:
 *   site.api.espn.com      timestamp 2026-10-15T08:07:12Z
 *   site.web.api.espn.com  timestamp 2026-08-11T14:58:58Z   <- two months old
 * Both return HTTP 200 with a valid body, so neither looks broken. Trusting either
 * host blindly would sooner or later hand a thread an August injury list as current.
 *
 * So this fetches BOTH, keeps the one whose own `timestamp` is newest, and always
 * reports that timestamp and its age. Freshness is read off the payload, never assumed
 * from which host answered.
 *
 * ---- WHAT THE FEED DOES NOT TELL YOU ----
 *
 * ESPN's `status` string is loose. Measured verbatim: an NBA player with a surgically
 * repaired fractured foot and a 3-to-4-month timeline carried status "Day-To-Day"; an
 * NFL player whose own shortComment says "placed on injured reserve" carried
 * "Questionable". So the comment and return date are returned alongside the status,
 * and a return date already in the past is flagged rather than trusted.
 */

/** Sports with a measured ESPN league-wide injury feed. */
/* MLB ADDED v2.20.0: site.api.espn.com/.../baseball/mlb/injuries answered 200 from Render
 * on 2026-10-19 with the same top-level keys, and BALLDONTLIE (MLB's old source) is
 * cancelled. */
export const ESPN_INJURY_SPORTS: SportKey[] = ["nba", "nfl", "nhl", "wnba", "mlb"];

/** Hosts tried, in order. Both are fetched; the freshest payload wins. */
export const ESPN_INJURY_HOSTS = [
  "https://site.api.espn.com",
  "https://site.web.api.espn.com",
] as const;

/**
 * FRESHNESS IS MEASURED FROM THE NEWEST ENTRY, NOT THE TOP-LEVEL TIMESTAMP (v2.20.0).
 * Measured 2026-10-19 and 2026-10-28: the payload's `timestamp` equalled the moment of the
 * request on both hosts, so it is when ESPN BUILT the response, not when the report last
 * changed. A feed ESPN stopped updating would still read "0h old". The newest entry's
 * `date` is the real signal. In season a league posts several updates a day, so 36 hours
 * without one is flagged STALE.
 */
export const INJURY_FEED_STALE_HOURS = 36;

export interface EspnInjuryEntry {
  playerName: string;
  /** Parsed from the athlete's profile link or headshot URL. Null if neither carried one. */
  espnAthleteId: string | null;
  team: string;
  teamAbbreviation: string | null;
  espnTeamId: string | null;
  /** ESPN's own status string, verbatim, e.g. "Out", "Day-To-Day", "Questionable". */
  status: string;
  /** type.abbreviation, e.g. "O", "DD", "Q". */
  statusCode: string | null;
  /** details.fantasyStatus.abbreviation, e.g. "GTD", "OUT", "QUESTIONABLE". */
  fantasyStatus: string | null;
  injuryType: string | null;
  detail: string | null;
  side: string | null;
  returnDate: string | null;
  /** True when returnDate is earlier than the as-of date. The status is then suspect. */
  returnDatePassed: boolean;
  /** When ESPN logged THIS entry. */
  updatedAt: string | null;
  shortComment: string | null;
  longComment: string | null;
}

export interface EspnInjuryFeed {
  sport: SportKey;
  /** The feed's own top-level timestamp. */
  feedTimestamp: string | null;
  /** Hours between feedTimestamp and asOf. Null when the timestamp is missing. */
  /** Hours since the NEWEST entry was posted. This is what `stale` is judged on. */
  feedAgeHours: number | null;
  /** When the most recent entry in the feed was posted. */
  newestEntryAt: string | null;
  stale: boolean;
  /**
   * TEAM COVERAGE (v2.20.0). ESPN's league feed OMITS teams with nothing listed, so a
   * missing team used to read as full coverage. Measured 2026-10-28: 27 teams present,
   * Milwaukee absent. Every team not in the feed is listed here and, when possible,
   * confirmed against ESPN's per-team injury endpoint.
   */
  coverage: InjuryCoverage | null;
  seasonLabel: string | null;
  host: string;
  /** Every host tried and what it said, so a stale pick is explainable. */
  hostsTried: Array<{ host: string; ok: boolean; status?: number; feedTimestamp?: string | null; reason?: string }>;
  teamCount: number;
  entries: EspnInjuryEntry[];
}

export class EspnInjuryShapeError extends Error {}

export interface NotListedTeam {
  team: string;
  espnTeamId: string;
  /** ESPN_LISTS_ZERO: the per-team endpoint confirms no entries.
   *  MISSING_FROM_FEED: the per-team endpoint HAS entries the league feed left out.
   *  UNCONFIRMED: the per-team check could not run. */
  status: "ESPN_LISTS_ZERO" | "MISSING_FROM_FEED" | "UNCONFIRMED";
  perTeamCount: number | null;
}

export interface InjuryCoverage {
  leagueTeams: number;
  teamsInFeed: string[];
  notListed: NotListedTeam[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * PURE. The athlete id is NOT on the athlete object (measured: no `id` key there). It
 * only appears inside URLs. The injury record's own `id` is a different number and can
 * be negative for manual entries, so it is never used as an athlete id.
 */
export function parseAthleteId(athlete: Record<string, unknown>): string | null {
  const links = Array.isArray(athlete.links) ? athlete.links : [];
  for (const l of links) {
    const href = str(obj(l)?.href);
    const m = href?.match(/\/id\/(\d+)(?:\/|$)/);
    if (m) return m[1];
  }
  const headshot = obj(athlete.headshot);
  const hs = str(headshot?.href)?.match(/\/full\/(\d+)\.png/);
  if (hs) return hs[1];
  return null;
}

/**
 * PURE. Parse one ESPN injuries payload. REFUSES on a shape it does not recognise,
 * rather than returning an empty list: an empty list reads as "nobody is hurt".
 */
export function parseEspnInjuryFeed(
  payload: unknown,
  asOf: Date = new Date()
): { feedTimestamp: string | null; seasonLabel: string | null; teamCount: number; entries: EspnInjuryEntry[] } {
  const root = obj(payload);
  if (!root) throw new EspnInjuryShapeError("ESPN injury payload is not an object.");
  if (!Array.isArray(root.injuries)) {
    throw new EspnInjuryShapeError(
      `ESPN injury payload has no injuries[] array. Top-level keys: ${Object.keys(root).join(", ") || "(none)"}.`
    );
  }
  const season = obj(root.season);
  const seasonLabel = season
    ? [str(season.displayName), str(season.name)].filter(Boolean).join(" ") || null
    : null;

  const asOfDay = asOf.toISOString().slice(0, 10);
  const entries: EspnInjuryEntry[] = [];
  let teamCount = 0;

  for (const groupRaw of root.injuries) {
    const group = obj(groupRaw);
    if (!group) continue;
    teamCount++;
    const groupTeam = str(group.displayName);
    const groupId = str(group.id);
    const list = Array.isArray(group.injuries) ? group.injuries : [];
    for (const raw of list) {
      const e = obj(raw);
      if (!e) continue;
      const athlete = obj(e.athlete) ?? {};
      const team = obj(athlete.team);
      const type = obj(e.type);
      const details = obj(e.details);
      const fantasy = obj(details?.fantasyStatus);
      const name =
        str(athlete.displayName) ??
        ([str(athlete.firstName), str(athlete.lastName)].filter(Boolean).join(" ") || null);
      if (!name) continue;
      const returnDate = str(details?.returnDate);
      entries.push({
        playerName: name,
        espnAthleteId: parseAthleteId(athlete),
        team: str(team?.displayName) ?? groupTeam ?? "unknown",
        teamAbbreviation: str(team?.abbreviation),
        espnTeamId: str(team?.id) ?? groupId,
        status: str(e.status) ?? str(type?.description) ?? "unknown",
        statusCode: str(type?.abbreviation),
        fantasyStatus: str(fantasy?.abbreviation),
        injuryType: str(details?.type),
        detail: str(details?.detail),
        side: str(details?.side),
        returnDate,
        returnDatePassed: returnDate ? returnDate.slice(0, 10) < asOfDay : false,
        updatedAt: str(e.date),
        shortComment: str(e.shortComment),
        longComment: str(e.longComment),
      });
    }
  }

  return { feedTimestamp: str(root.timestamp), seasonLabel, teamCount, entries };
}

/** PURE. Hours between an ISO timestamp and asOf, or null if unparseable. */
export function feedAgeHours(timestamp: string | null, asOf: Date = new Date()): number | null {
  if (!timestamp) return null;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (asOf.getTime() - t) / 3_600_000);
}

/**
 * PURE. Of several parsed host payloads, the one with the newest feed timestamp. A
 * payload with no timestamp loses to any payload that has one, because its freshness
 * cannot be known.
 */
export function pickFreshest<T extends { feedTimestamp: string | null }>(candidates: T[]): T | null {
  let best: T | null = null;
  let bestT = -Infinity;
  for (const c of candidates) {
    const t = c.feedTimestamp ? Date.parse(c.feedTimestamp) : NaN;
    const score = Number.isNaN(t) ? -Infinity : t;
    if (best === null || score > bestT) {
      best = c;
      bestT = score;
    }
  }
  return best;
}

export function espnInjuriesUrl(host: string, sport: SportKey): string {
  const path = ESPN_LEAGUE_PATHS[sport];
  return `${host}/apis/site/v2/sports/${path.sport}/${path.league}/injuries`;
}

/* ---- 10-MINUTE CACHE, promise-keyed like the rest of this repo ----
 * A screen calls this once per game; a slate of eight games should be one fetch per
 * host, not sixteen. Short enough that a late scratch posted to ESPN shows up on the
 * next run. */
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; promise: Promise<EspnInjuryFeed> }>();

/** Test hook. */
export function clearEspnInjuryCache(): void {
  cache.clear();
}

/** PURE. The latest `updatedAt` among entries, or null. */
export function newestEntryDate(entries: EspnInjuryEntry[]): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const e of entries) {
    const t = e.updatedAt ? Date.parse(e.updatedAt) : NaN;
    if (Number.isFinite(t) && t > bestT) {
      bestT = t;
      best = e.updatedAt;
    }
  }
  return best;
}

export function espnCoreTeamInjuriesUrl(sport: SportKey, espnTeamId: string): string {
  const p = ESPN_LEAGUE_PATHS[sport]!;
  return `https://sports.core.api.espn.com/v2/sports/${p.sport}/leagues/${p.league}/teams/${encodeURIComponent(espnTeamId)}/injuries?limit=100`;
}

/** Which league teams the feed covered, with a per-team check on every absent one. */
async function buildCoverage(
  espn: Pick<EspnClient, "fetchRawEspn"> & Partial<Pick<EspnClient, "fetchTeams">>,
  sport: SportKey,
  entries: EspnInjuryEntry[]
): Promise<InjuryCoverage | null> {
  if (!espn.fetchTeams) return null;
  const teamsRes = await espn.fetchTeams(ESPN_LEAGUE_PATHS[sport]!);
  const teams = teamsRes.ok && teamsRes.data ? extractTeams(teamsRes.data) : [];
  if (!teams.length) return null;
  const inFeedIds = new Set(entries.map((e) => e.espnTeamId).filter(Boolean));
  const inFeedNames = new Set(entries.map((e) => normaliseEspnTeamName(e.team)));
  const listed = teams.filter((t) => inFeedIds.has(t.id) || inFeedNames.has(normaliseEspnTeamName(t.displayName)));
  const absent = teams.filter((t) => !listed.includes(t));
  const notListed = await Promise.all(
    absent.map(async (t): Promise<NotListedTeam> => {
      const res = await espn.fetchRawEspn(espnCoreTeamInjuriesUrl(sport, t.id));
      const count = res.ok ? (res.data as { count?: unknown })?.count : undefined;
      if (typeof count !== "number") {
        return { team: t.displayName, espnTeamId: t.id, status: "UNCONFIRMED", perTeamCount: null };
      }
      return {
        team: t.displayName,
        espnTeamId: t.id,
        status: count === 0 ? "ESPN_LISTS_ZERO" : "MISSING_FROM_FEED",
        perTeamCount: count,
      };
    })
  );
  return { leagueTeams: teams.length, teamsInFeed: listed.map((t) => t.displayName).sort(), notListed };
}

export function getEspnInjuries(
  espn: Pick<EspnClient, "fetchRawEspn"> & Partial<Pick<EspnClient, "fetchTeams">>,
  sport: SportKey,
  asOf: Date = new Date()
): Promise<EspnInjuryFeed> {
  if (!ESPN_INJURY_SPORTS.includes(sport) || !ESPN_LEAGUE_PATHS[sport]) {
    return Promise.reject(
      new EspnInjuryShapeError(
        `No ESPN injury feed is wired for ${sport.toUpperCase()}. Wired: ${ESPN_INJURY_SPORTS.join(", ")}.`
      )
    );
  }
  const hit = cache.get(sport);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;

  const promise = (async (): Promise<EspnInjuryFeed> => {
    const results = await Promise.all(
      ESPN_INJURY_HOSTS.map(async (host) => {
        const res: EspnFetchResult<unknown> = await espn.fetchRawEspn(espnInjuriesUrl(host, sport));
        if (!res.ok) {
          return { host, ok: false as const, status: res.status, reason: res.reason ?? "request failed" };
        }
        try {
          const parsed = parseEspnInjuryFeed(res.data, asOf);
          return { host, ok: true as const, status: res.status, ...parsed };
        } catch (err) {
          return {
            host,
            ok: false as const,
            status: res.status,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );

    const good = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    const hostsTried = results.map((r) =>
      r.ok
        ? { host: r.host, ok: true, status: r.status, feedTimestamp: r.feedTimestamp }
        : { host: r.host, ok: false, status: r.status, reason: r.reason }
    );
    // Judge hosts by their newest ENTRY, falling back to the build timestamp only when a
    // payload has no dated entries at all.
    const best = pickFreshest(
      good.map((g) => ({ ...g, feedTimestamp: newestEntryDate(g.entries) ?? g.feedTimestamp }))
    );
    if (!best) {
      throw new EspnInjuryShapeError(
        `No ESPN host returned a usable ${sport.toUpperCase()} injury feed. ` +
          hostsTried.map((h) => `${h.host}: ${h.ok ? "ok" : h.reason}`).join("; ")
      );
    }
    const newest = newestEntryDate(best.entries);
    const age = feedAgeHours(newest, asOf);
    let coverage: InjuryCoverage | null = null;
    try {
      coverage = await buildCoverage(espn, sport, best.entries);
    } catch {
      coverage = null;
    }
    return {
      sport,
      feedTimestamp: good.find((g) => g.host === best.host)?.feedTimestamp ?? null,
      feedAgeHours: age === null ? null : Number(age.toFixed(1)),
      newestEntryAt: newest,
      coverage,
      stale: age === null || age > INJURY_FEED_STALE_HOURS,
      seasonLabel: best.seasonLabel,
      host: best.host,
      hostsTried,
      teamCount: best.teamCount,
      entries: best.entries,
    };
  })();

  cache.set(sport, { at: Date.now(), promise });
  // A failed fetch must not be cached for ten minutes.
  promise.catch(() => {
    if (cache.get(sport)?.promise === promise) cache.delete(sport);
  });
  return promise;
}

/**
 * PURE. Find one player's entry. Team first (normalised display names), then name. A
 * name that matches two entries league-wide with no team to split them returns
 * "ambiguous" rather than guessing.
 */
export function findInjuryEntry(
  entries: EspnInjuryEntry[],
  playerName: string,
  teamName?: string
): { match: EspnInjuryEntry | null; ambiguous: boolean } {
  const wanted = normaliseEspnName(playerName);
  let pool = entries.filter((e) => normaliseEspnName(e.playerName) === wanted);
  if (teamName && pool.length > 1) {
    const t = normaliseEspnTeamName(teamName);
    const byTeam = pool.filter((e) => normaliseEspnTeamName(e.team) === t);
    if (byTeam.length) pool = byTeam;
  }
  if (pool.length === 1) return { match: pool[0], ambiguous: false };
  return { match: null, ambiguous: pool.length > 1 };
}

/** PURE. Every string a team filter should match against, lowercased. */
export function injuryTeamHaystack(e: EspnInjuryEntry): string {
  return [e.team, e.teamAbbreviation].filter(Boolean).join(" ").toLowerCase();
}

/** PURE. One-line staleness statement used by both the tool and the screener. */
export function describeFeedFreshness(feed: EspnInjuryFeed): string {
  const when = feed.newestEntryAt ?? "an unknown time";
  const age = feed.feedAgeHours === null ? "unknown age" : `${feed.feedAgeHours}h ago`;
  const head = feed.stale
    ? `STALE ESPN INJURY FEED: the newest entry was posted ${when} (${age}). Do NOT treat an absent ` +
      `player as healthy; confirm availability by live search before posting.`
    : `ESPN injury feed: newest entry posted ${when} (${age}).`;
  return head + describeCoverage(feed);
}

/** PURE. One-line coverage statement: which teams the feed actually covered. */
export function describeCoverage(feed: EspnInjuryFeed): string {
  const c = feed.coverage;
  if (!c) return ` Team coverage could not be checked, so a team with no entries is UNVERIFIED, not healthy.`;
  const missing = c.notListed.filter((n) => n.status === "MISSING_FROM_FEED");
  const unconfirmed = c.notListed.filter((n) => n.status === "UNCONFIRMED");
  const zero = c.notListed.filter((n) => n.status === "ESPN_LISTS_ZERO");
  return (
    ` Coverage: ${c.teamsInFeed.length} of ${c.leagueTeams} teams have entries.` +
    (zero.length ? ` ESPN's per-team check confirms ZERO listed injuries for: ${zero.map((z) => z.team).join(", ")}.` : "") +
    (missing.length
      ? ` WARNING: the league feed LEFT OUT entries that ESPN's per-team endpoint has for: ` +
        missing.map((m) => `${m.team} (${m.perTeamCount})`).join(", ") +
        `. Treat those teams as UNVERIFIED and search them.`
      : "") +
    (unconfirmed.length
      ? ` Could not confirm (treat as UNVERIFIED): ${unconfirmed.map((u) => u.team).join(", ")}.`
      : "")
  );
}
