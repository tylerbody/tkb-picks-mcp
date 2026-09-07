/**
 * College football game-selection tiers.
 *
 * PROBLEM THIS SOLVES: SGO's NCAAF feed returns EVERY level of college football,
 * not just FBS. A live test on 29 Aug 2026 returned "Lenoir Rhyne Bears vs
 * Virginia Union Panthers" and "Livingstone Blue Bears vs Allen Yellow Jackets"
 * (Division II) mixed in alongside USC and Florida State. Posting those is
 * pointless, so the schedule tool needs to filter down to games actually worth
 * building a thread for.
 *
 * THREE TIERS, in the order they're applied:
 *   1. "top25"   - a ranked team is involved. Requires rankings passed IN
 *                  (see note below).
 *   2. "power4"  - SEC / Big Ten / Big 12 / ACC, plus Notre Dame.
 *   3. "rivalry" - named rivalry games regardless of ranking or conference.
 *                  Mostly late November; irrelevant in September.
 *
 * WHY RANKINGS ARE AN INPUT, NOT A LOOKUP: SGO's team objects were confirmed via
 * live test NOT to expose a verified ranking field. Rather than hardcode a Top 25
 * that goes stale within a week (and silently returns wrong results all season),
 * the schedule tool accepts a rankedTeams list that the caller supplies from a
 * live web search. Filtering is done here; the ranking itself comes from a fresh
 * source every time. That keeps this file free of anything that rots weekly.
 */

/** Normalize an SGO team display name into a stable lookup key. */
export function normalizeTeamKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (e.g. "San José" -> "san jose")
    .replace(/[^a-z0-9& ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const SEC = [
  "alabama", "arkansas", "auburn", "florida", "georgia", "kentucky", "lsu",
  "mississippi state", "missouri", "ole miss", "oklahoma", "south carolina",
  "tennessee", "texas", "texas a&m", "vanderbilt",
];

export const BIG_TEN = [
  "illinois", "indiana", "iowa", "maryland", "michigan", "michigan state",
  "minnesota", "nebraska", "northwestern", "ohio state", "oregon", "penn state",
  "purdue", "rutgers", "ucla", "usc", "washington", "wisconsin",
];

export const BIG_12 = [
  "arizona", "arizona state", "baylor", "byu", "cincinnati", "colorado",
  "houston", "iowa state", "kansas", "kansas state", "oklahoma state", "tcu",
  "texas tech", "ucf", "utah", "west virginia",
];

export const ACC = [
  "boston college", "california", "clemson", "duke", "florida state",
  "georgia tech", "louisville", "miami", "nc state", "north carolina",
  "pittsburgh", "smu", "stanford", "syracuse", "virginia", "virginia tech",
  "wake forest",
];

/** Notre Dame is independent but always a Power-tier posting target. */
export const INDEPENDENT_MAJORS = ["notre dame"];

export const POWER_4 = new Set<string>([
  ...SEC, ...BIG_TEN, ...BIG_12, ...ACC, ...INDEPENDENT_MAJORS,
]);

export const CONFERENCE_MAP: Record<string, string[]> = {
  sec: SEC,
  "big ten": BIG_TEN,
  "big 12": BIG_12,
  acc: ACC,
};

/**
 * Group of 5 and other FBS programs worth posting when they're in a good spot.
 * Used ONLY to distinguish real FBS football from the Division II noise in the
 * feed - being on this list does not by itself make a game a posting target.
 */
export const OTHER_FBS = new Set<string>([
  "boise state", "memphis", "tulane", "unlv", "app state", "liberty", "navy",
  "army", "san jose state", "hawaii", "eastern michigan", "toledo", "ohio",
  "western kentucky", "james madison", "coastal carolina", "south florida",
  "north texas", "utsa", "fresno state", "san diego state", "colorado state",
  "wyoming", "air force", "nevada", "unm", "new mexico", "texas state",
  "louisiana", "marshall", "georgia southern", "troy", "arkansas state",
  "miami ohio", "buffalo", "kent state", "bowling green", "northern illinois",
  "central michigan", "western michigan", "ball state", "akron", "temple",
  "east carolina", "charlotte", "florida atlantic", "rice", "tulsa", "uab",
  "middle tennessee", "jacksonville state", "sam houston", "kennesaw state",
  "louisiana tech", "southern miss", "ul monroe", "old dominion", "delaware",
  "missouri state", "washington state", "oregon state", "uconn", "umass",
]);

/**
 * Named rivalry games, as normalized team-name pairs. Order within a pair does
 * not matter - matching is symmetric.
 *
 * Includes both marquee national rivalries and the mid-size regional ones that
 * still carry real local betting interest (Indiana/Purdue for the Old Oaken
 * Bucket being the specific example that motivated this list).
 *
 * Almost all of these land in the final two weeks of November. Expect this tier
 * to contribute nothing in September and October.
 */
export const RIVALRIES: { teams: [string, string]; name: string }[] = [
  { teams: ["michigan", "ohio state"], name: "The Game" },
  { teams: ["alabama", "auburn"], name: "Iron Bowl" },
  { teams: ["ole miss", "mississippi state"], name: "Egg Bowl" },
  { teams: ["oklahoma", "oklahoma state"], name: "Bedlam" },
  { teams: ["texas", "texas a&m"], name: "Lone Star Showdown" },
  { teams: ["texas", "oklahoma"], name: "Red River Rivalry" },
  { teams: ["indiana", "purdue"], name: "Old Oaken Bucket" },
  { teams: ["minnesota", "wisconsin"], name: "Paul Bunyan's Axe" },
  { teams: ["michigan", "michigan state"], name: "Paul Bunyan Trophy" },
  { teams: ["iowa", "iowa state"], name: "Cy-Hawk Trophy" },
  { teams: ["iowa", "minnesota"], name: "Floyd of Rosedale" },
  { teams: ["iowa", "nebraska"], name: "Heroes Trophy" },
  { teams: ["illinois", "northwestern"], name: "Land of Lincoln Trophy" },
  { teams: ["penn state", "michigan state"], name: "Land Grant Trophy" },
  { teams: ["notre dame", "usc"], name: "Jeweled Shillelagh" },
  { teams: ["notre dame", "stanford"], name: "Legends Trophy" },
  { teams: ["notre dame", "navy"], name: "Notre Dame vs Navy" },
  { teams: ["army", "navy"], name: "Army-Navy Game" },
  { teams: ["georgia", "florida"], name: "World's Largest Outdoor Cocktail Party" },
  { teams: ["georgia", "georgia tech"], name: "Clean Old-Fashioned Hate" },
  { teams: ["auburn", "georgia"], name: "Deep South's Oldest Rivalry" },
  { teams: ["alabama", "tennessee"], name: "Third Saturday in October" },
  { teams: ["tennessee", "vanderbilt"], name: "Tennessee vs Vanderbilt" },
  { teams: ["tennessee", "kentucky"], name: "Beer Barrel Rivalry" },
  { teams: ["kentucky", "louisville"], name: "Governor's Cup" },
  { teams: ["florida", "florida state"], name: "Florida vs Florida State" },
  { teams: ["florida", "miami"], name: "Florida vs Miami" },
  { teams: ["miami", "florida state"], name: "Miami vs Florida State" },
  { teams: ["clemson", "south carolina"], name: "Palmetto Bowl" },
  { teams: ["north carolina", "nc state"], name: "Textile Bowl" },
  { teams: ["north carolina", "duke"], name: "Victory Bell" },
  { teams: ["virginia", "virginia tech"], name: "Commonwealth Cup" },
  { teams: ["wake forest", "duke"], name: "Wake Forest vs Duke" },
  { teams: ["pittsburgh", "west virginia"], name: "Backyard Brawl" },
  { teams: ["penn state", "pittsburgh"], name: "Keystone Rivalry" },
  { teams: ["lsu", "arkansas"], name: "Battle for the Golden Boot" },
  { teams: ["lsu", "ole miss"], name: "Magnolia Bowl" },
  { teams: ["lsu", "alabama"], name: "LSU vs Alabama" },
  { teams: ["arkansas", "missouri"], name: "Battle Line Rivalry" },
  { teams: ["missouri", "kansas"], name: "Border War" },
  { teams: ["kansas", "kansas state"], name: "Sunflower Showdown" },
  { teams: ["baylor", "tcu"], name: "Revivalry" },
  { teams: ["texas tech", "baylor"], name: "Texas Tech vs Baylor" },
  { teams: ["byu", "utah"], name: "Holy War" },
  { teams: ["utah", "utah state"], name: "Battle of the Brothers" },
  { teams: ["colorado", "colorado state"], name: "Rocky Mountain Showdown" },
  { teams: ["arizona", "arizona state"], name: "Territorial Cup" },
  { teams: ["ucla", "usc"], name: "Victory Bell" },
  { teams: ["california", "stanford"], name: "Big Game" },
  { teams: ["oregon", "oregon state"], name: "Rivalry Series" },
  { teams: ["washington", "washington state"], name: "Apple Cup" },
  { teams: ["oregon", "washington"], name: "Oregon vs Washington" },
  { teams: ["cincinnati", "miami ohio"], name: "Victory Bell" },
  { teams: ["toledo", "bowling green"], name: "Battle of I-75" },
  { teams: ["boise state", "fresno state"], name: "Milk Can Game" },
  { teams: ["air force", "army"], name: "Commander-in-Chief's Trophy" },
  { teams: ["air force", "navy"], name: "Commander-in-Chief's Trophy" },
  { teams: ["marshall", "ohio"], name: "Battle for the Bell" },
  { teams: ["nebraska", "colorado"], name: "Nebraska vs Colorado" },
  { teams: ["maryland", "rutgers"], name: "Maryland vs Rutgers" },
];

/** Returns the rivalry name if these two teams play a named rivalry game. */
export function findRivalry(homeKey: string, awayKey: string): string | null {
  for (const r of RIVALRIES) {
    const [a, b] = r.teams;
    if ((a === homeKey && b === awayKey) || (a === awayKey && b === homeKey)) {
      return r.name;
    }
  }
  return null;
}

export function conferenceOf(teamKey: string): string | null {
  for (const [conf, teams] of Object.entries(CONFERENCE_MAP)) {
    if (teams.includes(teamKey)) return conf;
  }
  if (INDEPENDENT_MAJORS.includes(teamKey)) return "independent";
  return null;
}

export function isFBS(teamKey: string): boolean {
  return POWER_4.has(teamKey) || OTHER_FBS.has(teamKey);
}
