import type { StadiumInfo } from "./mlbStadiums.js";

/**
 * College football stadium coordinates, keyed by NORMALIZED team name rather than
 * SGO teamID.
 *
 * WHY NAME-KEYED AND NOT teamID-KEYED (unlike MLB/NFL): CFB has 130+ FBS programs
 * plus hundreds of lower-division teams that appear in SGO's NCAAF feed. Hardcoding
 * every teamID is a maintenance trap and most of those games will never be posted.
 * SGO returns team display names on the event; normalizing those to a key covers the
 * programs actually worth posting without needing an exhaustive ID table.
 *
 * COVERAGE IS DELIBERATELY PARTIAL: Power 4 (SEC, Big Ten, Big 12, ACC), Notre Dame,
 * and the Group of 5 programs that regularly appear in ranked or nationally televised
 * windows. Anything not in this table returns "weather unavailable, verify manually"
 * rather than a wrong guess. That is the correct failure mode - a missing forecast is
 * recoverable, a forecast for the wrong stadium is not.
 *
 * Use normalizeTeamKey() from cfbTiers.ts to build the lookup key from an SGO name.
 */
export const CFB_STADIUMS: Record<string, StadiumInfo> = {
  // SEC
  alabama: { name: "Bryant-Denny Stadium", lat: 33.2083, lon: -87.5504, roofType: "outdoor" },
  arkansas: { name: "Donald W. Reynolds Razorback Stadium", lat: 36.0679, lon: -94.1786, roofType: "outdoor" },
  auburn: { name: "Jordan-Hare Stadium", lat: 32.6023, lon: -85.4894, roofType: "outdoor" },
  florida: { name: "Ben Hill Griffin Stadium", lat: 29.6499, lon: -82.3486, roofType: "outdoor" },
  georgia: { name: "Sanford Stadium", lat: 33.9498, lon: -83.3733, roofType: "outdoor" },
  kentucky: { name: "Kroger Field", lat: 38.0221, lon: -84.5053, roofType: "outdoor" },
  lsu: { name: "Tiger Stadium", lat: 30.4118, lon: -91.1836, roofType: "outdoor" },
  "mississippi state": { name: "Davis Wade Stadium", lat: 33.4560, lon: -88.7940, roofType: "outdoor" },
  missouri: { name: "Faurot Field", lat: 38.9359, lon: -92.3334, roofType: "outdoor" },
  "ole miss": { name: "Vaught-Hemingway Stadium", lat: 34.3619, lon: -89.5334, roofType: "outdoor" },
  oklahoma: { name: "Gaylord Family Oklahoma Memorial Stadium", lat: 35.2058, lon: -97.4422, roofType: "outdoor" },
  "south carolina": { name: "Williams-Brice Stadium", lat: 33.9731, lon: -81.0186, roofType: "outdoor" },
  tennessee: { name: "Neyland Stadium", lat: 35.955, lon: -83.9250, roofType: "outdoor" },
  texas: { name: "Darrell K Royal-Texas Memorial Stadium", lat: 30.2837, lon: -97.7325, roofType: "outdoor" },
  "texas a&m": { name: "Kyle Field", lat: 30.61, lon: -96.3401, roofType: "outdoor" },
  vanderbilt: { name: "FirstBank Stadium", lat: 36.1442, lon: -86.8087, roofType: "outdoor" },

  // Big Ten
  illinois: { name: "Memorial Stadium", lat: 40.0995, lon: -88.2361, roofType: "outdoor" },
  indiana: { name: "Memorial Stadium", lat: 39.1806, lon: -86.5258, roofType: "outdoor" },
  iowa: { name: "Kinnick Stadium", lat: 41.6588, lon: -91.5514, roofType: "outdoor" },
  maryland: { name: "SECU Stadium", lat: 38.9908, lon: -76.9472, roofType: "outdoor" },
  michigan: { name: "Michigan Stadium", lat: 42.2658, lon: -83.7487, roofType: "outdoor" },
  "michigan state": { name: "Spartan Stadium", lat: 42.7280, lon: -84.4847, roofType: "outdoor" },
  minnesota: { name: "Huntington Bank Stadium", lat: 44.9765, lon: -93.2249, roofType: "outdoor" },
  nebraska: { name: "Memorial Stadium", lat: 40.8206, lon: -96.7057, roofType: "outdoor" },
  northwestern: { name: "Ryan Field", lat: 42.0658, lon: -87.6929, roofType: "outdoor" },
  "ohio state": { name: "Ohio Stadium", lat: 40.0017, lon: -83.0197, roofType: "outdoor" },
  oregon: { name: "Autzen Stadium", lat: 44.0583, lon: -123.0681, roofType: "outdoor" },
  "penn state": { name: "Beaver Stadium", lat: 40.8122, lon: -77.8560, roofType: "outdoor" },
  purdue: { name: "Ross-Ade Stadium", lat: 40.4348, lon: -86.9186, roofType: "outdoor" },
  rutgers: { name: "SHI Stadium", lat: 40.5137, lon: -74.4650, roofType: "outdoor" },
  ucla: { name: "Rose Bowl", lat: 34.1613, lon: -118.1676, roofType: "outdoor" },
  usc: { name: "Los Angeles Memorial Coliseum", lat: 34.0141, lon: -118.2879, roofType: "outdoor" },
  washington: { name: "Husky Stadium", lat: 47.6503, lon: -122.3016, roofType: "outdoor" },
  wisconsin: { name: "Camp Randall Stadium", lat: 43.07, lon: -89.4126, roofType: "outdoor" },

  // Big 12
  "arizona state": { name: "Mountain America Stadium", lat: 33.4264, lon: -111.9327, roofType: "outdoor" },
  arizona: { name: "Arizona Stadium", lat: 32.2287, lon: -110.9489, roofType: "outdoor" },
  baylor: { name: "McLane Stadium", lat: 31.5589, lon: -97.1150, roofType: "outdoor" },
  byu: { name: "LaVell Edwards Stadium", lat: 40.2574, lon: -111.6545, roofType: "outdoor" },
  cincinnati: { name: "Nippert Stadium", lat: 39.1315, lon: -84.5164, roofType: "outdoor" },
  colorado: { name: "Folsom Field", lat: 40.0096, lon: -105.2669, roofType: "outdoor" },
  houston: { name: "TDECU Stadium", lat: 29.7215, lon: -95.3494, roofType: "outdoor" },
  "iowa state": { name: "Jack Trice Stadium", lat: 42.0140, lon: -93.6358, roofType: "outdoor" },
  kansas: { name: "David Booth Kansas Memorial Stadium", lat: 38.9633, lon: -95.2464, roofType: "outdoor" },
  "kansas state": { name: "Bill Snyder Family Stadium", lat: 39.2019, lon: -96.5942, roofType: "outdoor" },
  "oklahoma state": { name: "Boone Pickens Stadium", lat: 36.1269, lon: -97.0653, roofType: "outdoor" },
  tcu: { name: "Amon G. Carter Stadium", lat: 32.7098, lon: -97.3684, roofType: "outdoor" },
  "texas tech": { name: "Jones AT&T Stadium", lat: 33.5906, lon: -101.8726, roofType: "outdoor" },
  ucf: { name: "FBC Mortgage Stadium", lat: 28.6076, lon: -81.1924, roofType: "outdoor" },
  utah: { name: "Rice-Eccles Stadium", lat: 40.7600, lon: -111.8488, roofType: "outdoor" },
  "west virginia": { name: "Milan Puskar Stadium", lat: 39.6494, lon: -79.9548, roofType: "outdoor" },

  // ACC
  "boston college": { name: "Alumni Stadium", lat: 42.3352, lon: -71.1664, roofType: "outdoor" },
  california: { name: "California Memorial Stadium", lat: 37.8715, lon: -122.2508, roofType: "outdoor" },
  clemson: { name: "Memorial Stadium", lat: 34.6787, lon: -82.8434, roofType: "outdoor" },
  duke: { name: "Wallace Wade Stadium", lat: 36.0009, lon: -78.9425, roofType: "outdoor" },
  "florida state": { name: "Doak Campbell Stadium", lat: 30.4382, lon: -84.3045, roofType: "outdoor" },
  "georgia tech": { name: "Bobby Dodd Stadium", lat: 33.7725, lon: -84.3928, roofType: "outdoor" },
  louisville: { name: "L&N Federal Credit Union Stadium", lat: 38.2064, lon: -85.7585, roofType: "outdoor" },
  miami: { name: "Hard Rock Stadium", lat: 25.958, lon: -80.2389, roofType: "outdoor" },
  "nc state": { name: "Carter-Finley Stadium", lat: 35.8003, lon: -78.7197, roofType: "outdoor" },
  "north carolina": { name: "Kenan Memorial Stadium", lat: 35.9070, lon: -79.0477, roofType: "outdoor" },
  pittsburgh: { name: "Acrisure Stadium", lat: 40.4468, lon: -80.0158, roofType: "outdoor" },
  smu: { name: "Gerald J. Ford Stadium", lat: 32.8365, lon: -96.7825, roofType: "outdoor" },
  stanford: { name: "Stanford Stadium", lat: 37.4347, lon: -122.1611, roofType: "outdoor" },
  syracuse: { name: "JMA Wireless Dome", lat: 43.0362, lon: -76.1364, roofType: "dome" },
  virginia: { name: "Scott Stadium", lat: 38.0313, lon: -78.5133, roofType: "outdoor" },
  "virginia tech": { name: "Lane Stadium", lat: 37.2199, lon: -80.4184, roofType: "outdoor" },
  "wake forest": { name: "Allegacy Federal Credit Union Stadium", lat: 36.1327, lon: -80.2540, roofType: "outdoor" },

  // Independent / notable Group of 5
  "notre dame": { name: "Notre Dame Stadium", lat: 41.6983, lon: -86.2338, roofType: "outdoor" },
  "boise state": { name: "Albertsons Stadium", lat: 43.6027, lon: -116.1959, roofType: "outdoor" },
  memphis: { name: "Simmons Bank Liberty Stadium", lat: 35.1211, lon: -89.9930, roofType: "outdoor" },
  tulane: { name: "Yulman Stadium", lat: 29.9439, lon: -90.1178, roofType: "outdoor" },
  unlv: { name: "Allegiant Stadium", lat: 36.0909, lon: -115.1833, roofType: "dome" },
  "app state": { name: "Kidd Brewer Stadium", lat: 36.2113, lon: -81.6858, roofType: "outdoor" },
  liberty: { name: "Williams Stadium", lat: 37.3540, lon: -79.1780, roofType: "outdoor" },
  navy: { name: "Navy-Marine Corps Memorial Stadium", lat: 38.9856, lon: -76.5083, roofType: "outdoor" },
  army: { name: "Michie Stadium", lat: 41.3891, lon: -73.9631, roofType: "outdoor" },
  "san jose state": { name: "CEFCU Stadium", lat: 37.3195, lon: -121.8687, roofType: "outdoor" },
  hawaii: { name: "Clarence T.C. Ching Complex", lat: 21.2969, lon: -157.8171, roofType: "outdoor" },
  "eastern michigan": { name: "Rynearson Stadium", lat: 42.2426, lon: -83.6293, roofType: "outdoor" },
};
