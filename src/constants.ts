// Response size guard - if a formatted response would exceed this, truncate with a clear message
export const CHARACTER_LIMIT = 25000;

// SportsGameOdds API
export const SGO_BASE_URL = "https://api.sportsgameodds.com/v2";

// BALLDONTLIE API - base URL differs per sport (path-based, not subdomain)
export const BDL_BASE_URL = "https://api.balldontlie.io";

// Maps our internal sport identifiers to each provider's expected league/sport identifiers.
// This is the single place to extend when NBA/NHL seasons start - add a row here,
// nothing else in the codebase needs to change.
export const SPORT_CONFIG = {
  mlb: {
    label: "MLB",
    sgoLeagueID: "MLB",
    bdlPath: "mlb",
  },
  wnba: {
    label: "WNBA",
    sgoLeagueID: "WNBA",
    bdlPath: "wnba",
  },
  nfl: {
    label: "NFL",
    sgoLeagueID: "NFL",
    bdlPath: "nfl",
  },
  cfb: {
    label: "NCAAF",
    sgoLeagueID: "NCAAF",
    bdlPath: "ncaaf",
  },
  // Add when NBA season starts:
  // nba: { label: "NBA", sgoLeagueID: "NBA", bdlPath: "nba" },
  // Add when NHL season starts:
  // nhl: { label: "NHL", sgoLeagueID: "NHL", bdlPath: "nhl" },
} as const;

export type SportKey = keyof typeof SPORT_CONFIG;

export const SUPPORTED_SPORTS = Object.keys(SPORT_CONFIG) as SportKey[];
