// CORS for the bundled mobile app (Capacitor) calling `/api/*` cross-origin
// with `Authorization: Bearer …`. Its web view origin is `capacitor://localhost`
// on iOS and `https://localhost` on Android.
//
// Only origins on an explicit allow-list are echoed back — never `*` — and
// `Access-Control-Allow-Credentials` is deliberately absent: the app
// authenticates with a bearer token, not cookies. Same-origin web requests
// carry no (or the site's own) Origin and are left untouched.

const DEFAULT_APP_ORIGINS = ['capacitor://localhost', 'https://localhost']

/** Allowed app origins: `APP_CORS_ORIGINS` (comma-separated) or the default. */
export function allowedAppOrigins(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const configured = (env.APP_CORS_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
  return configured.length > 0 ? configured : [...DEFAULT_APP_ORIGINS]
}

/** CORS response headers for `origin`, or null when it is not allowed. */
export function appCorsHeaders(
  origin: string | null,
  allowed: string[]
): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, x-filename, x-chat-id',
    'Access-Control-Expose-Headers':
      'x-vercel-ai-ui-message-stream, Content-Type',
    'Access-Control-Max-Age': '600'
  }
}

/** A CORS preflight: OPTIONS carrying Origin and Access-Control-Request-Method. */
export function isCorsPreflight(method: string, headers: Headers): boolean {
  return (
    method.toUpperCase() === 'OPTIONS' &&
    headers.has('origin') &&
    headers.has('access-control-request-method')
  )
}
