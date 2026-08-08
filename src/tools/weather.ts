import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WeatherClient } from "../services/weatherClient.js";
import { MLB_STADIUMS } from "../data/mlbStadiums.js";

const WeatherInputSchema = z
  .object({
    teamID: z
      .string()
      .describe(
        "SGO teamID of the HOME team for this game (weather applies to the home stadium), e.g. 'PHILADELPHIA_PHILLIES_MLB'."
      ),
  })
  .strict();

type WeatherInput = z.infer<typeof WeatherInputSchema>;

/**
 * Notable-weather thresholds - used to decide whether weather is even worth
 * surfacing in a thread. Mild/ordinary conditions should stay silent per
 * standing style rules (weather only gets mentioned when it's a real factor).
 */
function isNotable(windSpeedMph: number, precipProbability: number, tempF: number): boolean {
  return windSpeedMph >= 12 || precipProbability >= 40 || tempF >= 95 || tempF <= 40;
}

function parseWindSpeedMph(windSpeed: string): number {
  // windSpeed comes as strings like "10 mph" or "10 to 15 mph" - take the higher number
  const numbers = windSpeed.match(/\d+/g);
  if (!numbers || !numbers.length) return 0;
  return Math.max(...numbers.map(Number));
}

export function registerWeatherTool(server: McpServer, weather: WeatherClient) {
  server.registerTool(
    "tkb_get_game_weather",
    {
      title: "Get Game Weather (MLB)",
      description: `Get the weather forecast for an MLB game's stadium, but ONLY if weather is
actually a relevant factor. Returns a clear "not a factor" result for domed
stadiums, and flags retractable-roof stadiums as needing a live-search check
for roof status (this tool cannot know if the roof is open or closed).

This tool is intentionally conservative about what counts as "notable" -
mild/ordinary conditions return isNotable: false and should NOT be mentioned
in threads. Only use weather in a thread's reasoning when this tool returns
isNotable: true.

Args:
  - teamID: the HOME team's SGO teamID (weather is always for the home stadium)

Returns:
  - For dome stadiums: { relevant: false, reason: "dome" }
  - For retractable-roof stadiums: { relevant: "unconfirmed", reason: "retractable_roof",
    note: "Verify roof status via live search before using weather in this thread" }
  - For outdoor stadiums: real forecast data (temp, wind speed/direction, precip
    chance, short description) plus isNotable (true/false)

Examples:
  - Use when: building any MLB thread's opener, to check if weather deserves a mention
  - Don't use when: the stadium is already known to be a dome (skip the call entirely)
  - Don't use when: you need weather for any sport other than MLB (not yet supported)

Error Handling:
  - Returns a clear message if the teamID isn't found in the stadium reference table
  - Returns a clear message if weather.gov's API is unreachable or returns an
    unexpected shape (US-only coverage - this will fail for non-US locations,
    though that shouldn't occur for MLB)`,
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
        const stadium = MLB_STADIUMS[params.teamID];

        if (!stadium) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No stadium found for teamID "${params.teamID}". Confirm this is a valid MLB home teamID.`,
              },
            ],
            isError: true,
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
          const output = {
            relevant: "unconfirmed",
            reason: "retractable_roof",
            stadiumName: stadium.name,
            note: "This stadium has a retractable roof. Roof status (open/closed) is a same-day team decision not knowable from this API - verify via live search before using weather in this thread. If closed, weather is not a factor.",
          };
          return {
            content: [
              {
                type: "text" as const,
                text: `${stadium.name} has a retractable roof - status must be confirmed via live search before using weather in this thread.\n\n${JSON.stringify(output, null, 2)}`,
              },
            ],
            structuredContent: output,
          };
        }

        // Outdoor stadium - actually check the forecast
        const periods = await weather.getForecast(stadium.lat, stadium.lon);
        const period = periods[0]; // nearest upcoming period

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
        // BUG FIX (found via live test): precipitationChance is an object
        // { unitCode, value }, not a plain number - must extract .value.
        const precipProb = period.probabilityOfPrecipitation?.value ?? 0;
        const notable = isNotable(windMph, precipProb, period.temperature);

        const output = {
          relevant: true,
          stadiumName: stadium.name,
          periodName: period.name,
          temperature: period.temperature,
          temperatureUnit: period.temperatureUnit,
          windSpeed: period.windSpeed,
          windDirection: period.windDirection,
          shortForecast: period.shortForecast,
          precipitationChance: precipProb,
          isNotable: notable,
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
