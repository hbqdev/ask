import { NextResponse } from 'next/server'

// Server-side proxy for IP-based geolocation. Calling ipapi.co directly from
// the browser gets blocked by tracking-prevention / ad-blockers in some
// browsers (it's on common third-party-tracker blocklists) even though it's
// just a location lookup, so we fetch it here instead — a same-origin call
// the browser has no reason to block.
function getClientIp(request: Request): string | null {
  const headers = request.headers
  const cf = headers.get('cf-connecting-ip')
  if (cf) return cf.trim()
  const xff = headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xReal = headers.get('x-real-ip')
  if (xReal) return xReal.trim()
  return null
}

function isPublicIp(ip: string | null): boolean {
  if (!ip) return false
  // IPv4 private / loopback / link-local ranges
  if (
    ip.startsWith('10.') ||
    ip.startsWith('127.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  ) {
    return false
  }
  // IPv6 loopback / unique-local / link-local ranges
  const lower = ip.toLowerCase()
  if (
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:')
  ) {
    return false
  }
  return true
}

export async function GET(request: Request) {
  try {
    const clientIp = getClientIp(request)
    const lookupUrl = isPublicIp(clientIp)
      ? `https://ipapi.co/${clientIp}/json/`
      : 'https://ipapi.co/json/'
    const res = await fetch(lookupUrl, {
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
