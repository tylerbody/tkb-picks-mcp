import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WeatherClient } from "../services/weatherClient.js";
import { MLB_STADIUMS, type StadiumInfo } from "../data/mlbStadiums.js";
import { NFL_STADIUMS } from "../data/nflStadiums.js";
import { CFB_STADIUMS } from "../data/cfbStadiums.js";
import { normalizeTeamKey } from "../data/cfbTiers.js";
import { SUPPORTED_SPORTS, supportsCapability, unsupportedMessage, type SportKey } from "../constants.js";

const WeatherInputSchema = z
  .object({
    sport: z
      .enum(SUPPORTED_SPORTS as [SportKey, ...SportKey[]])
      .default("mlb")
      .describe("Which sport. Weather is only meaningful for mlb, nfl, and cfb - wnba is indoors."),
    teamID: z
      .string()
      .optional()
      .describe(
        "SGO teamID of the HOME team (weather applies to the home stadium), e.g. 'PHILADELPHIA_PHILLIES_MLB' or 'BUFFALO_BILLS_NFL'. Required for mlb and nfl."
      ),
    homeTeamName: z
      .string()
      .optional()
      .describe(
        "CFB only: the home team's display name as returned by tkb_get_schedule, e.g. 'Ohio State'. Used instead of teamID because the NCAAF feed spans hundreds of programs."
      ),
  })
  .strict();

type WeatherInput = z.infer<typeof WeatherInputSchema>;

/**
 * Notable-weather thresholds. Deliberately conservative - mild conditions should
 * stay out of threads entirely per standing style rules.
 *
 * FOOTBALL USES A LOWER WIND BAR THAN BASEBALL. Wind is the single most actionable
 * weather variable in football: it degrades deep passing, field-goal range, and
 * punting, and is the most common driver of a total moving down. Sustained wind in
 * the mid-teens is already meaningful for a passing prop, whereas the same wind in
 * baseball is mostly noise unless it is blowing out in a specific park.
 */
function isNotable(
  sport: SportKey,
  windSpeedMph: number,
  precipProbability: number,
  tempF: number
): boolean {
  const isFootball = sport === "nfl" || sport === "cfb";
  const windBar = isFootball ? 15 : 12;
  const coldBar = isFootball ? 32 : 40;
  return windSpeedMph >= windBar || precipProbability >= 40 || tempF >= 95 || tempF <= coldBar;
}

function parseWindSpeedMph(windSpeed: string): number {
  const numbers = windSpeed.match(/\d+/g);
  if (!numbers || !numbers.length) return 0;
  return Math.max(...numbers.map(Number));
}

/** Football-specific read of what the conditions actually mean for markets. */
function footballImpact(windMph: number, precipProb: number, tempF: number): string[] {
  const notes: string[] = [];
  if (windMph >= 20) {
    notes.push(
      "Wind at 20+ mph is a significant factor: deep passing volume typically drops, field goals beyond roughly 45 yards get shaky, and this is the classic profile for a total going under."
    );
  } else if (windMph >= 15) {
    notes.push(
      "Wind in the 15-20 mph band is worth noting for passing yardage and kicking props, though it is not usually enough on its own to move a game script."
    );
  }
  if (precipProb >= 60) {
    notes.push(
      "High precipitation chance favours run-heavy game scripts and raises fumble/ball-security risk, which tends to suppress passing props and totals."
    );
  } else if (precipProb >= 40) {
    notes.push("Moderate rain risk - worth a mention but not decisive by itself.");
  }
  if (tempF <= 20) {
    notes.push("Severe cold affects grip, kicking distance, and typically compresses scoring.");
  } else if (tempF <= 32) {
    notes.push("Freezing conditions modestly favour the run game and under.");
  }
  if (tempF >= 95) {
    notes.push("Extreme heat can affect conditioning and rotation depth, especially early season.");
  }
  return notes;
}

function lookupStadium(params: WeatherInput): { stadium?: StadiumInfo; error?: string } {
  // CHECK CAPABILITY FIRST. The CFB branch at the bottom of this function is a
  // FALLTHROUGH - it handles "any sport that is not wnba/mlb/nfl" - so without
  // this a tennis lookup would ask for homeTeamName and then search CFB_STADIUMS
  // for a player's surname. It would have returned "no stadium on file", which is
  // technically true and completely unhelpful about why.
  if (!supportsCapability(params.sport, "weather")) {
    return { error: unsupportedMessage(params.sport, "weather") };
  }

  if (params.sport === "wnba") {
    return {
      error:
        "WNBA games are played indoors - weather is never a factor and should not appear in a WNBA thread.",
    };
  }

  if (params.sport === "mlb") {
    if (!params.teamID) return { error: "teamID is required for MLB weather lookups." };
    const stadium = MLB_STADIUMS[params.teamID];
    if (!stadium) {
      return {
        error: `No MLB stadium found for teamID "${params.teamID}". Confirm this is a valid MLB HOME teamID (format: 'PHILADELPHIA_PHILLIES_MLB').`,
      };
    }
    return { stadium };
  }

  if (params.sport === "nfl") {
    if (!params.teamID) return { error: "teamID is required for NFL weather lookups." };
    const stadium = NFL_STADIUMS[params.teamID];
    if (!stadium) {
      return {
        error:
          `No NFL stadium found for teamID "${params.teamID}". Confirm this is a valid NFL HOME teamID (format: 'BUFFALO_BILLS_NFL'). ` +
          `Note that international games (London, Munich, Mexico City) are not in this table and are outside weather.gov's US-only coverage.`,
      };
    }
    return { stadium };
  }

  // CFB - name-keyed, partial coverage by design
  const name = params.homeTeamName;
  if (!name) {
    return {
      error:
        "homeTeamName is required for CFB weather lookups (pass the home team's display name from tkb_get_schedule).",
    };
  }
  const stadium = CFB_STADIUMS[normalizeTeamKey(name)];
  if (!stadium) {
    return {
      error:
        `No stadium on file for CFB team "${name}". Coverage is intentionally limited to Power 4 programs, Notre Dame, and regularly-televised Group of 5 teams - ` +
        `the NCAAF feed spans hundreds of schools including Division II, and guessing a location would be worse than returning nothing.\n\n` +
        `If this game matters, check conditions via live web search instead. If it is a program you post regularly, it is worth adding to src/data/cfbStadiums.ts.`,
    };
  }
  return { stadium };
}

export function registerWeatherTool(server: McpServer, weather: WeatherClient) {
  server.registerTool(
    "tkb_get_game_weather",
    {
      title: "Get Game Weather (MLB / NFL / CFB)",
      description: `Get the weather forecast for a game's stadium, but ONLY if weather is actually
a relevant factor. Returns a clear "not a factor" result for domed stadiums, and
flags retractable-roof stadiums as needing a live-search check for roof status
(this tool cannot know whether the roof is open or closed).

Intentionally conservative: mild/ordinary conditions return isNotable: false and
should NOT be mentioned in threads. Only use weather in reasoning when this tool
returns isNotable: true.

SPORT COVERAGE:
  - mlb: keyed by home teamID, all 30 clubs
  - nfl: keyed by home teamID, all 32 clubs. Wind threshold is lower than MLB
    because wind drives passing/kicking markets far more directly.
  - cfb: keyed by home team NAME (pass homeTeamName). Power 4 + Notre Dame +
    regularly-televised Group of 5. Anything else returns "unavailable" rather
    than a guess.
  - wnba: always returns "indoors, not a factor"

SoFi STADIUM CAVEAT: SoFi (Rams/Chargers) has a fixed canopy with open sides. Rain
does not reach the field but wind and temperature do. It is classified retractable
so this tool forces a judgement call rather than silently returning either extreme.

Args:
  - sport ('mlb'|'nfl'|'cfb'|'wnba')
  - teamID: HOME team's SGO teamID (mlb/nfl)
  - homeTeamName: HOME team's display name (cfb)

Returns:
  - Dome: { relevant: false, reason: "dome" }
  - Retractable: { relevant: "unconfirmed", reason: "retractable_roof" }
  - Outdoor: real forecast (temp, wind, precip chance, description), isNotable flag,
    and for football a plain-language read of what the conditions mean for markets

Error Handling:
  - Clear message when the stadium isn't in the reference table for that sport
  - weather.gov is US-only; international games will not resolve`,
      inputSchema: WeatherInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params: WeatherInput) => {
      try {
        const { stadium, error } = lookupStadium(params);

        if (error || !stadium) {
          return {
            content: [{ type: "text" as const, text: error ?? "Stadium lookup failed." }],
          };
        }

        if (stadium.roofType === "dome") {
          const output = { relevant: false, reason: "dome", stadiumName: stadium.name };
          return {
            content: [
              {
                type: "text" as const,
                text: `${stadium.name} is a fixed dome - weather is never a factor here.\n\n${JSON.stringify(output, null, 2)}`,
              },
            ],
            structuredContent: output,
          };
        }

        if (stadium.roofType === "retractable") {
          const isSoFi = stadium.name === "SoFi Stadium";
          const output = {
            relevant: "unconfirmed",
            reason: isSoFi ? "fixed_canopy_open_sides" : "retractable_roof",
            stadiumName: stadium.name,
            note: isSoFi
              ? "SoFi Stadium has a FIXED translucent canopy with OPEN SIDES. Rain does not reach the field, but wind and temperature do. Do not treat this as a dome and do not use a plain outdoor forecast - if wind matters to the pick, verify conditions via live search."
              : "This stadium has a retractable roof. Roof status (open/closed) is a same-day team decision not knowable from this API - verify via live search before using weather in this thread. If closed, weather is not a factor.",
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `${stadium.name}: roof status must be confirmed via live search before using weather in this thread.\n\n${JSON.stringify(output, null, 2)}`,
              },
            ],
            structuredContent: output,
          };
        }

        const periods = await weather.getForecast(stadium.lat, stadium.lon);
        const period = periods[0];

        if (!period) {
          return {
            content: [
              {
                type: "text" as const,
                text: `weather.gov returned no forecast periods for ${stadium.name}.`,
              },
            ],
          };
        }

        const windMph = parseWindSpeedMph(period.windSpeed);
        // BUG FIX (found via live test): probabilityOfPrecipitation is an object
        // { unitCode, value }, not a plain number - must extract .value.
        const precipProb = period.probabilityOfPrecipitation?.value ?? 0;
        const notable = isNotable(params.sport, windMph, precipProb, period.temperature);
        const impact =
          params.sport === "nfl" || params.sport === "cfb"
            ? footballImpact(windMph, precipProb, period.temperature)
            : [];

        const output = {
          relevant: true,
          sport: params.sport,
          stadiumName: stadium.name,
          periodName: period.name,
          temperature: period.temperature,
          temperatureUnit: period.temperatureUnit,
          windSpeed: period.windSpeed,
          windSpeedMph: windMph,
          windDirection: period.windDirection,
          shortForecast: period.shortForecast,
          precipitationChance: precipProb,
          isNotable: notable,
          ...(impact.length ? { marketImpact: impact } : {}),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `${stadium.name}: ${period.shortForecast}, ${period.temperature}°${period.temperatureUnit}, wind ${period.windSpeed} ${period.windDirection}${notable ? " - NOTABLE, worth mentioning in thread" : " - ordinary conditions, do not mention in thread"}\n\n${JSON.stringify(output, null, 2)}`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching weather: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
