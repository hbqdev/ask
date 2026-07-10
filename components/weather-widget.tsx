'use client'

import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

import { useClientSettingValue } from '@/hooks/use-client-setting'

const WMO_CONDITIONS: Record<number, { label: string; icon: string }> = {
  0: { label: 'Clear', icon: '☀️' },
  1: { label: 'Mainly Clear', icon: '🌤️' },
  2: { label: 'Partly Cloudy', icon: '⛅' },
  3: { label: 'Overcast', icon: '☁️' },
  45: { label: 'Fog', icon: '🌁' },
  48: { label: 'Icy Fog', icon: '🌁' },
  51: { label: 'Drizzle', icon: '🌦️' },
  53: { label: 'Drizzle', icon: '🌦️' },
  55: { label: 'Heavy Drizzle', icon: '🌧️' },
  61: { label: 'Rain', icon: '🌧️' },
  63: { label: 'Rain', icon: '🌧️' },
  65: { label: 'Heavy Rain', icon: '🌧️' },
  71: { label: 'Snow', icon: '🌨️' },
  73: { label: 'Snow', icon: '🌨️' },
  75: { label: 'Heavy Snow', icon: '❄️' },
  80: { label: 'Showers', icon: '🌦️' },
  81: { label: 'Showers', icon: '🌦️' },
  82: { label: 'Heavy Showers', icon: '🌧️' },
  95: { label: 'Thunderstorm', icon: '⛈️' },
  96: { label: 'Thunderstorm', icon: '⛈️' },
  99: { label: 'Thunderstorm', icon: '⛈️' }
}

// Only clear/cloudy codes have a meaningfully different night look — the
// rest (fog, rain, snow, storms) read the same regardless of time of day.
const NIGHT_ICON_OVERRIDES: Record<number, string> = {
  0: '🌙',
  1: '🌙',
  2: '☁️'
}

const UV_BANDS = [
  { max: 2, label: 'Low', color: 'text-emerald-500' },
  { max: 5, label: 'Moderate', color: 'text-amber-500' },
  { max: 7, label: 'High', color: 'text-orange-500' },
  { max: 10, label: 'Very High', color: 'text-red-500' },
  { max: Infinity, label: 'Extreme', color: 'text-violet-500' }
]

function getUvBand(uvIndex: number) {
  return (
    UV_BANDS.find(band => uvIndex <= band.max) ?? UV_BANDS[UV_BANDS.length - 1]
  )
}

function celsiusToFahrenheit(c: number) {
  return Math.round((c * 9) / 5 + 32)
}

function kmhToMph(kmh: number) {
  return Math.round(kmh * 0.621371)
}

function formatClockTime(isoTime: string) {
  const date = new Date(isoTime)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

// Primary/secondary pair for showing a temperature in both units at once.
// "Primary" follows the Measurement Unit setting; the other unit tags along
// smaller/muted so both are always visible.
function formatDualTemp(celsius: number, isImperial: boolean) {
  const c = Math.round(celsius)
  const f = celsiusToFahrenheit(celsius)
  return isImperial
    ? { primary: f, primaryUnit: 'F', secondary: c, secondaryUnit: 'C' }
    : { primary: c, primaryUnit: 'C', secondary: f, secondaryUnit: 'F' }
}

// Date.UTC + timeZone: 'UTC' avoids a plain `new Date(dateStr)` parse
// landing on the wrong calendar day once the browser's local timezone
// offset is applied to a date-only "YYYY-MM-DD" string.
function getWeekdayLabel(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return ''
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC'
  })
}

function buildSparklinePoints(temps: number[], width: number, height: number) {
  if (temps.length < 2) return ''
  const min = Math.min(...temps)
  const max = Math.max(...temps)
  const range = max - min || 1
  const stepX = width / (temps.length - 1)
  return temps
    .map((t, i) => {
      const x = i * stepX
      const y = height - ((t - min) / range) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

interface ForecastDay {
  date: string
  code: number
  tempMax: number
  tempMin: number
}

interface WeatherData {
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

export function WeatherWidget({ className }: { className?: string }) {
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [loading, setLoading] = useState(true)
  const measureUnit = useClientSettingValue('measureUnit', 'metric')
  const isImperial = measureUnit === 'imperial'

  useEffect(() => {
    async function fetchWeather(lat: number, lon: number) {
      try {
        const weatherRes = await fetch(`/api/weather?lat=${lat}&lon=${lon}`)
        if (!weatherRes.ok) return
        const weatherJson = await weatherRes.json()
        const current = weatherJson.current
        const daily = weatherJson.daily
        const hourly = weatherJson.hourly

        let city = 'Your Location'
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
        setLoading(false)
      }
    }

    async function tryIpFallback() {
      try {
        const res = await fetch('/api/geolocate')
        const data = await res.json()
        if (data.latitude && data.longitude) {
          await fetchWeather(data.latitude, data.longitude)
        } else {
          setLoading(false)
        }
      } catch {
        setLoading(false)
      }
    }

    async function init() {
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
        { timeout: 5000 }
      )
    }

    init()
  }, [])

  if (loading) {
    return (
      <div
        className={cn(
          'rounded-2xl bg-muted/50 animate-pulse w-full h-64',
          className
        )}
      />
    )
  }

  if (!weather) return null

  const condition = WMO_CONDITIONS[weather.code] ?? {
    label: 'Unknown',
    icon: '🌡️'
  }
  const icon =
    !weather.isDay && NIGHT_ICON_OVERRIDES[weather.code]
      ? NIGHT_ICON_OVERRIDES[weather.code]
      : condition.icon
  const uvBand = getUvBand(weather.uvIndex)
  const showGusts = weather.windGusts - weather.windSpeed >= 10
  const showPrecip = weather.precipProbability > 0

  const heroTemp = formatDualTemp(weather.temp, isImperial)
  const feelsLikeTemp = formatDualTemp(weather.feelsLike, isImperial)
  const displayWindSpeed = isImperial
    ? kmhToMph(weather.windSpeed)
    : weather.windSpeed
  const displayWindGusts = isImperial
    ? kmhToMph(weather.windGusts)
    : weather.windGusts
  const speedUnit = isImperial ? 'mph' : 'km/h'

  const sparklinePoints =
    weather.hourlyTemps.length >= 2
      ? buildSparklinePoints(
          isImperial
            ? weather.hourlyTemps.map(celsiusToFahrenheit)
            : weather.hourlyTemps,
          80,
          28
        )
      : ''

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm px-4 py-3 select-none w-full h-64 flex flex-col justify-between gap-2',
        className
      )}
    >
      <div className="flex flex-row items-center gap-4">
        <div className="flex flex-col items-center gap-1 shrink-0">
          <span className="text-4xl leading-none">{icon}</span>
          <span className="text-xl font-semibold leading-none whitespace-nowrap">
            {heroTemp.primary}°{heroTemp.primaryUnit} / {heroTemp.secondary}°
            {heroTemp.secondaryUnit}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{weather.city}</div>
          <div className="text-xs text-muted-foreground">{condition.label}</div>
        </div>
        {sparklinePoints && (
          <svg
            width="80"
            height="28"
            viewBox="0 0 80 28"
            className="shrink-0 text-muted-foreground/70"
          >
            <polyline
              points={sparklinePoints}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          🌡️ Feels like {feelsLikeTemp.primary}°{feelsLikeTemp.primaryUnit} ·{' '}
          {feelsLikeTemp.secondary}°{feelsLikeTemp.secondaryUnit}
        </span>
        <span>💧 {weather.humidity}%</span>
        <span>
          💨 {displayWindSpeed} {speedUnit}
          {showGusts && `, gusts ${displayWindGusts}`}
        </span>
        <span className={uvBand.color}>
          ☀️ UV {weather.uvIndex.toFixed(0)} {uvBand.label}
        </span>
        {showPrecip && <span>🌧️ {Math.round(weather.precipProbability)}%</span>}
      </div>

      {(weather.sunrise || weather.sunset) && (
        <div className="text-[11px] text-muted-foreground/80">
          {weather.sunrise && `🌅 ${formatClockTime(weather.sunrise)}`}
          {weather.sunrise && weather.sunset && '  '}
          {weather.sunset && `🌇 ${formatClockTime(weather.sunset)}`}
        </div>
      )}

      {weather.forecast.length > 0 && (
        <div className="grid grid-cols-5 gap-1 border-t border-border/50 pt-2">
          {weather.forecast.map(day => {
            const dayCondition = WMO_CONDITIONS[day.code] ?? {
              label: 'Unknown',
              icon: '🌡️'
            }
            const high = formatDualTemp(day.tempMax, isImperial)
            const low = formatDualTemp(day.tempMin, isImperial)
            return (
              <div
                key={day.date}
                className="flex flex-col items-center gap-0.5 text-center"
              >
                <span className="text-[10px] text-muted-foreground">
                  {getWeekdayLabel(day.date)}
                </span>
                <span className="text-base leading-none">
                  {dayCondition.icon}
                </span>
                <span className="text-[11px] font-medium leading-none whitespace-nowrap">
                  {high.primary}/{low.primary}°{high.primaryUnit}
                </span>
                <span className="text-[11px] font-medium leading-none mt-1 whitespace-nowrap">
                  {high.secondary}/{low.secondary}°{high.secondaryUnit}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
