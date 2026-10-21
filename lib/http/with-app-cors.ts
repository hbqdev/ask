// CORS for the bundled mobile app on routes the proxy does not run for.
//
// /api/upload and /api/voice/transcribe are excluded from the proxy matcher
// (proxy.ts) so Next never wraps their bodies in its 10 MB proxy clone. That
// also means the proxy no longer answers their preflight or adds the app CORS
// headers, so the routes do it themselves with these helpers. The headers and
// allow-list are the proxy's own (lib/http/app-cors.ts).

import { allowedAppOrigins, appCorsHeaders } from '@/lib/http/app-cors'

/** `res` with the app CORS headers added when `origin` is allowed. */
export function withAppCors(res: Response, origin: string | null): Response {
  const cors = appCorsHeaders(origin, allowedAppOrigins())
  if (!cors) return res
  const headers = new Headers(res.headers)
  for (const [name, value] of Object.entries(cors)) {
    if (name === 'Vary') headers.append(name, value)
    else headers.set(name, value)
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers
  })
}

/** The answer to a CORS preflight: 204, with headers for allowed origins only. */
export function appPreflight(req: Request): Response {
  return withAppCors(
    new Response(null, { status: 204 }),
    req.headers.get('origin')
  )
}
