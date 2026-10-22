import { type NextRequest, NextResponse } from 'next/server'

import {
  allowedAppOrigins,
  appCorsHeaders,
  isCorsPreflight
} from '@/lib/http/app-cors'
import { hasSupabasePublicConfig } from '@/lib/supabase/keys'
import { updateSession } from '@/lib/supabase/middleware'

export async function proxy(request: NextRequest) {
  // Get the protocol from X-Forwarded-Proto header or request protocol
  const protocol =
    request.headers.get('x-forwarded-proto') || request.nextUrl.protocol

  // Get the host from X-Forwarded-Host header or request host
  const host =
    request.headers.get('x-forwarded-host') || request.headers.get('host') || ''

  // Construct the base URL - ensure protocol has :// format
  const baseUrl = `${protocol}${protocol.endsWith(':') ? '//' : '://'}${host}`

  // CORS for the mobile app origin on /api/*. Preflights are answered here,
  // before the Supabase session refresh, and never reach a route handler.
  const isApi = request.nextUrl.pathname.startsWith('/api/')
  const origin = request.headers.get('origin')
  if (isApi && isCorsPreflight(request.method, request.headers)) {
    return new NextResponse(null, {
      status: 204,
      headers: appCorsHeaders(origin, allowedAppOrigins()) ?? {}
    })
  }

  // Create a response
  let response: NextResponse

  if (hasSupabasePublicConfig()) {
    response = await updateSession(request)
  } else {
    // If Supabase is not configured, just pass the request through
    response = NextResponse.next({
      request
    })
  }

  // Add request information to response headers
  response.headers.set('x-url', request.url)
  response.headers.set('x-host', host)
  response.headers.set('x-protocol', protocol)
  response.headers.set('x-base-url', baseUrl)

  if (isApi) {
    const cors = appCorsHeaders(origin, allowedAppOrigins())
    for (const [name, value] of Object.entries(cors ?? {})) {
      if (name === 'Vary') response.headers.append(name, value)
      else response.headers.set(name, value)
    }
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - api/upload, api/voice/transcribe (exact): raw-body routes. Next wraps
     *   the body of every request the proxy runs for in a clone capped at
     *   experimental.proxyClientMaxBodySize (10 MB) and silently ends it
     *   there, which truncated uploads and broke larger recordings. These two
     *   routes answer the app's CORS themselves (lib/http/with-app-cors.ts);
     *   /api is a public path, so they need nothing else from the proxy.
     * - api/ingest/complete (exact): the ingest worker posts all of a file's
     *   chunks in one body, often past 10 MB. It checks the worker's bearer
     *   token itself and needs no session or CORS.
     * Feel free to modify this pattern to include more paths.
     */
    '/((?!_next/static|_next/image|favicon.ico|api/upload$|api/voice/transcribe$|api/ingest/complete$|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'
  ]
}
