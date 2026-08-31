// Response size guard - if a formatted response would exceed this, truncate with a clear message
export const CHARACTER_LIMIT = 25000;

// SportsGameOdds API
export const SGO_BASE_URL = "https://api.sportsgameodds.com/v2";

// BALLDONTLIE API - base URL differs per sport (path-based, not subdomain)
export const BDL_BASE_URL = "https://api.balldontlie.io";

/**
 * WHAT A SPORT CAN ACTUALLY DO.
 *
 * WHY THIS EXISTS (added v2.6.0 with the tennis build): adding ATP/WTA widened
 * every tool's sport enum at once, because SUPPORTED_SPORTS is derived from
 * SPORT_CONFIG. Six tools would then have accepted sport="atp" and returned
 * something confidently useless rather than refusing:
 *
 *   - tkb_get_game_weather fell through to the CFB branch and searched
 *     CFB_STADIUMS for a tennis player's name
 *   - tkb_get_players returned "props are not posted yet, retry closer to first
 *     pitch", which is false and invites a pointless retry - tennis participants
 *     occupy home/away event slots and there is no roster to populate, ever
 *   - tkb_get_player_hit_rate skipped BDL (no stat mapping) and went to the SGO
 *     path, which needs a teamID and playerID that do not exist for tennis
 *   - tkb_get_team_split fell through to tallying SGO events and produced a
 *     number with no meaning
 *
 * Every one of those is a plausible-looking wrong answer rather than a clear
 * refusal, which is the exact failure class this connector was built to prevent
 * (see services/oddsPricing.ts for the original statement of the rule).
 *
 * DECLARED HERE RATHER THAN BRANCHED IN EACH TOOL, for the same reason
 * standingsNormalizer resolves aliases instead of branching on sport: a per-tool
 * `if (sport === "atp")` breaks again the moment NHL or NBA arrives with its own
 * shape. One table, checked the same way everywhere, and adding a sport later is
 * a row rather than an audit.
 */
export interface SportCapabilities {
  /** Player-level over/under props exist and players have roster IDs. */
  playerProps: boolean;
  /** A per-player game-log source exists for counted hit rates. */
  hitRates: boolean;
  /** An injury feed exists on the current subscription. */
  injuries: boolean;
  /** Games are outdoors at a fixed, known venue. */
  weather: boolean;
  /** Home/road and head-to-head records are meaningful for this sport. */
  teamSplits: boolean;
}

const TEAM_SPORT_CAPABILITIES: SportCapabilities = {
  playerProps: true,
  hitRates: true,
  injuries: true,
  weather: true,
  teamSplits: true,
};

// Maps our internal sport identifiers to each provider's expected league/sport identifiers.
// This is the single place to extend when NBA/NHL seasons start - add a row here,
// and TypeScript will refuse to compile until every Record<SportKey, ...> table is
// filled in (marketCatalog has three, seasonBoundary has one). That compiler error
// is the feature: there is no way to add a sport and silently forget a table.
export const SPORT_CONFIG = {
  mlb: {
    label: "MLB",
    sgoLeagueID: "MLB",
    bdlPath: "mlb",
    supports: TEAM_SPORT_CAPABILITIES,
  },
  wnba: {
    label: "WNBA",
    sgoLeagueID: "WNBA",
    bdlPath: "wnba",
    // Indoors. The weather tool already returns "indoors, not a factor" for WNBA
    // by name; the flag keeps that answer consistent with every other sport.
    supports: { ...TEAM_SPORT_CAPABILITIES, weather: false },
  },
  nfl: {
    label: "NFL",
    sgoLeagueID: "NFL",
    bdlPath: "nfl",
    supports: TEAM_SPORT_CAPABILITIES,
  },
  cfb: {
    label: "NCAAF",
    sgoLeagueID: "NCAAF",
    bdlPath: "ncaaf",
    // CFB injuries are not available on the current BALLDONTLIE plan (see README
    // known gaps). Stats are GOAT-gated for ncaaf too, so hit rates fall back to
    // SGO rather than being unavailable - hitRates stays true.
    supports: { ...TEAM_SPORT_CAPABILITIES, injuries: false },
  },

  // ---- TENNIS ----
  //
  // MONEYLINE ONLY, DELIBERATELY. SGO does carry tennis games totals, games
  // handicaps, set winners and serving props, but this account posts moneyline
  // picks for tennis and nothing else, so none of the player-prop machinery is
  // wired up.
  //
  // TENNIS HAS NO PLAYERS IN SGO'S SENSE. Each competitor occupies the home or
  // away PARTICIPANT SLOT on the event rather than a roster position, so what is
  // a "player prop" in every other sport is addressed here through the home/away
  // entity. event.players is therefore permanently empty, which is why
  // playerProps and hitRates are false rather than "not yet built".
  //
  // A NOTE FOR WHOEVER ADDS TOTALS LATER: match winner settles on `points`,
  // which in tennis carries the SET score. Games totals and handicaps settle on
  // `games`, which carries the GAME count. Requesting points-all-game-ou-over
  // when you meant a games total is, per SGO's own docs, the most common tennis
  // integration mistake. Moneyline is unaffected - `points` is correct there,
  // which is why buildOddID needs no tennis-specific handling today.
  atp: {
    label: "ATP",
    sgoLeagueID: "ATP",
    // Real path: BALLDONTLIE publishes /atp/v1/head_to_head and /atp/v1/match_stats,
    // but as a SEPARATE subscription this account does not hold. Left populated
    // deliberately - the TTL tier gate in BDLClient handles the 401 on its own and
    // heals within 30 minutes if the subscription is ever bought, with no redeploy.
    bdlPath: "atp",
    supports: {
      playerProps: false,
      hitRates: false,
      injuries: false,
      weather: false,
      teamSplits: false,
    },
  },
  wta: {
    label: "WTA",
    sgoLeagueID: "WTA",
    bdlPath: "wta",
    supports: {
      playerProps: false,
      hitRates: false,
      injuries: false,
      weather: false,
      teamSplits: false,
    },
  },

  // Add when NBA season starts:
  // nba: { label: "NBA", sgoLeagueID: "NBA", bdlPath: "nba", supports: TEAM_SPORT_CAPABILITIES },
  // Add when NHL season starts:
  // nhl: { label: "NHL", sgoLeagueID: "NHL", bdlPath: "nhl", supports: TEAM_SPORT_CAPABILITIES },
} as const;

export type SportKey = keyof typeof SPORT_CONFIG;

export const SUPPORTED_SPORTS = Object.keys(SPORT_CONFIG) as SportKey[];

/** Sports where competitors are individuals in the home/away slots, not rosters. */
export const INDIVIDUAL_SPORTS: SportKey[] = ["atp", "wta"];

export function isIndividualSport(sport: SportKey): boolean {
  return INDIVIDUAL_SPORTS.includes(sport);
}

export function labelFor(sport: SportKey): string {
  return SPORT_CONFIG[sport].label;
}

export function supportsCapability(
  sport: SportKey,
  capability: keyof SportCapabilities
): boolean {
  return SPORT_CONFIG[sport].supports[capability];
}

/**
 * The refusal message a tool returns when a sport does not support what was asked.
 *
 * Centralised so every refusal explains the REASON rather than just saying no.
 * "Not supported" invites a retry; "tennis participants occupy event slots rather
 * than roster positions" does not.
 */
export function unsupportedMessage(
  sport: SportKey,
  capability: keyof SportCapabilities
): string {
  const label = SPORT_CONFIG[sport].label;
  const reasons: Record<keyof SportCapabilities, string> = {
    playerProps: isIndividualSport(sport)
      ? `${label} competitors occupy the home/away participant slots on an event rather than roster positions, so SGO never populates a player list and player props cannot be addressed by playerID. This is permanent, not a "retry closer to match time" situation. ${label} picks are moneyline only - use tkb_get_odds with marketType="moneyline".`
      : `Player props are not available for ${label}.`,
    hitRates: isIndividualSport(sport)
      ? `Counted hit rates are not available for ${label}. There is no per-player game-log source subscribed for this tour, and the SGO path needs a teamID/playerID that tennis events do not carry. Use researched or projection language in ${label} threads, per the style guide, rather than counted "X of his last Y" phrasing.`
      : `Hit rates are not available for ${label}.`,
    injuries: isIndividualSport(sport)
      ? `No injury feed is available for ${label} on the current subscription. Tennis withdrawals and retirements are announced by the tournament, so check tour news directly before posting a ${label} pick.`
      : `Injury data is not available for ${label} on the current BALLDONTLIE plan.`,
    weather: isIndividualSport(sport)
      ? `Weather is not wired up for ${label}. Tour events move between venues week to week, so there is no fixed stadium table to look up, and guessing a location would be worse than returning nothing. Grand Slam roof status must be checked via live search.`
      : `Weather is not a factor for ${label}.`,
    teamSplits: isIndividualSport(sport)
      ? `Team splits do not apply to ${label} - there are no teams. For head-to-head history between two players, use live search; SGO's event feed is not a reliable H2H source across seasons.`
      : `Team splits are not available for ${label}.`,
  };
  return reasons[capability];
}
