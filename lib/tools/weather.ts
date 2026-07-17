import { tool } from 'ai'
import { z } from 'zod'

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight showers',
  81: 'Moderate showers',
  82: 'Violent showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail'
}

export const weatherTool = tool({
  description:
    'Get current weather conditions and a 3-day forecast for any location. Use this for ANY weather query — current conditions, forecasts, temperature, rain probability, etc.',
  inputSchema: z.object({
    location: z
      .string()
      .describe('City name or location, e.g. "London", "New York", "Tokyo"')
  }),
  execute: async ({ location }) => {
    try {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
      )
      if (!geoRes.ok) throw new Error('Geocoding failed')
      const geoData = await geoRes.json()

      if (!geoData.results?.length) {
        return { error: `Location "${location}" not found`, success: false }
      }

      const { latitude, longitude, name, country, timezone } =
        geoData.results[0]

      const weatherRes = await fetch(
        `https://api.open-meteo.com/v1/forecast?` +
          `latitude=${latitude}&longitude=${longitude}` +
          `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m` +
          `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
          `&timezone=${encodeURIComponent(timezone)}&forecast_days=3`
      )
      if (!weatherRes.ok) throw new Error('Weather fetch failed')
      const w = await weatherRes.json()

      const cur = w.current
      const daily = w.daily

      const forecast = (daily.time as string[]).map(
        (date: string, i: number) => ({
          date,
          condition: WMO_CODES[daily.weather_code[i]] ?? 'Unknown',
          high: `${daily.temperature_2m_max[i]}°C`,
          low: `${daily.temperature_2m_min[i]}°C`,
          rain_chance: `${daily.precipitation_probability_max[i]}%`
        })
      )

      return {
        success: true,
        location: `${name}, ${country}`,
        current: {
          temperature: `${cur.temperature_2m}°C`,
          feels_like: `${cur.apparent_temperature}°C`,
          condition: WMO_CODES[cur.weather_code] ?? 'Unknown',
          wind: `${cur.wind_speed_10m} km/h`,
          humidity: `${cur.relative_humidity_2m}%`
        },
        forecast
      }
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : 'Weather unavailable',
        success: false
      }
    }
  }
})
