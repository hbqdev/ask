'use client'

import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

const WMO_CONDITIONS: Record<number, { label: string; icon: string }> = {
  0: { label: 'Clear', icon: '☀️' },
  1: { label: 'Mainly Clear', icon: '🌤️' },
  2: { label: 'Partly Cloudy', icon: '⛅' },
  3: { label: 'Overcast', icon: '☁️' },
  45: { label: 'Fog', icon: '🌫️' },
  48: { label: 'Icy Fog', icon: '🌫️' },
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

interface WeatherData {
  city: string
  temp: number
  code: number
  humidity: number
  windSpeed: number
  isDay: boolean
}

export function WeatherWidget({ className }: { className?: string }) {
  const [weather, setWeather] = useState<WeatherData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchWeather(lat: number, lon: number) {
      try {
        const weatherRes = await fetch(`/api/weather?lat=${lat}&lon=${lon}`)
        if (!weatherRes.ok) return
        const weatherJson = await weatherRes.json()
        const current = weatherJson.current

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

        setWeather({
          city,
          temp: Math.round(current.temperature_2m),
          code: current.weather_code,
          humidity: current.relative_humidity_2m,
          windSpeed: Math.round(current.wind_speed_10m),
          isDay: current.is_day === 1
        })
      } catch {
        // silent fail
      } finally {
        setLoading(false)
      }
    }

    async function tryIpFallback() {
      try {
        const res = await fetch('https://ipapi.co/json/')
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
      <div className={cn('rounded-2xl bg-muted/50 animate-pulse w-full h-24', className)} />
    )
  }

  if (!weather) return null

  const condition = WMO_CONDITIONS[weather.code] ?? { label: 'Unknown', icon: '🌡️' }

  return (
    <div
      className={cn(
        'rounded-2xl border border-border/50 bg-card/80 backdrop-blur-sm px-4 py-3 select-none w-full h-24 flex flex-row items-center gap-4',
        className
      )}
    >
      <div className="flex flex-col items-center gap-1 shrink-0">
        <span className="text-3xl leading-none">{condition.icon}</span>
        <span className="text-lg font-semibold leading-none">{weather.temp}°C</span>
      </div>
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="text-sm font-medium truncate">{weather.city}</div>
        <div className="text-xs text-muted-foreground">{condition.label}</div>
        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
          <span>💨 {weather.windSpeed} km/h</span>
          <span>💧 {weather.humidity}%</span>
        </div>
      </div>
    </div>
  )
}
