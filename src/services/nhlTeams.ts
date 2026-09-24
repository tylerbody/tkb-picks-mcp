/**
 * SGO TEAM IDENTITY -> THE NHL'S THREE-LETTER CLUB CODE.
 *
 * ============================================================================
 * WHY A TABLE HERE AND A DERIVATION FOR COLLEGE
 * ============================================================================
 *
 * cbbdHitRateAggregator derives a team name by stripping and title-casing, because
 * there are 350+ D1 programs and no table could be complete. It says so, and it
 * reports the name it searched on a miss precisely because the derivation will fail
 * on someone.
 *
 * The NHL has THIRTY-TWO clubs. A complete table is possible, so a derivation would be
 * a strictly worse choice: it would fail on exactly the clubs whose names do not reduce
 * cleanly, and the failures would look like absent players. Every row below is written
 * out.
 *
 * MEASURED PRECEDENT FOR THE KEY SHAPE: SGO writes team ids as the upper-cased name
 * plus the league, confirmed live on MLB (`TEXAS_RANGERS_MLB`) and CBB (`PURDUE_NCAAB`).
 * So hockey should arrive as `BUFFALO_SABRES_NHL`. That is an INFERENCE from the two
 * leagues measured, not a measurement, so this resolver accepts several shapes: the
 * full id, the id with its league suffix stripped, the display name, and the club code
 * itself. Whichever SGO actually sends, one of them matches, and an unmatched value
 * returns null rather than a guessed club.
 *
 * ============================================================================
 * TWO ROWS THAT ARE EASY TO GET WRONG
 * ============================================================================
 *
 * UTAH. The Arizona Coyotes moved to Salt Lake City, played 2024-25 as the Utah Hockey
 * Club, and are the UTAH MAMMOTH from 2025-26. Club code UTA. An old ARI or PHX row
 * would resolve a live club to a franchise that no longer exists, so those two are
 * mapped to UTA as historical aliases rather than left to fail silently.
 *
 * MONTREAL AND ST. LOUIS have accents and punctuation the two feeds spell differently
 * ("Montréal Canadiens", "St. Louis Blues", "St Louis"). Names are normalised to
 * letters and digits before lookup, which is the same thing the BDL team reconciler
 * does and for the same reason: the feeds agree about letters and disagree about
 * everything else.
 */

/** Normalise to letters and digits only, so punctuation and accents cannot matter. */
function norm(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Full club name -> NHL club code. All 32, current for the 2026-27 season. */
export const NHL_CLUB_CODES: Record<string, string> = {
  "Anaheim Ducks": "ANA",
  "Boston Bruins": "BOS",
  "Buffalo Sabres": "BUF",
  "Calgary Flames": "CGY",
  "Carolina Hurricanes": "CAR",
  "Chicago Blackhawks": "CHI",
  "Colorado Avalanche": "COL",
  "Columbus Blue Jackets": "CBJ",
  "Dallas Stars": "DAL",
  "Detroit Red Wings": "DET",
  "Edmonton Oilers": "EDM",
  "Florida Panthers": "FLA",
  "Los Angeles Kings": "LAK",
  "Minnesota Wild": "MIN",
  "Montreal Canadiens": "MTL",
  "Nashville Predators": "NSH",
  "New Jersey Devils": "NJD",
  "New York Islanders": "NYI",
  "New York Rangers": "NYR",
  "Ottawa Senators": "OTT",
  "Philadelphia Flyers": "PHI",
  "Pittsburgh Penguins": "PIT",
  "San Jose Sharks": "SJS",
  "Seattle Kraken": "SEA",
  "St. Louis Blues": "STL",
  "Tampa Bay Lightning": "TBL",
  "Toronto Maple Leafs": "TOR",
  "Utah Mammoth": "UTA",
  "Vancouver Canucks": "VAN",
  "Vegas Golden Knights": "VGK",
  "Washington Capitals": "WSH",
  "Winnipeg Jets": "WPG",
};

/**
 * Alternate spellings and dead franchise names, mapped rather than left to fail.
 *
 * A FRANCHISE MOVE IS NOT A TYPO. An "Arizona Coyotes" id in an archived pick or an
 * older cached event should resolve to the club that exists now, and the alternative is
 * a refusal that reads like a missing player.
 */
const NHL_CLUB_ALIASES: Record<string, string> = {
  "arizona coyotes": "UTA",
  "phoenix coyotes": "UTA",
  "utah hockey club": "UTA",
  utah: "UTA",
  "las vegas golden knights": "VGK",
  "montreal canadiens": "MTL",
  canadiens: "MTL",
  "st louis blues": "STL",
  "saint louis blues": "STL",
  "los angeles kings": "LAK",
  "tampa bay lightning": "TBL",
  "san jose sharks": "SJS",
  "new jersey devils": "NJD",
  "columbus blue jackets": "CBJ",
  "washington capitals": "WSH",
  "winnipeg jets": "WPG",
  "vegas golden knights": "VGK",
};

const BY_NORMALISED_NAME = new Map<string, string>();
for (const [name, code] of Object.entries(NHL_CLUB_CODES)) {
  BY_NORMALISED_NAME.set(norm(name), code);
}
for (const [alias, code] of Object.entries(NHL_CLUB_ALIASES)) {
  BY_NORMALISED_NAME.set(norm(alias), code);
}
const VALID_CODES = new Set(Object.values(NHL_CLUB_CODES));

/**
 * Resolve any of: an SGO teamID, a display name, or a club code, to a club code.
 *
 * Returns null on no match. NEVER a best guess - a wrong club silently produces a
 * roster that does not contain the player, which surfaces as "that player is not on
 * this team" and sends the reader looking in the wrong place entirely.
 */
export function nhlClubCode(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already a club code.
  const upper = trimmed.toUpperCase();
  if (VALID_CODES.has(upper)) return upper;

  // SGO id shape: strip a trailing league suffix and turn underscores into spaces.
  const stripped = trimmed.replace(/_NHL$/i, "").replace(/_/g, " ");

  return BY_NORMALISED_NAME.get(norm(stripped)) ?? BY_NORMALISED_NAME.get(norm(trimmed)) ?? null;
}

/** Every club code, for tests and for error messages that need to show the set. */
export function allNhlClubCodes(): string[] {
  return [...VALID_CODES].sort();
}
