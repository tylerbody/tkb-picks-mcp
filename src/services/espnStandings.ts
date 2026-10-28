import type { SportKey } from "../constants.js";
import type { NormalizedStanding } from "../types.js";
import { ESPN_LEAGUE_PATHS, type EspnClient } from "./espnClient.js";

/**
 * ESPN STANDINGS. ADDED v2.20.0, replacing BALLDONTLIE (cancelled) for tkb_get_standings
 * and the standings half of tkb_get_team_split.
 *
 * MEASURED 2026-10-28 from Render: https://site.api.espn.com/apis/v2/sports/.../standings
 * answers 200 for NBA, NFL and NHL. Shape, read verbatim from the live payload:
 *
 *   root.children[]                    conferences (NBA East/West, NFL AFC/NFC, NHL East/West)
 *     .standings.entries[]             one per team
 *       .team                          {id, location, name, abbreviation, displayName, ...}
 *       .stats[]                       numbers AND record objects in ONE array
 *
 * NUMBERS are keyed by `name`: wins, losses, ties, otLosses, winPercent, gamesBehind,
 * playoffSeed, pointsFor, pointsAgainst, pointDifferential, avgPointsFor,
 * avgPointsAgainst, gamesPlayed, points (NHL), streak (signed: -4 is "L4").
 *
 * RECORDS are stats with a `type` and a `summary` string, never a top-level field:
 *   total / home / road / vsdiv / vsconf / lasttengames            (NBA, NFL, NHL)
 *   total / homerecord / awayrecord / vsdivision / vsconf          (college)
 * In college payloads `name` repeats across record groups, so records are keyed by
 * TYPE, never by name.
 *
 * Divisions are NOT nested for NFL (division data is a per-team stat). This walker
 * still recurses through nested children, so a sport that does nest is read the same.
 *
 * WHY NOT COLLEGE FOOTBALL HERE. The ESPN CFB standings endpoint answered 200 on
 * 2026-10-28 with every team at 0-0 in week 9. A 200 full of zeros is the most
 * dangerous possible answer, so CFB records come from CollegeFootballData instead.
 */

export const ESPN_STANDINGS_SPORTS: SportKey[] = ["nba", "nfl", "nhl", "mlb", "wnba"];

const HOSTS = ["https://site.api.espn.com", "https://site.web.api.espn.com"] as const;

export class EspnStandingsError extends Error {}

export interface EspnStandingRow extends NormalizedStanding {
  espnTeamId: string | null;
  abbreviation: string | null;
  conference: string | null;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  overtimeLosses: number | null;
  /** NHL standings points. */
  standingsPoints: number | null;
  winPercent: number | null;
  gamesBehind: number | null;
  /** ESPN's own display form, e.g. "W2", "L4". */
  streakDisplay: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** PURE. "2-1" or "9-2-2" -> wins and losses (first two parts). */
export function splitRecord(summary: string | null): { w: number | null; l: number | null } {
  if (!summary) return { w: null, l: null };
  const [w, l] = summary.split("-").map((p) => parseInt(p.trim(), 10));
  return {
    w: Number.isFinite(w) ? (w as number) : null,
    l: Number.isFinite(l) ? (l as number) : null,
  };
}

const RECORD_TYPES = {
  overall: ["total"],
  home: ["home", "homerecord"],
  road: ["road", "awayrecord", "away"],
  division: ["vsdiv", "vsdivision"],
  conference: ["vsconf"],
  lastTen: ["lasttengames"],
};

/** PURE. One ESPN standings entry -> a normalized row. */
export function parseEspnStandingEntry(
  entry: unknown,
  conference: string | null,
  season: number | null,
  sport?: SportKey
): EspnStandingRow | null {
  const e = obj(entry);
  const team = obj(e?.team);
  if (!e || !team) return null;
  const stats = Array.isArray(e.stats) ? (e.stats as unknown[]).map(obj).filter(Boolean) as Obj[] : [];

  const byName = new Map<string, Obj>();
  const byType = new Map<string, Obj>();
  for (const s of stats) {
    const name = str(s.name);
    const type = str(s.type)?.toLowerCase();
    // First occurrence wins for names: college payloads repeat names across record
    // groups, and the league-level one comes first.
    if (name && !byName.has(name)) byName.set(name, s);
    if (type && !byType.has(type)) byType.set(type, s);
  }
  const n = (name: string) => num(byName.get(name)?.value);
  const rec = (types: string[]) => {
    for (const t of types) {
      const s = byType.get(t);
      const summary = str(s?.summary) ?? str(s?.displayValue);
      if (summary) return summary;
    }
    return null;
  };

  const overall = rec(RECORD_TYPES.overall);
  const home = rec(RECORD_TYPES.home);
  const road = rec(RECORD_TYPES.road);
  const homeWL = splitRecord(home);
  const roadWL = splitRecord(road);
  const overallWL = splitRecord(overall);

  const wins = n("wins") ?? overallWL.w;
  const losses = n("losses") ?? overallWL.l;
  const ties = n("ties");
  const pointsFor = n("pointsFor");
  const pointsAgainst = n("pointsAgainst");
  const pointDifferential =
    n("pointDifferential") ?? (pointsFor !== null && pointsAgainst !== null ? pointsFor - pointsAgainst : null);

  return {
    teamName: str(team.displayName) ?? [str(team.location), str(team.name)].filter(Boolean).join(" "),
    espnTeamId: str(team.id),
    abbreviation: str(team.abbreviation),
    conference,
    overallRecord: overall ?? (wins !== null && losses !== null ? `${wins}-${losses}` : null),
    homeRecord: home,
    roadRecord: road,
    homeWins: homeWL.w,
    homeLosses: homeWL.l,
    roadWins: roadWL.w,
    roadLosses: roadWL.l,
    divisionRecord: rec(RECORD_TYPES.division),
    conferenceRecord: rec(RECORD_TYPES.conference),
    lastTen: rec(RECORD_TYPES.lastTen),
    streak: n("streak"),
    streakDisplay: str(byName.get("streak")?.displayValue),
    pointsFor,
    pointsAgainst,
    pointDifferential,
    avgPointsFor: n("avgPointsFor"),
    avgPointsAgainst: n("avgPointsAgainst"),
    playoffSeed: n("playoffSeed"),
    gamesPlayed: n("gamesPlayed") ?? (wins !== null && losses !== null ? wins + losses + (ties ?? 0) + (n("otLosses") ?? 0) : null),
    season,
    wins,
    losses,
    ties,
    overtimeLosses: n("otLosses") ?? n("overtimeLosses"),
    // "points" means standings points ONLY in hockey. In the NBA payload it is an
    // unrelated -2.0, so it is never read for any other sport.
    standingsPoints: sport === "nhl" ? n("points") : null,
    winPercent: n("winPercent"),
    gamesBehind: n("gamesBehind"),
  };
}

/**
 * PURE. Walk every `standings.entries` array under root.children (recursively), tagging
 * each row with the nearest named group (conference or division).
 */
export function parseEspnStandings(payload: unknown, sport?: SportKey): { rows: EspnStandingRow[]; season: number | null; seasonLabel: string | null } {
  const root = obj(payload);
  if (!root || !Array.isArray(root.children)) {
    throw new EspnStandingsError(
      `ESPN standings payload has no children[] array. Top-level keys: ${root ? Object.keys(root).join(", ") : "(not an object)"}.`
    );
  }
  const rows: EspnStandingRow[] = [];
  let season: number | null = null;
  let seasonLabel: string | null = null;
  const walk = (node: Obj, group: string | null, depth: number) => {
    if (depth > 4) return;
    const name = str(node.name) ?? group;
    const standings = obj(node.standings);
    if (standings && Array.isArray(standings.entries)) {
      season = season ?? num(standings.season);
      seasonLabel = seasonLabel ?? str(standings.seasonDisplayName);
      for (const entry of standings.entries) {
        const row = parseEspnStandingEntry(entry, name, num(standings.season), sport);
        if (row) rows.push(row);
      }
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) {
        const child = obj(c);
        if (child) walk(child, str(child.name) ?? name, depth + 1);
      }
    }
  };
  for (const c of root.children) {
    const child = obj(c);
    if (child) walk(child, str(child.name), 0);
  }
  if (!rows.length) {
    throw new EspnStandingsError("ESPN standings payload parsed to zero team rows.");
  }
  return { rows, season, seasonLabel };
}

export function espnStandingsUrl(host: string, sport: SportKey): string {
  const p = ESPN_LEAGUE_PATHS[sport]!;
  return `${host}/apis/v2/sports/${p.sport}/${p.league}/standings`;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<SportKey, { at: number; promise: Promise<ReturnType<typeof parseEspnStandings> & { host: string }> }>();
export function clearEspnStandingsCache(): void {
  cache.clear();
}

/** Ten-minute cache; failures are not cached. Tries site.api then site.web.api. */
export function getEspnStandings(
  espn: Pick<EspnClient, "fetchRawEspn">,
  sport: SportKey
): Promise<ReturnType<typeof parseEspnStandings> & { host: string }> {
  if (!ESPN_STANDINGS_SPORTS.includes(sport) || !ESPN_LEAGUE_PATHS[sport]) {
    return Promise.reject(
      new EspnStandingsError(`No ESPN standings are wired for ${sport.toUpperCase()}. Wired: ${ESPN_STANDINGS_SPORTS.join(", ")}.`)
    );
  }
  const hit = cache.get(sport);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const promise = (async () => {
    const reasons: string[] = [];
    for (const host of HOSTS) {
      const res = await espn.fetchRawEspn(espnStandingsUrl(host, sport));
      if (!res.ok) {
        reasons.push(`${host}: ${res.reason}`);
        continue;
      }
      try {
        return { ...parseEspnStandings(res.data, sport), host };
      } catch (err) {
        reasons.push(`${host}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new EspnStandingsError(`No ESPN host returned usable ${sport.toUpperCase()} standings. ${reasons.join("; ")}`);
  })();
  cache.set(sport, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(sport)?.promise === promise) cache.delete(sport);
  });
  return promise;
}

/**
 * PURE. One team's row by name. Exact normalized match on displayName, abbreviation or
 * the nickname first; then containment, longest name first, so "Chicago White Sox"
 * never resolves to "Chicago Cubs". Two containment hits is AMBIGUOUS and returns
 * undefined rather than guessing.
 */
export function findEspnStandingRow(rows: EspnStandingRow[], teamName: string): EspnStandingRow | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const needle = norm(teamName);
  if (!needle) return undefined;
  const names = (r: EspnStandingRow) =>
    [r.teamName, r.abbreviation ?? "", r.teamName.split(" ").slice(-1)[0] ?? ""].map(norm).filter(Boolean);
  const exact = rows.filter((r) => names(r).includes(needle));
  if (exact.length === 1) return exact[0];
  const contained = rows.filter((r) => norm(r.teamName).includes(needle) || needle.includes(norm(r.teamName)));
  return contained.length === 1 ? contained[0] : undefined;
}
