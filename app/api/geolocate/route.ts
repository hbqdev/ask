import { NextResponse } from 'next/server'

// Server-side proxy for IP-based geolocation. Calling ipapi.co directly from
// the browser gets blocked by tracking-prevention / ad-blockers in some
// browsers (it's on common third-party-tracker blocklists) even though it's
// just a location lookup, so we fetch it here instead — a same-origin call
// the browser has no reason to block.
export async function GET() {
  try {
    const res = await fetch('https://ipapi.co/json/', {
      headers: { 'User-Agent': 'ask-selfhosted/1.0' },
      next: { revalidate: 3600 }
    })
    if (!res.ok) throw new Error('Geolocation lookup failed')
    const data = await res.json()
    return NextResponse.json({
      latitude: data.latitude,
      longitude: data.longitude,
      city: data.city
    })
  } catch {
    return NextResponse.json({ error: 'Failed to geolocate' }, { status: 500 })
  }
}
