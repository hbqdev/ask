'use client'

import { useCallback, useEffect, useState } from 'react'

export interface ForecastDay {
  date: string
  code: number
  tempMax: number
  tempMin: number
}

/** A user-picked location that overrides auto geolocation, persisted in
 * localStorage so the choice survives reloads. */
export interface ManualLocation {
  lat: number
  lon: number
  label: string
}

const MANUAL_LOCATION_KEY = 'ask:weather-location'

// Read + validate the persisted manual override. Guarded against SSR (no
// `window`) and malformed JSON so a bad value never throws during render.
function readStoredLocation(): ManualLocation | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(MANUAL_LOCATION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed.lat === 'number' &&
      typeof parsed.lon === 'number' &&
      typeof parsed.label === 'string'
    ) {
      return { lat: parsed.lat, lon: parsed.lon, label: parsed.label }
    }
  } catch {
    // ignore malformed storage
  }
  return null
}

export interface WeatherData {
  city: string
  temp: number
  feelsLike: number
  code: number
  humidity: number
  windSpeed: number
  windGusts: number
  uvIndex: number
  precipProbability: number
  isDay: boolean
  sunrise: string
  sunset: string
  hourlyTemps: number[]
  forecast: ForecastDay[]
}

/**
 * Shared weather fetch used by both the full home widget (`weather-widget.tsx`)
 * and the compact sidebar card (`sidebar-weather.tsx`). It resolves the user's
 * location via the browser Geolocation API — falling back to IP-based
 * `/api/geolocate` when permission is denied or unavailable — pulls Open-Meteo
 * data through `/api/weather`, and reverse-geocodes the city name via nominatim.
 *
 * A persisted manual override (localStorage `ask:weather-location`) takes
 * precedence over auto-detection: when set, its coords + label are used
 * directly and both geolocation and the IP fallback are skipped. The fetch is
 * reactive — `setManualLocation` / `clearManualLocation` update the widget live
 * without a page reload. Temperatures are always returned in Celsius; callers
 * convert to the user's preferred unit at display time.
 */
export function useWeather(): {
  weather: WeatherData | null
  loading: boolean
  isManual: boolean
  setManualLocation: (loc: ManualLocation) => void
  clearManualLocation: () => void
} {
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [loading, setLoading] = useState(true)
  // Seeded synchronously from localStorage so the first fetch effect already
  // knows whether to honour an override — avoids a flash of auto-detected
  // weather before the manual choice is applied.
  const [manual, setManual] = useState<ManualLocation | null>(
    readStoredLocation
  )

  useEffect(() => {
    // Guards against a stale in-flight fetch overwriting newer state when the
    // location changes (manual ↔ auto, or one place → another) mid-request.
    let cancelled = false
    setLoading(true)

    async function fetchWeather(
      lat: number,
      lon: number,
      cityOverride?: string
    ) {
      try {
        const weatherRes = await fetch(`/api/weather?lat=${lat}&lon=${lon}`)
        if (!weatherRes.ok) return
        const weatherJson = await weatherRes.json()
        const current = weatherJson.current
        const daily = weatherJson.daily
        const hourly = weatherJson.hourly

        // A manual pick already carries a resolved label — trust it and skip
        // the reverse-geocode round trip.
        let city = cityOverride ?? 'Your Location'
        if (!cityOverride) {
          try {
            const geoRes = await fetch(
              `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`,
              { headers: { 'Accept-Language': 'en' } }
            )
            const geoJson = await geoRes.json()
            city =
              geoJson.address?.city ||
              geoJson.address?.town ||
              geoJson.address?.village ||
              geoJson.address?.county ||
              'Your Location'
          } catch {
            // ignore reverse geocode errors
          }
        }

        const hourlyTimes: string[] = hourly?.time ?? []
        const hourlyTemperatures: number[] = hourly?.temperature_2m ?? []
        const hourlyCodes: number[] = hourly?.weather_code ?? []
        const nextHourIndex = hourlyTimes.findIndex(t => t >= current.time)
        const hourlyTemps =
          nextHourIndex >= 0
            ? hourlyTemperatures.slice(nextHourIndex, nextHourIndex + 8)
            : []

        const dailyTimes: string[] = daily?.time ?? []
        const dailyCodes: number[] = daily?.weather_code ?? []
        const dailyMax: number[] = daily?.temperature_2m_max ?? []
        const dailyMin: number[] = daily?.temperature_2m_min ?? []
        // Index 0 is today (already covered by `current`) — the forecast
        // row shows the next 5 days. The day's icon comes from the midday
        // (~noon) hourly condition rather than Open-Meteo's daily
        // `weather_code`, which reports the single most severe condition of
        // the whole day — a brief early-morning fog window would otherwise
        // make an overwhelmingly clear day show as "Fog".
        const forecast: ForecastDay[] = dailyTimes
          .slice(1, 6)
          .map((date, i) => {
            const middayIndex = hourlyTimes.indexOf(`${date}T12:00`)
            const code =
              middayIndex >= 0 ? hourlyCodes[middayIndex] : dailyCodes[i + 1]
            return {
              date,
              code,
              tempMax: dailyMax[i + 1],
              tempMin: dailyMin[i + 1]
            }
          })

        if (cancelled) return
        setWeather({
          city,
          temp: Math.round(current.temperature_2m),
          feelsLike: Math.round(current.apparent_temperature),
          code: current.weather_code,
          humidity: current.relative_humidity_2m,
          windSpeed: Math.round(current.wind_speed_10m),
          windGusts: Math.round(current.wind_gusts_10m),
          uvIndex: current.uv_index ?? 0,
          precipProbability: current.precipitation_probability ?? 0,
          isDay: current.is_day === 1,
          sunrise: daily?.sunrise?.[0] ?? '',
          sunset: daily?.sunset?.[0] ?? '',
          hourlyTemps,
          forecast
        })
      } catch {
        // silent fail
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    async function tryIpFallback() {
      try {
        const res = await fetch('/api/geolocate')
        const data = await res.json()
        if (data.latitude && data.longitude) {
          await fetchWeather(data.latitude, data.longitude)
        } else if (!cancelled) {
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }

    async function init() {
      // A manual override wins outright — use its coords + label and skip both
      // browser geolocation and the IP fallback.
      if (manual) {
        await fetchWeather(manual.lat, manual.lon, manual.label)
        return
      }

      if (!navigator.geolocation) {
        await tryIpFallback()
        return
      }

      navigator.geolocation.getCurrentPosition(
        pos => fetchWeather(pos.coords.latitude, pos.coords.longitude),
        async () => {
          // Permission denied — try IP fallback
          await tryIpFallback()
        },
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 }
      )
    }

    init()
    return () => {
      cancelled = true
    }
  }, [manual])

  // Persist + apply a manual override; the effect above re-runs on `manual`,
  // refetching for the new coords without a page reload.
  const setManualLocation = useCallback((loc: ManualLocation) => {
    try {
      window.localStorage.setItem(MANUAL_LOCATION_KEY, JSON.stringify(loc))
    } catch {
      // ignore storage write failures (e.g. private mode quota) — the
      // in-memory state below still drives a live update this session.
    }
    setManual(loc)
  }, [])

  // Drop the override and revert to auto-detect; the effect re-runs and
  // re-resolves via geolocation → IP fallback.
  const clearManualLocation = useCallback(() => {
    try {
      window.localStorage.removeItem(MANUAL_LOCATION_KEY)
    } catch {
      // ignore storage failures
    }
    setManual(null)
  }, [])

  return {
    weather,
    loading,
    isManual: manual !== null,
    setManualLocation,
    clearManualLocation
  }
}
