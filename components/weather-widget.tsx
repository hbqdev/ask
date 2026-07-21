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

type WeatherScene =
  | 'clear-day'
  | 'clear-night'
  | 'clouds'
  | 'fog'
  | 'rain'
  | 'snow'
  | 'storm'

// Collapse the ~25 WMO codes into the handful of visual moods the ambient
// layer animates. Clear splits on day/night; drizzle/rain/showers all read as
// "rain"; the 45/48 fog pair gets its own drifting-mist look.
function sceneForWeather(code: number, isDay: boolean): WeatherScene {
  if (code === 0 || code === 1) return isDay ? 'clear-day' : 'clear-night'
  if (code === 2 || code === 3) return 'clouds'
  if (code === 45 || code === 48) return 'fog'
  if (code === 71 || code === 73 || code === 75) return 'snow'
  if (code === 95 || code === 96 || code === 99) return 'storm'
  if ((code >= 51 && code <= 65) || (code >= 80 && code <= 82)) return 'rain'
  return 'clouds'
}

interface AmbientParticle {
  key: number
  left?: string
  top?: string
  size?: string
  width?: string
  height?: string
  duration: number
  delay: number
}

// Kept out of render — React purity forbids Math.random during render, so the
// component calls this from an effect after mount and stores the result.
function buildAmbientParticles(scene: WeatherScene): AmbientParticle[] {
  const rand = (min: number, max: number) => min + Math.random() * (max - min)

  if (scene === 'rain' || scene === 'storm') {
    return Array.from({ length: 16 }, (_, i) => ({
      key: i,
      left: `${rand(0, 100)}%`,
      height: `${rand(10, 20)}px`,
      duration: rand(0.6, 1.1),
      delay: rand(0, 1.4)
    }))
  }
  if (scene === 'snow') {
    return Array.from({ length: 14 }, (_, i) => {
      const s = rand(3, 6)
      return {
        key: i,
        left: `${rand(0, 100)}%`,
        size: `${s}px`,
        duration: rand(3.5, 6.5),
        delay: rand(0, 5)
      }
    })
  }
  if (scene === 'clear-night') {
    return Array.from({ length: 14 }, (_, i) => {
      const s = rand(1.5, 2.8)
      return {
        key: i,
        left: `${rand(2, 98)}%`,
        top: `${rand(4, 72)}%`,
        size: `${s}px`,
        duration: rand(2, 4.5),
        delay: rand(0, 3)
      }
    })
  }
  if (scene === 'clouds' || scene === 'fog') {
    return Array.from({ length: 3 }, (_, i) => ({
      key: i,
      top: `${rand(6, 46)}%`,
      width: `${rand(70, 130)}px`,
      height: `${rand(24, 40)}px`,
      duration: rand(26, 46),
      delay: -rand(0, 30)
    }))
  }
  return []
}

// Decorative, condition-aware motion behind the readout. Particles are built
// once per scene in an effect (so Math.random never runs during render and
// nothing renders during SSR). Purely visual: pointer-events-none, aria-hidden,
// and hidden entirely under prefers-reduced-motion (see globals.css).
function WeatherAmbient({ scene }: { scene: WeatherScene }) {
  const [particles, setParticles] = useState<AmbientParticle[]>([])

  useEffect(() => {
    setParticles(buildAmbientParticles(scene))
  }, [scene])

  return (
    <div
      className="weather-ambient pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {scene === 'clear-day' && (
        <>
          <div
            className="absolute -left-8 -top-8 size-36 rounded-full"
            style={{
              background:
                'radial-gradient(circle, rgba(251,191,36,0.5), rgba(251,191,36,0) 70%)',
              animation:
                'weather-sun-pulse 5s var(--motion-ease-in-out) infinite'
            }}
          />
          <div
            className="absolute -left-8 -top-8 size-36 opacity-40"
            style={{
              background:
                'repeating-conic-gradient(from 0deg at 50% 50%, rgba(251,191,36,0.3) 0deg 6deg, transparent 6deg 26deg)',
              maskImage: 'radial-gradient(circle, #000 28%, transparent 62%)',
              WebkitMaskImage:
                'radial-gradient(circle, #000 28%, transparent 62%)',
              animation: 'weather-sun-rays 44s linear infinite'
            }}
          />
        </>
      )}

      {scene === 'clear-night' &&
        particles.map(p => (
          <span
            key={p.key}
            className="absolute rounded-full bg-slate-400/70 dark:bg-white"
            style={{
              left: p.left,
              top: p.top,
              width: p.size,
              height: p.size,
              animation: `weather-twinkle ${p.duration}s var(--motion-ease-in-out) ${p.delay}s infinite`
            }}
          />
        ))}

      {(scene === 'clouds' || scene === 'fog') &&
        particles.map(p => (
          <span
            key={p.key}
            className={cn(
              'absolute rounded-full bg-slate-400/15 dark:bg-white/10',
              scene === 'fog' ? 'blur-md' : 'blur-xl'
            )}
            style={{
              top: p.top,
              left: scene === 'fog' ? '-25%' : undefined,
              width: scene === 'fog' ? '150%' : p.width,
              height: p.height,
              animation:
                scene === 'fog'
                  ? `weather-fog ${p.duration / 2}s var(--motion-ease-in-out) ${p.delay}s infinite`
                  : `weather-cloud ${p.duration}s linear ${p.delay}s infinite`
            }}
          />
        ))}

      {(scene === 'rain' || scene === 'storm') &&
        particles.map(p => (
          <span
            key={p.key}
            className="absolute top-[-12%] w-[2px] rounded-full bg-gradient-to-b from-transparent via-sky-400/50 to-transparent dark:via-sky-300/50"
            style={{
              left: p.left,
              height: p.height,
              animation: `weather-rain ${p.duration}s linear ${p.delay}s infinite`
            }}
          />
        ))}

      {scene === 'snow' &&
        particles.map(p => (
          <span
            key={p.key}
            className="absolute top-[-8%] rounded-full bg-slate-400/50 dark:bg-white/70"
            style={{
              left: p.left,
              width: p.size,
              height: p.size,
              animation: `weather-snow ${p.duration}s linear ${p.delay}s infinite`
            }}
          />
        ))}

      {scene === 'storm' && (
        <div
          className="absolute inset-0 bg-white"
          style={{
            animation: 'weather-flash 7s var(--motion-ease-out) infinite'
          }}
        />
      )}
    </div>
  )
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
  const scene = sceneForWeather(weather.code, weather.isDay)
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
        'weather-motion relative overflow-hidden rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm select-none w-full h-64',
        className
      )}
      style={{ animation: 'weather-enter 420ms var(--motion-ease-out) both' }}
    >
      <WeatherAmbient scene={scene} />
      <div className="relative z-10 flex h-full flex-col justify-between gap-2 px-4 py-3">
        <div className="flex flex-row items-center gap-4">
          <div className="flex flex-col items-center gap-1 shrink-0">
            <span
              className="text-4xl leading-none"
              style={{
                animation:
                  'weather-icon-bob 4s var(--motion-ease-in-out) infinite'
              }}
            >
              {icon}
            </span>
            <span className="text-xl font-semibold leading-none whitespace-nowrap">
              {heroTemp.primary}°{heroTemp.primaryUnit} / {heroTemp.secondary}°
              {heroTemp.secondaryUnit}
            </span>
          </div>
          <div className="flex flex-col gap-0.5 min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{weather.city}</div>
            <div className="text-xs text-muted-foreground">
              {condition.label}
            </div>
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
                pathLength={1}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{
                  strokeDasharray: 1,
                  animation:
                    'weather-sparkline-draw 900ms var(--motion-ease-out) both'
                }}
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
          {showPrecip && (
            <span>🌧️ {Math.round(weather.precipProbability)}%</span>
          )}
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
                  className="flex flex-col items-center gap-1 text-center"
                >
                  <span className="text-[10px] text-muted-foreground">
                    {getWeekdayLabel(day.date)}
                  </span>
                  <span className="flex items-center justify-center size-9 rounded-full bg-gradient-to-b from-muted/70 to-muted/30 text-2xl leading-none drop-shadow-sm">
                    {dayCondition.icon}
                  </span>
                  <span className="text-[11px] font-medium leading-none whitespace-nowrap mt-0.5">
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
    </div>
  )
}
