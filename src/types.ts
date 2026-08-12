import type { SportKey } from "./constants.js";

// ---- SportsGameOdds raw response shapes (partial - only fields we use) ----
// NOTE: these are written against SGO's documented schema. Since this codebase
// has not yet been run against live SGO responses, treat these as the best
// current guess and adjust once real payloads are seen (see services/sgoClient.ts
// header comment for the specific fields flagged as unverified).

export interface SGOTeam {
  teamID: string;
  // Not always populated by SGO - previously caused "undefined: 8-9" output.
  name?: string;
  city?: string;
  // CONFIRMED via SGO's official OpenAPI spec: teams have a real standings
  // object with wins/losses/record directly available - no need to compute
  // this ourselves by fetching and tallying every event.
  standings?: {
    position?: string;
    wins?: number;
    losses?: number;
    ties?: number;
    record?: string;
    played?: number;
    last5?: string;
    streak?: number;
  };
}

export interface SGOPlayer {
  playerID: string;
  name: string;
  teamID: string;
  position?: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
}

export interface SGOBookmakerOdds {
  odds: string; // American odds as string, e.g. "-110"
  spread?: string;
  overUnder?: string;
  // CONFIRMED via live test: real per-bookmaker entries carry these.
  available?: boolean;
  lastUpdatedAt?: string;
  deeplink?: string;
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
  // CONFIRMED via live test (8 Aug 2026): SGO exposes these two flags and they are
  // the reliable way to tell a REAL, book-priced market from a market that merely
  // exists in the catalog with only a model-derived "fair" estimate attached.
  //
  // This distinction matters enormously. An NFL Week 1 passing-yards prop pulled
  // five weeks out returned odds of -137 on BOTH sides with no line and no
  // bookmaker - no sportsbook had priced it yet, so what came back was SGO's own
  // fair-value estimate. Real two-sided markets are never symmetric like that.
  // Publishing that number would be publishing a placeholder, which is banned.
  bookOddsAvailable?: boolean;
  fairOddsAvailable?: boolean;
  // Top-level line fields - more reliable than digging into byBookmaker, which is
  // empty whenever no book has priced the market.
  bookSpread?: string;
  bookOverUnder?: string;
  fairSpread?: string;
  fairOverUnder?: string;
  marketName?: string;
  statEntityID?: string;
  cancelled?: boolean;
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
      regionName?: string;
      countryCode?: string;
      address?: string;
      capacity?: number;
    };
    seasonWeek?: string;
  };
  /** "match" for games. Futures/outright markets use a different type. */
  type?: string;
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
  // FIELD NAME VARIES BY SPORT - confirmed via live debug tool on 8 Aug 2026.
  // MLB/WNBA return `display_name`; NFL returns `full_name` (plus location/name).
  // Neither is guaranteed present, so resolveTeamName() in tools/injuries.ts
  // checks all of them in order rather than assuming one shape.
  display_name?: string;
  full_name?: string;
  name: string;
  short_display_name?: string;
  abbreviation: string;
  slug?: string;
  location?: string;
  league?: string;
  division?: string;
}

export interface BDLPlayer {
  id: number;
  first_name: string;
  last_name: string;
  team_id?: number;
  team?: BDLTeam;
}

export interface BDLInjury {
  player: BDLPlayer; // team info correctly lives nested here: player.team.display_name
  return_date: string | null;
  status: string; // e.g. "15-Day-IL", "60-Day-IL", "Questionable"
  type?: string; // e.g. "Lower Body", "Elbow"
  detail?: string; // e.g. "Strain", "Surgery"
  side?: string; // e.g. "Left", "Right"
  date?: string; // when this injury update was logged
  short_comment?: string; // brief sourced update (MLB/WNBA)
  long_comment?: string; // fuller sourced update with context
  description?: string; // some sports/endpoints use this instead
  // CONFIRMED via live debug tool: NFL uses a plain `comment` field and does NOT
  // populate short_comment/description, which is why every NFL injury previously
  // rendered as "no summary available".
  comment?: string;
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

/**
 * BALLDONTLIE standings row.
 *
 * This single object supplies everything splitsAggregator previously computed by
 * pulling and tallying up to 100 finalized SGO events per call - plus several
 * fields that were not obtainable that way at all (point_differential,
 * division/conference record, playoff seed).
 *
 * Field availability varies by sport. NFL is confirmed to return the full set
 * shown here. Treat every field as optional and report what is actually present
 * rather than assuming, which is the same discipline applied elsewhere in this
 * connector after being burned by assumed field shapes twice.
 */
export interface BDLStanding {
  team: BDLTeam;
  season?: number;
  wins?: number;
  losses?: number;
  ties?: number;

  // ---- NFL-style field names ----
  overall_record?: string;
  home_record?: string;
  road_record?: string;
  division_record?: string;
  conference_record?: string;
  win_streak?: number;

  // ---- MLB-style field names (CONFIRMED DIFFERENT, 8 Aug 2026) ----
  // MLB and NFL do NOT share a standings schema. MLB returns "home": "44-37"
  // where NFL returns "home_record": "3-0". Reading only the NFL names is why
  // the MLB standings lookup silently failed and fell back to the expensive
  // SGO event-tallying path. Both shapes are declared here and resolved at
  // read time rather than assuming either one.
  total?: string;
  home?: string;
  road?: string;
  intra_division?: string;
  intra_league?: string;
  streak?: number;
  last_ten_games?: string;
  // MLB also exposes these as real numbers, which avoids string parsing entirely.
  home_wins?: number;
  home_losses?: number;
  home_ties?: number;
  road_wins?: number;
  road_losses?: number;
  road_ties?: number;
  // Runs/points per game - useful for totals reasoning.
  avg_points_for?: number;
  avg_points_against?: number;
  games_behind?: number;
  win_percent?: number;

  // ---- Shared ----
  points_for?: number;
  points_against?: number;
  point_differential?: number;
  playoff_seed?: number;
  games_played?: number;
}

/**
 * Normalized standings view, resolved across the differing per-sport field names.
 * Tools should read THIS rather than touching BDLStanding fields directly.
 */
export interface NormalizedStanding {
  [key: string]: unknown;
  teamName: string;
  overallRecord: string | null;
  homeRecord: string | null;
  roadRecord: string | null;
  homeWins: number | null;
  homeLosses: number | null;
  roadWins: number | null;
  roadLosses: number | null;
  divisionRecord: string | null;
  conferenceRecord: string | null;
  lastTen: string | null;
  streak: number | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  pointDifferential: number | null;
  avgPointsFor: number | null;
  avgPointsAgainst: number | null;
  playoffSeed: number | null;
  gamesPlayed: number | null;
  season: number | null;
}

export interface BDLStandingsResponse {
  data: BDLStanding[];
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
  /** e.g. "Week 1" - present on NFL/CFB events. */
  seasonWeek?: string;
  venue?: string;
  /** CFB only: named rivalry, if this matchup is one. */
  rivalry?: string;
  /** CFB only: conference of either participant, if Power 4. */
  conference?: string;
  /** CFB only: which participants were in the supplied Top 25 list. */
  rankedTeams?: string[];
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
  [key: string]: unknown;
  playerName: string;
  team: string;
  status: string;
  type?: string;
  detail?: string;
  side?: string;
  summary: string; // sport-dependent: comment / short_comment / description
  returnDate: string | null;
  /** When this injury update was logged by the provider. */
  updatedAt?: string;
}

export interface GameLogEntry {
  eventID: string;
  date: string;
  opponent: string;
  isHome: boolean;
  statValue: number | null; // null = player had no recorded value (did not play / DNP)
  /** Which season this game belongs to (year the season started). */
  seasonYear?: number;
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
  /**
   * Game-by-game log, ORDERED NEWEST FIRST. log[0] is the most recent appearance.
   *
   * Stated explicitly because reading this ordering backwards has already caused a
   * published error: a hitter's most recent game was described as the oldest,
   * turning "7 total bases last night" into "held to zero in five straight". Every
   * value in the array was correct; only the direction was assumed. Each entry
   * carries its own `date` - use it rather than relying on position.
   */
  log: GameLogEntry[];
  // Both directions computed from the same appearance set, so an UNDER can be
  // evaluated without a second call or manual inversion.
  overHits: number;
  underHits: number;
  pushCount: number; // whole-number lines only; previously miscounted as misses
  // How far back we actually had to scan to collect the appearances.
  teamGamesScanned: number;
  hitScanCeiling: boolean;
  // Sample adequacy. A rate computed on 1-2 appearances is not evidence.
  sampleSufficient: boolean;
  sampleWarning: string | null;
  playerRole: "starting_pitcher" | "position_player";
  // Playing-time signal. Surfaces DNP patterns that a raw hit rate hides.
  recentAvailability: {
    gamesPlayed: number;
    teamGamesScanned: number;
    playRate: number;
    flag: "OK" | "IRREGULAR" | "ROTATION_NORMAL";
    note: string | null;
  };
  // Season provenance - prevents prior-season games being written up as current form.
  currentSeasonGames: number;
  priorSeasonGames: number;
  seasonsRepresented: number[];
  crossesSeasonBoundary: boolean;
  seasonWarning: string | null;
}

export interface TeamSplitRecord {
  [key: string]: unknown;
  teamName: string;
  wins: number;
  losses: number;
  context: string; // e.g. "home", "road", "vs DET last 3 seasons"
}
