// Build-time configuration. Vite inlines the VITE_* values (written into the
// git-ignored .env.local by scripts/env-from-ask.sh) into the bundle; the
// Supabase publishable key is public by design, so nothing secret lives here.

export type AppConfig = {
  /** Ask server origin for API calls, without a trailing slash. */
  apiBaseUrl: string
  supabaseUrl: string
  supabaseKey: string
}

/** The release server; dev and E2E builds override it with VITE_ASK_API_URL. */
const RELEASE_API_BASE_URL = 'https://ask.hbqnexus.win'

export function getConfig(
  env: Record<string, string | undefined> = import.meta.env
): AppConfig {
  const supabaseUrl = env.VITE_SUPABASE_URL
  const supabaseKey = env.VITE_SUPABASE_PUBLISHABLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase configuration')
  }
  const apiBaseUrl = (env.VITE_ASK_API_URL || RELEASE_API_BASE_URL).replace(
    /\/+$/,
    ''
  )
  return { apiBaseUrl, supabaseUrl, supabaseKey }
}
