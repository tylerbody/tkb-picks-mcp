import axios, { type AxiosInstance } from "axios";

/**
 * National Weather Service (weather.gov) API client.
 *
 * NO API KEY REQUIRED - this is a free, public US government API. Authentication
 * is just a User-Agent header identifying the app (not a secret), so it's safe
 * to hardcode here rather than needing a Render environment variable.
 *
 * Two-step lookup, per NWS's own docs:
 *   1. GET /points/{lat},{lon} -> returns a forecast URL for that exact location
 *   2. GET that forecast URL -> returns actual forecast periods (temp, wind, etc.)
 *
 * US-only. Forecasts are predictions, not confirmed conditions - most useful for
 * pre-game reasoning (wind direction/speed, rain risk), less precise the further
 * out from game time the check is made.
 */

const USER_AGENT = "TKBPicksConnector (contact: tkb-picks-mcp-server)";

export interface WeatherPeriod {
  name: string;
  startTime: string;
  temperature: number;
  temperatureUnit: string;
  windSpeed: string;
  windDirection: string;
  shortForecast: string;
  probabilityOfPrecipitation?: number | null;
}

export class WeatherClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: "https://api.weather.gov",
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
      timeout: 15000,
    });
  }

  async getForecast(lat: number, lon: number): Promise<WeatherPeriod[]> {
    const pointsResponse = await this.http.get(`/points/${lat},${lon}`);
    const forecastUrl: string | undefined = pointsResponse.data?.properties?.forecast;

    if (!forecastUrl) {
      throw new Error(
        `weather.gov did not return a forecast URL for coordinates ${lat},${lon}. This location may be outside NWS coverage (US-only).`
      );
    }

    const forecastResponse = await axios.get(forecastUrl, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/geo+json" },
      timeout: 15000,
    });

    const periods = forecastResponse.data?.properties?.periods;
    if (!Array.isArray(periods)) {
      throw new Error("weather.gov returned an unexpected forecast response shape.");
    }

    return periods;
  }
}
