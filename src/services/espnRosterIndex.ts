import type { SportKey } from "../constants.js";
import { ESPN_LEAGUE_PATHS, extractRoster, type EspnClient } from "./espnClient.js";
import {
  extractTeams,
  normaliseEspnName,
  resolveEspnTeam,
  type EspnTeamEntry,
} from "./espnPlayerResolution.js";

/**
 * LEAGUE ROSTER INDEX FROM ESPN. ADDED v2.20.0 for tkb_verify_roster.
 *
 * WHY. tkb_verify_roster was 100% BALLDONTLIE (a name search), and BDL is cancelled, so
 * every call failed. In a batch it LOOKED like rate limiting: BDL's 1.1-second throttle
 * plus a rejected key.
 *
 * HOW. ESPN serves every team's roster keylessly (the same endpoint the hit-rate layer
 * has used since v2.17.0). One team list plus one roster per team builds a full
 * name -> team index: 31 requests for the NBA, cached SIX HOURS, then every lookup in a
 * batch is free. A full index matters: "not on the expected team" only becomes MISMATCH
 * (the dangerous case) when the player is FOUND on another team. If any roster failed
 * to load, absence is reported as INCONCLUSIVE, never as a clean answer.
 */

export const ESPN_ROSTER_SPORTS: SportKey[] = ["nba", "nfl", "nhl", "mlb", "wnba", "epl", "ucl"];

export interface IndexedPlayer {
  espnAthleteId: string;
  name: string;
  team: EspnTeamEntry;
}

export interface RosterIndex {
  sport: SportKey;
  teams: EspnTeamEntry[];
  byName: Map<string, IndexedPlayer[]>;
  rostersLoaded: number;
  rostersFailed: string[];
  builtAt: string;
}

export type EspnRosterVerdict = "CONFIRMED" | "MISMATCH" | "NAME_NOT_FOUND" | "INCONCLUSIVE" | "TEAM_NOT_RESOLVED";

export interface EspnRosterCheck {
  verdict: EspnRosterVerdict;
  playerName: string;
  expectedTeam: string;
  resolvedExpectedTeam: string | null;
  foundOn: { team: string; espnAthleteId: string }[];
  note: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;
const CONCURRENCY = 6;
const cache = new Map<SportKey, { at: number; promise: Promise<RosterIndex> }>();
export function clearEspnRosterCache(): void {
  cache.clear();
}

export function buildRosterIndex(
  espn: Pick<EspnClient, "fetchTeams" | "fetchRoster">,
  sport: SportKey
): Promise<RosterIndex> {
  const path = ESPN_LEAGUE_PATHS[sport];
  if (!path || !ESPN_ROSTER_SPORTS.includes(sport)) {
    return Promise.reject(new Error(`No ESPN roster source is wired for ${sport.toUpperCase()}.`));
  }
  const hit = cache.get(sport);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;

  const promise = (async (): Promise<RosterIndex> => {
    const teamsRes = await espn.fetchTeams(path);
    if (!teamsRes.ok || !teamsRes.data) {
      throw new Error(`ESPN team list unavailable for ${sport.toUpperCase()}: ${teamsRes.reason}`);
    }
    const teams = extractTeams(teamsRes.data);
    if (!teams.length) throw new Error(`ESPN team list for ${sport.toUpperCase()} parsed to zero teams.`);

    const byName = new Map<string, IndexedPlayer[]>();
    const failed: string[] = [];
    let loaded = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < teams.length) {
        const team = teams[cursor++]!;
        const res = await espn.fetchRoster(path, team.id);
        const roster = res.ok && res.data ? extractRoster(res.data) : [];
        if (!roster.length) {
          failed.push(team.displayName);
          continue;
        }
        loaded++;
        for (const a of roster) {
          const key = normaliseEspnName(a.displayName);
          const list = byName.get(key) ?? [];
          list.push({ espnAthleteId: a.id, name: a.displayName, team });
          byName.set(key, list);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, teams.length) }, worker));
    return { sport, teams, byName, rostersLoaded: loaded, rostersFailed: failed, builtAt: new Date().toISOString() };
  })();

  cache.set(sport, { at: Date.now(), promise });
  promise.catch(() => {
    if (cache.get(sport)?.promise === promise) cache.delete(sport);
  });
  return promise;
}

/** PURE. One player against one claimed team, using a built index. */
export function checkAgainstIndex(index: RosterIndex, playerName: string, expectedTeam: string): EspnRosterCheck {
  const resolved = resolveEspnTeam(index.teams, expectedTeam);
  const found = index.byName.get(normaliseEspnName(playerName)) ?? [];
  const foundOn = found.map((p) => ({ team: p.team.displayName, espnAthleteId: p.espnAthleteId }));
  const base = { playerName, expectedTeam, foundOn };
  const incomplete = index.rostersFailed.length > 0;

  if (!resolved.ok) {
    return {
      ...base,
      verdict: "TEAM_NOT_RESOLVED",
      resolvedExpectedTeam: null,
      note:
        `"${expectedTeam}" could not be matched to an ESPN ${index.sport.toUpperCase()} team: ${resolved.reason}` +
        (foundOn.length ? ` For context, ESPN lists ${playerName} on: ${foundOn.map((f) => f.team).join(", ")}.` : ""),
    };
  }
  const want = resolved.value;
  if (found.some((p) => p.team.id === want.id)) {
    return {
      ...base,
      verdict: "CONFIRMED",
      resolvedExpectedTeam: want.displayName,
      note:
        `ESPN's current ${want.displayName} roster lists ${playerName}. Team field only: this says ` +
        `nothing about health or minutes (that is tkb_get_injuries).`,
    };
  }
  if (found.length) {
    return {
      ...base,
      verdict: "MISMATCH",
      resolvedExpectedTeam: want.displayName,
      note:
        `ESPN lists ${playerName} on ${foundOn.map((f) => f.team).join(", ")}, NOT on ${want.displayName}. ` +
        `The odds feed's team field is the likely error. Do not publish until resolved.`,
    };
  }
  if (incomplete) {
    return {
      ...base,
      verdict: "INCONCLUSIVE",
      resolvedExpectedTeam: want.displayName,
      note:
        `${playerName} is not on ESPN's ${want.displayName} roster, but ${index.rostersFailed.length} other ` +
        `roster(s) failed to load (${index.rostersFailed.slice(0, 5).join(", ")}), so he may be on one ` +
        `of those. Absence here is NOT evidence. Confirm by search.`,
    };
  }
  return {
    ...base,
    verdict: "NAME_NOT_FOUND",
    resolvedExpectedTeam: want.displayName,
    note:
      `No "${playerName}" on any of ESPN's ${index.rostersLoaded} ${index.sport.toUpperCase()} rosters. Usually a ` +
      `spelling difference (nickname, suffix, accent) or a player released or not yet signed. Confirm by search.`,
  };
}
