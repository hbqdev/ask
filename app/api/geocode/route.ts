import { NextResponse } from 'next/server'

// Server-side forward-geocoding proxy. Mirrors `/api/geolocate`: hitting a
// third-party geo service straight from the browser gets blocked by
// tracking-prevention / ad-blockers in some browsers, so we proxy it here as a
// same-origin call. Nominatim resolves both free-text city names AND postal
// codes globally, which powers the weather widget's manual location search.

interface GeocodeResult {
  label: string
  lat: number
  lon: number
}

// Only the address parts we build a readable label from — Nominatim returns
// many more, all optional depending on the matched place.
interface NominatimAddress {
  city?: string
  town?: string
  village?: string
  municipality?: string
  hamlet?: string
  suburb?: string
  county?: string
  state?: string
  region?: string
  province?: string
  state_district?: string
  country?: string
}

interface NominatimItem {
  lat?: string
  lon?: string
  name?: string
  display_name?: string
  address?: NominatimAddress
}

// Build a readable, disambiguating name from address parts: the most specific
// place (city/town/village/…) plus its region/state and country. Falls back to
// the first few comma-separated parts of `display_name` when no structured
// place name is available (e.g. some bare postal-code hits).
function buildLabel(item: NominatimItem): string {
  const a = item.address ?? {}
  const primary =
    a.city ||
    a.town ||
    a.village ||
    a.municipality ||
    a.hamlet ||
    a.suburb ||
    a.county ||
    item.name ||
    ''
  const region = a.state || a.region || a.province || a.state_district || ''
  const country = a.country || ''
  const parts = [primary, region, country].filter(Boolean)
  if (parts.length > 0) return parts.join(', ')

  return String(item.display_name ?? '')
    .split(',')
    .slice(0, 3)
    .map(part => part.trim())
    .filter(Boolean)
    .join(', ')
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim() ?? ''
  if (!q) return NextResponse.json({ results: [] })

  try {
    const url =
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
      `&format=jsonv2&addressdetails=1&limit=5`
    const res = await fetch(url, {
      // Nominatim requires a descriptive User-Agent; Accept-Language keeps
      // labels in English to match the reverse-geocode in `use-weather`.
      headers: {
        'User-Agent': 'ask-selfhosted/1.0',
        'Accept-Language': 'en'
      },
      next: { revalidate: 86400 }
    })
    if (!res.ok) throw new Error('Geocode lookup failed')

    const data: unknown = await res.json()
    const items: NominatimItem[] = Array.isArray(data) ? data : []

    const seen = new Set<string>()
    const results: GeocodeResult[] = []
    for (const item of items) {
      const lat = Number(item.lat)
      const lon = Number(item.lon)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      const label = buildLabel(item)
      if (!label) continue
      const key = label.toLowerCase()
      if (seen.has(key)) continue // dedupe near-identical labels
      seen.add(key)
      results.push({ label, lat, lon })
    }

    return NextResponse.json({ results })
  } catch {
    // Never 500 the widget — an empty list degrades gracefully.
    return NextResponse.json({ results: [] })
  }
}
