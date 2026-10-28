import type { NormalizedStanding } from "../types.js";

/**
 * COLLEGE FOOTBALL RECORDS FROM CollegeFootballData /records. ADDED v2.20.0.
 *
 * Replaces BALLDONTLIE (cancelled) for CFB standings. ESPN's CFB standings endpoint was
 * measured returning every team at 0-0 in week 9 (2026-10-28), so it is not used.
 *
 * ONE request returns every team for the season and is cached six hours, so a
 * conference filter is applied locally rather than spending a request per conference.
 *
 * FIELD NAMES ARE READ DEFENSIVELY: CFBD's v2 API is camelCase (total, homeGames,
 * awayGames, conferenceGames); older docs show the same keys. A row with no readable
 * total record is DROPPED and counted, never shown as 0-0.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function wl(group: unknown): { w: number | null; l: number | null; t: number | null; text: string | null } {
  const g = obj(group);
  const w = num(g?.wins);
  const l = num(g?.losses);
  const t = num(g?.ties);
  return {
    w,
    l,
    t,
    text: w !== null && l !== null ? (t ? `${w}-${l}-${t}` : `${w}-${l}`) : null,
  };
}

export interface CfbRecordRow extends NormalizedStanding {
  conference: string | null;
  division: string | null;
  classification: string | null;
  wins: number | null;
  losses: number | null;
}

/** PURE. CFBD /records rows -> normalized rows, plus a count of unreadable rows. */
export function parseCfbdRecords(rows: unknown[], season: number): { rows: CfbRecordRow[]; unreadable: number } {
  const out: CfbRecordRow[] = [];
  let unreadable = 0;
  for (const r of rows) {
    const o = obj(r);
    const team = str(o?.team);
    const total = wl(o?.total);
    if (!o || !team || total.text === null) {
      unreadable++;
      continue;
    }
    const home = wl(o.homeGames ?? o.home_games);
    const away = wl(o.awayGames ?? o.away_games);
    const conf = wl(o.conferenceGames ?? o.conference_games);
    out.push({
      teamName: team,
      conference: str(o.conference),
      division: str(o.division),
      classification: str(o.classification),
      overallRecord: total.text,
      homeRecord: home.text,
      roadRecord: away.text,
      homeWins: home.w,
      homeLosses: home.l,
      roadWins: away.w,
      roadLosses: away.l,
      divisionRecord: null,
      conferenceRecord: conf.text,
      lastTen: null,
      streak: null,
      pointsFor: null,
      pointsAgainst: null,
      pointDifferential: null,
      avgPointsFor: null,
      avgPointsAgainst: null,
      playoffSeed: null,
      gamesPlayed: num(obj(o.total)?.games),
      season: num(o.year) ?? season,
      wins: total.w,
      losses: total.l,
    });
  }
  return { rows: out, unreadable };
}

/** PURE. Case-insensitive conference match on the name CFBD returns ("SEC", "Big Ten", ...). */
export function matchesConference(rowConference: string | null, wanted: string): boolean {
  if (!rowConference) return false;
  const a = rowConference.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = wanted.toLowerCase().replace(/[^a-z0-9]/g, "");
  return a === b || a.includes(b);
}
