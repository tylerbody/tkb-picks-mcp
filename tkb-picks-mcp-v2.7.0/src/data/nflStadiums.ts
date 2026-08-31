import type { StadiumInfo } from "./mlbStadiums.js";

/**
 * NFL stadium coordinates and roof type, keyed by SGO teamID
 * (format confirmed via live test, e.g. "BALTIMORE_RAVENS_NFL", "SEATTLE_SEAHAWKS_NFL").
 *
 * Same roofType semantics as MLB_STADIUMS:
 *   - "outdoor": weather always relevant
 *   - "dome": fully enclosed permanently - weather is NEVER a factor
 *   - "retractable": roof MAY be open or closed, decided same-day by the team.
 *     NOT knowable from this table or the weather API - must be flagged for
 *     live-search verification, never assumed.
 *
 * NOTE ON SoFi STADIUM (Rams/Chargers): SoFi has a FIXED translucent canopy roof
 * but OPEN SIDES. It is not a dome and not retractable. Wind and temperature still
 * reach the field; rain essentially does not. Classified "retractable" here so the
 * tool forces a manual judgement call rather than silently returning either
 * "weather irrelevant" (wrong, wind matters) or a full outdoor forecast
 * (wrong, rain doesn't reach the field).
 *
 * Weather matters MORE in NFL than MLB for totals, passing props, and kicking
 * markets - wind above roughly 15mph is the single most actionable weather read.
 *
 * Spot-check if a team is playing an international game (London/Munich/Mexico City)
 * or at a temporary venue - this table reflects standard home venues only, and
 * weather.gov is US-only so international games will fail the forecast lookup.
 */
export const NFL_STADIUMS: Record<string, StadiumInfo> = {
  // AFC East
  BUFFALO_BILLS_NFL: { name: "Highmark Stadium", lat: 42.7738, lon: -78.787, roofType: "outdoor" },
  MIAMI_DOLPHINS_NFL: { name: "Hard Rock Stadium", lat: 25.958, lon: -80.2389, roofType: "outdoor" },
  NEW_ENGLAND_PATRIOTS_NFL: { name: "Gillette Stadium", lat: 42.0909, lon: -71.2643, roofType: "outdoor" },
  NEW_YORK_JETS_NFL: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, roofType: "outdoor" },

  // AFC North
  BALTIMORE_RAVENS_NFL: { name: "M&T Bank Stadium", lat: 39.278, lon: -76.6227, roofType: "outdoor" },
  CINCINNATI_BENGALS_NFL: { name: "Paycor Stadium", lat: 39.0955, lon: -84.516, roofType: "outdoor" },
  CLEVELAND_BROWNS_NFL: { name: "Huntington Bank Field", lat: 41.5061, lon: -81.6995, roofType: "outdoor" },
  PITTSBURGH_STEELERS_NFL: { name: "Acrisure Stadium", lat: 40.4468, lon: -80.0158, roofType: "outdoor" },

  // AFC South
  HOUSTON_TEXANS_NFL: { name: "NRG Stadium", lat: 29.6847, lon: -95.4107, roofType: "retractable" },
  INDIANAPOLIS_COLTS_NFL: { name: "Lucas Oil Stadium", lat: 39.7601, lon: -86.1639, roofType: "retractable" },
  JACKSONVILLE_JAGUARS_NFL: { name: "EverBank Stadium", lat: 30.3239, lon: -81.6373, roofType: "outdoor" },
  TENNESSEE_TITANS_NFL: { name: "Nissan Stadium", lat: 36.1665, lon: -86.7713, roofType: "outdoor" },

  // AFC West
  DENVER_BRONCOS_NFL: { name: "Empower Field at Mile High", lat: 39.7439, lon: -105.02, roofType: "outdoor" },
  KANSAS_CITY_CHIEFS_NFL: { name: "GEHA Field at Arrowhead Stadium", lat: 39.0489, lon: -94.4839, roofType: "outdoor" },
  LAS_VEGAS_RAIDERS_NFL: { name: "Allegiant Stadium", lat: 36.0909, lon: -115.1833, roofType: "dome" },
  LOS_ANGELES_CHARGERS_NFL: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, roofType: "retractable" },

  // NFC East
  DALLAS_COWBOYS_NFL: { name: "AT&T Stadium", lat: 32.7473, lon: -97.0945, roofType: "retractable" },
  NEW_YORK_GIANTS_NFL: { name: "MetLife Stadium", lat: 40.8135, lon: -74.0745, roofType: "outdoor" },
  PHILADELPHIA_EAGLES_NFL: { name: "Lincoln Financial Field", lat: 39.9008, lon: -75.1675, roofType: "outdoor" },
  WASHINGTON_COMMANDERS_NFL: { name: "Northwest Stadium", lat: 38.9077, lon: -76.8645, roofType: "outdoor" },

  // NFC North
  CHICAGO_BEARS_NFL: { name: "Soldier Field", lat: 41.8623, lon: -87.6167, roofType: "outdoor" },
  DETROIT_LIONS_NFL: { name: "Ford Field", lat: 42.34, lon: -83.0456, roofType: "dome" },
  GREEN_BAY_PACKERS_NFL: { name: "Lambeau Field", lat: 44.5013, lon: -88.0622, roofType: "outdoor" },
  MINNESOTA_VIKINGS_NFL: { name: "U.S. Bank Stadium", lat: 44.9738, lon: -93.2578, roofType: "dome" },

  // NFC South
  ATLANTA_FALCONS_NFL: { name: "Mercedes-Benz Stadium", lat: 33.7554, lon: -84.4008, roofType: "retractable" },
  CAROLINA_PANTHERS_NFL: { name: "Bank of America Stadium", lat: 35.2258, lon: -80.8528, roofType: "outdoor" },
  NEW_ORLEANS_SAINTS_NFL: { name: "Caesars Superdome", lat: 29.951, lon: -90.0812, roofType: "dome" },
  TAMPA_BAY_BUCCANEERS_NFL: { name: "Raymond James Stadium", lat: 27.9759, lon: -82.5033, roofType: "outdoor" },

  // NFC West
  ARIZONA_CARDINALS_NFL: { name: "State Farm Stadium", lat: 33.5276, lon: -112.2626, roofType: "retractable" },
  LOS_ANGELES_RAMS_NFL: { name: "SoFi Stadium", lat: 33.9535, lon: -118.3392, roofType: "retractable" },
  SAN_FRANCISCO_49ERS_NFL: { name: "Levi's Stadium", lat: 37.403, lon: -121.9698, roofType: "outdoor" },
  SEATTLE_SEAHAWKS_NFL: { name: "Lumen Field", lat: 47.5952, lon: -122.3316, roofType: "outdoor" },
};
