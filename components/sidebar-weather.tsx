'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  IconCloud,
  IconCloudFog,
  IconCloudRain,
  IconCloudSnow,
  IconCloudStorm,
  IconCurrentLocation,
  IconDroplet,
  IconLoader2,
  IconMapPin,
  IconMoon,
  IconSearch,
  IconSun,
  IconSunrise,
  IconSunset,
  IconTemperature,
  IconWind,
  IconX,
  type TablerIcon
} from '@tabler/icons-react'

import { cn } from '@/lib/utils'

import { useClientSettingValue } from '@/hooks/use-client-setting'
import { type ManualLocation, useWeather } from '@/hooks/use-weather'

interface GeocodeResult {
  label: string
  lat: number
  lon: number
}

const WMO_LABELS: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly Clear',
  2: 'Partly Cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Icy Fog',
  51: 'Drizzle',
  53: 'Drizzle',
  55: 'Heavy Drizzle',
  61: 'Rain',
  63: 'Rain',
  65: 'Heavy Rain',
  71: 'Snow',
  73: 'Snow',
  75: 'Heavy Snow',
  80: 'Showers',
  81: 'Showers',
  82: 'Heavy Showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm'
}

// Collapse the ~25 WMO codes into the handful of visual moods the sidebar
// draws, mirroring the full widget's `sceneForWeather` buckets but mapping each
// to a Tabler line icon + an accent colour instead of an emoji. Clear splits on
// day/night (sun vs. moon); drizzle/rain/showers all read as "rain"; 45/48 fog
// gets its own icon. Icon colours are condition-semantic (a sun is amber) and
// are intentionally fixed rather than token-driven — only the card chrome
// (text/borders) follows the theme retint.
function iconForCode(
  code: number,
  isDay: boolean
): { Icon: TablerIcon; colorClass: string } {
  if (code === 0 || code === 1) {
    return isDay
      ? { Icon: IconSun, colorClass: 'text-amber-400' }
      : { Icon: IconMoon, colorClass: 'text-indigo-300' }
  }
  if (code === 45 || code === 48) {
    return { Icon: IconCloudFog, colorClass: 'text-slate-400' }
  }
  if (code === 71 || code === 73 || code === 75) {
    return { Icon: IconCloudSnow, colorClass: 'text-sky-200' }
  }
  if (code === 95 || code === 96 || code === 99) {
    return { Icon: IconCloudStorm, colorClass: 'text-violet-400' }
  }
  if ((code >= 51 && code <= 65) || (code >= 80 && code <= 82)) {
    return { Icon: IconCloudRain, colorClass: 'text-sky-400' }
  }
  // 2, 3 and anything unmapped read as cloud.
  return { Icon: IconCloud, colorClass: 'text-slate-400' }
}

function celsiusToFahrenheit(c: number) {
  return Math.round((c * 9) / 5 + 32)
}

function kmhToMph(kmh: number) {
  return Math.round(kmh * 0.621371)
}

// Local-time clock label for an ISO instant (sunrise/sunset). Mirrors the full
// widget's helper; returns '' for an unparseable value so the caller can fall
// back rather than render "Invalid Date".
function formatClockTime(isoTime: string) {
  const date = new Date(isoTime)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

// Northern-hemisphere view of each canonical phase, indexed 0 (new) → 7.
const MOON_PHASES = [
  { name: 'New Moon', glyph: '🌑' },
  { name: 'Waxing Crescent', glyph: '🌒' },
  { name: 'First Quarter', glyph: '🌓' },
  { name: 'Waxing Gibbous', glyph: '🌔' },
  { name: 'Full Moon', glyph: '🌕' },
  { name: 'Waning Gibbous', glyph: '🌖' },
  { name: 'Last Quarter', glyph: '🌗' },
  { name: 'Waning Crescent', glyph: '🌘' }
]

// No weather API surfaces the moon phase, so derive it locally. Standard synodic
// age calc: measure days since a known new moon (2000-01-06 18:14 UTC), take that
// modulo the mean synodic month (29.53 days), then snap the fractional age to one
// of the eight canonical phases (the +0.5 centres each bucket on its named phase).
function getMoonPhase(date: Date): { name: string; glyph: string } {
  const SYNODIC_MONTH = 29.53058867
  const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14, 0)
  const days = (date.getTime() - KNOWN_NEW_MOON) / 86_400_000
  const age = ((days % SYNODIC_MONTH) + SYNODIC_MONTH) % SYNODIC_MONTH
  const index = Math.floor((age / SYNODIC_MONTH) * 8 + 0.5) % 8
  return MOON_PHASES[index]
}

// One compact icon + value pair for the detail grid. `icon` is a Tabler glyph or
// the moon emoji; `title` gives the (icon-only) label an accessible name.
function StatCell({
  icon,
  value,
  title
}: {
  icon: React.ReactNode
  value: string
  title: string
}) {
  return (
    <div className="flex min-w-0 items-center gap-1" title={title}>
      <span className="flex size-3.5 shrink-0 items-center justify-center text-[13px] leading-none text-muted-foreground">
        {icon}
      </span>
      <span className="truncate text-[11px] text-foreground tabular-nums">
        {value}
      </span>
    </div>
  )
}

// Date.UTC + timeZone: 'UTC' avoids a plain `new Date(dateStr)` parse landing
// on the wrong calendar day once the browser's local timezone offset is applied
// to a date-only "YYYY-MM-DD" string.
function getWeekdayLabel(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return ''
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    timeZone: 'UTC'
  })
}

/**
 * Inline location search shown in place of the readout while the card is
 * expanded. Queries `/api/geocode` (debounced ~400ms, also on Enter), lists up
 * to 5 matches as buttons, and picks one via `onPick`. Escape / the close
 * button collapse back to the compact card; "Use my location" reverts to
 * auto-detect. Self-contained: owns its query/results/loading state and
 * cancels stale requests with an AbortController.
 */
function LocationSearchPanel({
  isManual,
  onPick,
  onClose,
  onUseMyLocation
}: {
  isManual: boolean
  onPick: (loc: ManualLocation) => void
  onClose: () => void
  onUseMyLocation: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GeocodeResult[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const runSearch = useCallback(async (q: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setSearching(true)
    setError(false)
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        signal: controller.signal
      })
      if (!res.ok) throw new Error('Geocode request failed')
      const data = await res.json()
      setResults(Array.isArray(data.results) ? data.results : [])
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError(true)
      setResults([])
    } finally {
      // Only the newest request clears the spinner — an aborted one leaves it
      // to its successor.
      if (abortRef.current === controller) setSearching(false)
    }
  }, [])

  // Debounce typing; queries shorter than 2 chars reset the list rather than
  // hammering the endpoint.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      abortRef.current?.abort()
      setResults([])
      setSearching(false)
      setError(false)
      return
    }
    const timer = setTimeout(() => void runSearch(q), 400)
    return () => clearTimeout(timer)
  }, [query, runSearch])

  // Abort any in-flight request on unmount.
  useEffect(() => () => abortRef.current?.abort(), [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const q = query.trim()
      if (q.length >= 1) void runSearch(q)
    }
  }

  const trimmed = query.trim()

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <IconSearch
          className="size-3.5 shrink-0 text-muted-foreground"
          stroke={1.8}
          aria-hidden="true"
        />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          aria-label="Search for a city or postal code"
          placeholder="City or postal code"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close location search"
          className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconX className="size-3.5" stroke={1.8} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2 min-h-[1.25rem]" aria-live="polite">
        {searching ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <IconLoader2
              className="size-3.5 animate-spin"
              stroke={1.8}
              aria-hidden="true"
            />
            Searching…
          </div>
        ) : error ? (
          <div className="text-[11px] text-muted-foreground">
            Couldn&apos;t search. Try again.
          </div>
        ) : trimmed.length >= 2 && results.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">No matches</div>
        ) : results.length > 0 ? (
          <ul className="-mx-1 flex flex-col">
            {results.map(result => (
              <li key={`${result.lat},${result.lon}`}>
                <button
                  type="button"
                  onClick={() => onPick(result)}
                  className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11.5px] text-foreground transition-colors hover:bg-muted/60"
                >
                  <IconMapPin
                    className="size-3.5 shrink-0 text-muted-foreground"
                    stroke={1.8}
                    aria-hidden="true"
                  />
                  <span className="truncate">{result.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-[11px] text-muted-foreground">
            Type a place to search
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onUseMyLocation}
        className="mt-2 flex items-center gap-1 border-t border-border/50 pt-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <IconCurrentLocation
          className="size-3.5 shrink-0"
          stroke={1.8}
          aria-hidden="true"
        />
        {isManual ? 'Use my location' : 'Use my current location'}
      </button>
    </div>
  )
}

/**
 * Compact weather card sized for the 16rem app sidebar (~232px content width).
 * Reuses the shared `useWeather` data layer and the `measureUnit` client
 * setting, and renders the same rail card shown in the home mockup: city +
 * condition with a small icon, a large current temperature, and a slim 5-day
 * forecast (high stacked over a dimmer low). Hidden by the sidebar wiring when
 * the rail collapses to its icon-only state.
 */
export function SidebarWeather({ className }: { className?: string }) {
  const { weather, loading, isManual, setManualLocation, clearManualLocation } =
    useWeather()
  const measureUnit = useClientSettingValue('measureUnit', 'metric')
  const isImperial = measureUnit === 'imperial'
  const toTemp = (celsius: number) =>
    isImperial ? celsiusToFahrenheit(celsius) : Math.round(celsius)

  const [searchOpen, setSearchOpen] = useState(false)

  const handlePick = (result: GeocodeResult) => {
    setManualLocation({
      lat: result.lat,
      lon: result.lon,
      label: result.label
    })
    setSearchOpen(false)
  }

  const handleUseMyLocation = () => {
    clearManualLocation()
    setSearchOpen(false)
  }

  const cardClass = cn(
    'rounded-2xl border border-border/50 bg-card/60 px-3 py-3 backdrop-blur-sm select-none',
    className
  )

  // The search takes over the card while open — it can appear from the normal
  // readout or the "unavailable" fallback, so short-circuit before either.
  if (searchOpen) {
    return (
      <div className={cardClass}>
        <LocationSearchPanel
          isManual={isManual}
          onPick={handlePick}
          onClose={() => setSearchOpen(false)}
          onUseMyLocation={handleUseMyLocation}
        />
      </div>
    )
  }

  if (loading) {
    return (
      <div className={cardClass} aria-hidden="true">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-3/4 animate-pulse rounded bg-muted/60" />
            <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted/40" />
          </div>
          <div className="size-7 shrink-0 animate-pulse rounded-full bg-muted/50" />
        </div>
        <div className="mt-2 h-7 w-16 animate-pulse rounded bg-muted/60" />
        <div className="mt-3 grid grid-cols-5 gap-1 border-t border-border/50 pt-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-1.5">
              <div className="h-2 w-6 animate-pulse rounded bg-muted/40" />
              <div className="size-4 animate-pulse rounded-full bg-muted/50" />
              <div className="h-4 w-5 animate-pulse rounded bg-muted/40" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!weather) {
    return (
      <div className={cardClass}>
        <div className="text-[12.5px] font-semibold text-foreground">
          Weather
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          Currently unavailable
        </div>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <IconSearch className="size-3.5" stroke={1.8} aria-hidden="true" />
          Set a location
        </button>
      </div>
    )
  }

  const label = WMO_LABELS[weather.code] ?? 'Unknown'
  const { Icon: CurrentIcon, colorClass: currentColor } = iconForCode(
    weather.code,
    weather.isDay
  )

  // Current temp shows BOTH units on one line: the primary (large) unit follows
  // the `measureUnit` setting, the other trails it smaller + muted. Reuses the
  // same Celsius base + `celsiusToFahrenheit` conversion the forecast uses.
  const celsius = Math.round(weather.temp)
  const fahrenheit = celsiusToFahrenheit(weather.temp)
  const primaryTemp = isImperial ? `${fahrenheit}°F` : `${celsius}°C`
  const secondaryTemp = isImperial ? `${celsius}°C` : `${fahrenheit}°F`

  // Wind is stored in km/h; convert to mph when the imperial unit is selected
  // (temps handled separately via `toTemp`).
  const windValue = isImperial ? kmhToMph(weather.windSpeed) : weather.windSpeed
  const windUnit = isImperial ? 'mph' : 'km/h'
  const sunriseTime = formatClockTime(weather.sunrise)
  const sunsetTime = formatClockTime(weather.sunset)
  const moon = getMoonPhase(new Date())

  return (
    <div className={cardClass}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label="Change weather location"
              title="Change location"
              className="flex min-w-0 items-center gap-1 text-[12.5px] font-semibold text-foreground transition-colors hover:text-foreground/70"
            >
              <span className="truncate">{weather.city}</span>
              <IconSearch
                className="size-3 shrink-0 text-muted-foreground"
                stroke={1.8}
                aria-hidden="true"
              />
            </button>
            {isManual && (
              <button
                type="button"
                onClick={handleUseMyLocation}
                aria-label="Use my location"
                title="Use my location"
                className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <IconCurrentLocation
                  className="size-3.5"
                  stroke={1.8}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">
            {label}
          </div>
        </div>
        <CurrentIcon
          className={cn('size-7 shrink-0', currentColor)}
          stroke={1.6}
          aria-hidden="true"
        />
      </div>

      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="font-serif text-[34px] leading-none text-foreground tabular-nums">
          {primaryTemp}
        </span>
        <span className="text-[13px] leading-none text-muted-foreground tabular-nums">
          · {secondaryTemp}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-border/50 pt-3">
        <StatCell
          title="Feels like"
          icon={<IconTemperature className="size-3.5" stroke={1.8} />}
          value={`${toTemp(weather.feelsLike)}°`}
        />
        <StatCell
          title="Humidity"
          icon={<IconDroplet className="size-3.5" stroke={1.8} />}
          value={`${Math.round(weather.humidity)}%`}
        />
        <StatCell
          title="Wind"
          icon={<IconWind className="size-3.5" stroke={1.8} />}
          value={`${windValue} ${windUnit}`}
        />
        <StatCell
          title={`Moon · ${moon.name}`}
          icon={<span aria-hidden="true">{moon.glyph}</span>}
          value={moon.name}
        />
        <StatCell
          title="Sunrise"
          icon={<IconSunrise className="size-3.5" stroke={1.8} />}
          value={sunriseTime || '—'}
        />
        <StatCell
          title="Sunset"
          icon={<IconSunset className="size-3.5" stroke={1.8} />}
          value={sunsetTime || '—'}
        />
      </div>

      {weather.forecast.length > 0 && (
        <div className="mt-3 grid grid-cols-5 gap-1 border-t border-border/50 pt-3">
          {weather.forecast.map(day => {
            const { Icon: DayIcon, colorClass: dayColor } = iconForCode(
              day.code,
              true
            )
            return (
              <div key={day.date} className="min-w-0 text-center">
                <div className="font-mono text-[9.5px] tracking-wide text-muted-foreground uppercase">
                  {getWeekdayLabel(day.date)}
                </div>
                <DayIcon
                  className={cn('mx-auto my-1 size-[17px]', dayColor)}
                  stroke={1.6}
                  aria-hidden="true"
                />
                <div className="text-[11px] leading-tight text-foreground/85 tabular-nums">
                  {toTemp(day.tempMax)}°
                  <span className="block text-muted-foreground">
                    {toTemp(day.tempMin)}°
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
