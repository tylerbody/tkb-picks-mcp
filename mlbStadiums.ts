/**
 * MLB stadium coordinates and roof type, keyed by SGO teamID (matches the
 * teamID format used elsewhere in this connector, e.g. "PHILADELPHIA_PHILLIES_MLB").
 *
 * roofType determines whether weather is even relevant:
 *   - "outdoor": weather always relevant
 *   - "dome": fully enclosed, permanently - weather is NEVER a factor, skip entirely
 *   - "retractable": roof MAY be open or closed on a given night - this is a
 *     real-time team decision, usually announced same-day, and NOT something
 *     this static table or the weather API can know. Tools using this data
 *     must flag retractable-roof games as "roof status unconfirmed" rather
 *     than assuming weather applies, unless a live search confirms it's open.
 *
 * IMPORTANT: stadium locations can change (e.g. a team playing at a temporary
 * home due to renovation, natural disaster, or relocation). This table
 * reflects standard/primary venues as of this build and should be spot-checked
 * if a team's actual game location seems inconsistent with expectations -
 * same verification discipline as everything else in this connector.
 */
export interface StadiumInfo {
  name: string;
  lat: number;
  lon: number;
  roofType: "outdoor" | "dome" | "retractable";
}

export const MLB_STADIUMS: Record<string, StadiumInfo> = {
  BALTIMORE_ORIOLES_MLB: { name: "Oriole Park at Camden Yards", lat: 39.2839, lon: -76.6218, roofType: "outdoor" },
  BOSTON_RED_SOX_MLB: { name: "Fenway Park", lat: 42.3467, lon: -71.0972, roofType: "outdoor" },
  NEW_YORK_YANKEES_MLB: { name: "Yankee Stadium", lat: 40.8296, lon: -73.9262, roofType: "outdoor" },
  TAMPA_BAY_RAYS_MLB: { name: "Tropicana Field", lat: 27.7683, lon: -82.6534, roofType: "dome" },
  TORONTO_BLUE_JAYS_MLB: { name: "Rogers Centre", lat: 43.6414, lon: -79.3894, roofType: "retractable" },
  CHICAGO_WHITE_SOX_MLB: { name: "Rate Field", lat: 41.8299, lon: -87.6338, roofType: "outdoor" },
  CLEVELAND_GUARDIANS_MLB: { name: "Progressive Field", lat: 41.4962, lon: -81.6852, roofType: "outdoor" },
  DETROIT_TIGERS_MLB: { name: "Comerica Park", lat: 42.339, lon: -83.0485, roofType: "outdoor" },
  KANSAS_CITY_ROYALS_MLB: { name: "Kauffman Stadium", lat: 39.0517, lon: -94.4803, roofType: "outdoor" },
  MINNESOTA_TWINS_MLB: { name: "Target Field", lat: 44.9817, lon: -93.2776, roofType: "outdoor" },
  HOUSTON_ASTROS_MLB: { name: "Daikin Park", lat: 29.7573, lon: -95.3555, roofType: "retractable" },
  LOS_ANGELES_ANGELS_MLB: { name: "Angel Stadium", lat: 33.8003, lon: -117.8827, roofType: "outdoor" },
  ATHLETICS_MLB: { name: "Sutter Health Park", lat: 38.5802, lon: -121.5133, roofType: "outdoor" },
  ATLANTA_BRAVES_MLB: { name: "Truist Park", lat: 33.8908, lon: -84.4678, roofType: "outdoor" },
  MIAMI_MARLINS_MLB: { name: "loanDepot park", lat: 25.7781, lon: -80.2197, roofType: "retractable" },
  NEW_YORK_METS_MLB: { name: "Citi Field", lat: 40.7571, lon: -73.8458, roofType: "outdoor" },
  PHILADELPHIA_PHILLIES_MLB: { name: "Citizens Bank Park", lat: 39.9061, lon: -75.1665, roofType: "outdoor" },
  WASHINGTON_NATIONALS_MLB: { name: "Nationals Park", lat: 38.873, lon: -77.0074, roofType: "outdoor" },
  CHICAGO_CUBS_MLB: { name: "Wrigley Field", lat: 41.9484, lon: -87.6553, roofType: "outdoor" },
  CINCINNATI_REDS_MLB: { name: "Great American Ball Park", lat: 39.0979, lon: -84.5082, roofType: "outdoor" },
  MILWAUKEE_BREWERS_MLB: { name: "American Family Field", lat: 43.028, lon: -87.9712, roofType: "retractable" },
  PITTSBURGH_PIRATES_MLB: { name: "PNC Park", lat: 40.4469, lon: -80.0057, roofType: "outdoor" },
  ST_LOUIS_CARDINALS_MLB: { name: "Busch Stadium", lat: 38.6226, lon: -90.1928, roofType: "outdoor" },
  ARIZONA_DIAMONDBACKS_MLB: { name: "Chase Field", lat: 33.4453, lon: -112.0667, roofType: "retractable" },
  COLORADO_ROCKIES_MLB: { name: "Coors Field", lat: 39.7559, lon: -104.9942, roofType: "outdoor" },
  LOS_ANGELES_DODGERS_MLB: { name: "Dodger Stadium", lat: 34.0739, lon: -118.24, roofType: "outdoor" },
  SAN_DIEGO_PADRES_MLB: { name: "Petco Park", lat: 32.7073, lon: -117.1566, roofType: "outdoor" },
  SAN_FRANCISCO_GIANTS_MLB: { name: "Oracle Park", lat: 37.7786, lon: -122.3893, roofType: "outdoor" },
};
