import { NextResponse } from 'next/server'

// Reject anything that isn't a routable public IP so we never hand ipapi.co a
// LAN address (which would just fail or return garbage). Covers IPv4 loopback /
// private / link-local ranges and their IPv6 equivalents (loopback, unique
// local fc00::/7, link-local fe80::/10).
function isPublicIp(ip: string): boolean {
  if (!ip) return false
  const addr = ip.toLowerCase()

  // IPv4 private / loopback / link-local
  if (
    addr.startsWith('10.') ||
    addr.startsWith('127.') ||
    addr.startsWith('169.254.') ||
    addr.startsWith('192.168.')
  ) {
    return false
  }
  // IPv4 172.16.0.0 – 172.31.255.255
  const match172 = addr.match(/^172\.(\d{1,3})\./)
  if (match172) {
    const second = Number(match172[1])
    if (second >= 16 && second <= 31) return false
  }

  // IPv6 loopback / unique-local (fc00::/7 → fc/fd) / link-local (fe80::/10)
  if (
    addr === '::1' ||
    addr.startsWith('fc') ||
    addr.startsWith('fd') ||
    addr.startsWith('fe80:')
  ) {
    return false
  }

  return true
}

// Pull the real visitor IP from the proxy headers, most-trustworthy first.
// Prod sits behind Cloudflare, so `cf-connecting-ip` is authoritative there;
// `x-forwarded-for` may chain several hops, and the client is the first one.
function clientIp(request: Request): string | null {
  const headers = request.headers

  const cf = headers.get('cf-connecting-ip')
  if (cf && isPublicIp(cf.trim())) return cf.trim()

  const xff = headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first && isPublicIp(first)) return first
  }

  const real = headers.get('x-real-ip')
  if (real && isPublicIp(real.trim())) return real.trim()

  return null
}

// Server-side proxy for IP-based geolocation. Calling ipapi.co directly from
// the browser gets blocked by tracking-prevention / ad-blockers in some
// browsers (it's on common third-party-tracker blocklists) even though it's
// just a location lookup, so we fetch it here instead — a same-origin call
// the browser has no reason to block.
//
// When we can recover the visitor's real public IP from the proxy headers we
// geolocate THAT (so the fallback reflects the user, not the server's egress);
// otherwise — e.g. a LAN client with a private IP — we fall back to the
// server-side lookup, preserving the original behaviour.
export async function GET(request: Request) {
  try {
    const ip = clientIp(request)
    const url = ip
      ? `https://ipapi.co/${ip}/json/`
      : 'https://ipapi.co/json/'
    const res = await fetch(url, {
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
