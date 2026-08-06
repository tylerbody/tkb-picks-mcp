import type { SportKey } from "./constants.js";

// ---- SportsGameOdds raw response shapes (partial - only fields we use) ----
// NOTE: these are written against SGO's documented schema. Since this codebase
// has not yet been run against live SGO responses, treat these as the best
// current guess and adjust once real payloads are seen (see services/sgoClient.ts
// header comment for the specific fields flagged as unverified).

export interface SGOTeam {
  teamID: string;
  name: string;
  city?: string;
}

export interface SGOPlayer {
  playerID: string;
  name: string;
  teamID: string;
  position?: string;
}

export interface SGOBookmakerOdds {
  odds: string; // American odds as string, e.g. "-110"
  spread?: string;
  overUnder?: string;
}

export interface SGOOdd {
  oddID: string;
  statID: string;
  playerID?: string;
  teamID?: string;
  periodID?: string;
  betTypeID?: string;
  sideID?: string;
  fairOdds?: string;
  bookOdds?: string;
  byBookmaker?: Record<string, SGOBookmakerOdds>;
}

export interface SGOEvent {
  eventID: string;
  status: {
    started?: boolean;
    completed?: boolean;
    live?: boolean;
    displayShort?: string;
    displayLong?: string;
    startsAt?: string; // ISO timestamp - CONFIRMED via live test, this is the real field (not info.date)
  };
  info?: {
    venue?: {
      name?: string;
      city?: string;
      regionCode?: string;
    };
  };
  teams: {
    home: { teamID: string; names?: { long?: string }; score?: number };
    away: { teamID: string; names?: { long?: string }; score?: number };
  };
  odds?: Record<string, SGOOdd>;
  // results holds final/live stat lines, keyed by periodID -> statEntityID -> statID
  results?: Record<string, Record<string, Record<string, number>>>;
  players?: Record<string, SGOPlayer>;
  // NOTE: no `lineups` field exists on the event object - confirmed via live test
  // against an upcoming game. SGO does not expose probable/confirmed starting
  // pitchers or lineups pre-game. Starting pitcher info must come from web search.
  leagueID: string;
  sportID: string;
}

export interface SGOEventsResponse {
  data: SGOEvent[];
  nextCursor?: string | null;
}

// ---- BALLDONTLIE raw response shapes (partial) ----

export interface BDLTeam {
  id: number;
  full_name: string;
  abbreviation: string;
}

export interface BDLPlayer {
  id: number;
  first_name: string;
  last_name: string;
  team_id?: number;
  team?: BDLTeam;
}

export interface BDLInjury {
  player: BDLPlayer;
  return_date: string | null;
  description: string;
  status: string; // e.g. "Out", "Questionable", "Doubtful"
}

export interface BDLInjuriesResponse {
  data: BDLInjury[];
  meta?: { next_cursor?: number | null; per_page?: number };
}

export interface BDLGame {
  id: number;
  date: string;
  season: number;
  status: string;
  home_team: BDLTeam;
  visitor_team: BDLTeam;
  home_team_score?: number;
  visitor_team_score?: number;
}

export interface BDLGamesResponse {
  data: BDLGame[];
  meta?: { next_cursor?: number | null; per_page?: number };
}

// ---- Our own normalized/output types (what tools actually return) ----

export interface NormalizedGame {
  eventID: string;
  sport: SportKey;
  startTimeISO: string;
  status: string;
  homeTeam: string;
  awayTeam: string;
  homeScore?: number;
  awayScore?: number;
}

export interface NormalizedOddsLine {
  [key: string]: unknown;
  oddID: string;
  statID: string;
  description: string;
  line?: string;
  americanOdds?: string;
  bookmaker?: string;
}

export interface NormalizedInjury {
  playerName: string;
  team: string;
  status: string;
  description: string;
  returnDate: string | null;
}

export interface GameLogEntry {
  eventID: string;
  date: string;
  opponent: string;
  isHome: boolean;
  statValue: number | null; // null = player had no recorded value (did not play / DNP)
}

export interface HitRateResult {
  [key: string]: unknown;
  playerName: string;
  statID: string;
  line: number;
  direction: "over" | "under";
  gamesConsidered: number; // true sample size, after excluding DNP games
  gamesHit: number;
  gamesExcludedDNP: number;
  log: GameLogEntry[];
}

export interface TeamSplitRecord {
  [key: string]: unknown;
  teamName: string;
  wins: number;
  losses: number;
  context: string; // e.g. "home", "road", "vs DET last 3 seasons"
}
