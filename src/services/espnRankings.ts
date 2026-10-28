import type { EspnClient } from "./espnClient.js";

/**
 * ESPN AP TOP 25 (college football). ADDED v2.20.0, replacing BALLDONTLIE (cancelled)
 * for tkb_get_rankings, whose rankedTeams string feeds tkb_get_schedule's CFB tiering.
 *
 * MEASURED 2026-10-28, verbatim from the live payload:
 *   rankings[0]  name "AP Top 25", type "ap", occurrence.value "9" (week),
 *                season.year 2026, ranks[]
 *   ranks[]      current, previous, points, firstPlaceVotes, trend ("-", "+1", "-5"),
 *                recordSummary "7-0" (on the rank, NOT on the team), team{}
 *   team         id, location "Miami", name "Hurricanes", nickname, abbreviation.
 *                There is NO displayName on a rankings team, so the school name is
 *                `location` (e.g. "Ohio State", "Miami (OH)"), which is what the CFB
 *                schedule matcher normalises against.
 * The poll is found by type "ap" or name "AP Top 25", never by array position.
 */

export const ESPN_CFB_RANKINGS_URLS = [
  "https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings",
  "https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/rankings",
];

export class EspnRankingsError extends Error {}

export interface ApPollRow {
  rank: number;
  team: string;
  nickname: string | null;
  abbreviation: string | null;
  record: string | null;
  firstPlaceVotes: number | null;
  points: number | null;
  previous: number | null;
  /** "-" unchanged, "+2", "-5", or "NR" when not ranked last week. */
  trend: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** PURE. */
export function parseEspnApPoll(payload: unknown): { season: number | null; week: number | null; rows: ApPollRow[]; lastUpdated: string | null } {
  const root = obj(payload);
  const polls = Array.isArray(root?.rankings) ? (root!.rankings as unknown[]).map(obj).filter(Boolean) as Obj[] : [];
  const ap = polls.find((p) => str(p.type)?.toLowerCase() === "ap") ?? polls.find((p) => /ap top 25/i.test(str(p.name) ?? ""));
  if (!ap || !Array.isArray(ap.ranks)) {
    throw new EspnRankingsError(
      `No AP Top 25 found in ESPN's rankings payload. Polls present: ${polls.map((p) => str(p.name)).join(", ") || "(none)"}.`
    );
  }
  const rows: ApPollRow[] = [];
  for (const r of ap.ranks as unknown[]) {
    const o = obj(r);
    const team = obj(o?.team);
    const rank = num(o?.current);
    const school = str(team?.location) ?? str(team?.nickname) ?? str(team?.name);
    if (!o || rank === null || !school) continue;
    const previous = num(o.previous);
    const trendRaw = str(o.trend);
    rows.push({
      rank,
      team: school,
      nickname: str(team?.name),
      abbreviation: str(team?.abbreviation),
      record: str(o.recordSummary),
      firstPlaceVotes: num(o.firstPlaceVotes),
      points: num(o.points),
      previous: previous && previous > 0 ? previous : null,
      trend: !previous ? "NR" : trendRaw ?? "-",
    });
  }
  if (!rows.length) throw new EspnRankingsError("ESPN's AP poll parsed to zero rows.");
  rows.sort((a, b) => a.rank - b.rank);
  return {
    season: num(obj(ap.season)?.year),
    week: num(obj(ap.occurrence)?.value),
    lastUpdated: str(ap.lastUpdated),
    rows,
  };
}

export async function getEspnApPoll(espn: Pick<EspnClient, "fetchRawEspn">) {
  const reasons: string[] = [];
  for (const url of ESPN_CFB_RANKINGS_URLS) {
    const res = await espn.fetchRawEspn(url);
    if (!res.ok) {
      reasons.push(`${url}: ${res.reason}`);
      continue;
    }
    try {
      return { ...parseEspnApPoll(res.data), url };
    } catch (err) {
      reasons.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new EspnRankingsError(`ESPN AP poll unavailable. ${reasons.join("; ")}`);
}
