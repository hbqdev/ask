import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const lat = searchParams.get('lat')
  const lon = searchParams.get('lon')

  if (!lat || !lon) {
    return NextResponse.json({ error: 'lat and lon required' }, { status: 400 })
  }

  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.searchParams.set('latitude', lat)
    url.searchParams.set('longitude', lon)
    url.searchParams.set(
      'current',
      'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,weather_code,is_day,apparent_temperature,uv_index,precipitation_probability'
    )
    url.searchParams.set(
      'daily',
      'sunrise,sunset,uv_index_max,weather_code,temperature_2m_max,temperature_2m_min'
    )
    url.searchParams.set('hourly', 'temperature_2m,weather_code')
    url.searchParams.set('forecast_days', '6')
    url.searchParams.set('timezone', 'auto')

    const res = await fetch(url.toString(), { next: { revalidate: 300 } })
    if (!res.ok) throw new Error('Weather API failed')
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json(
      { error: 'Failed to fetch weather' },
      { status: 500 }
    )
  }
}
