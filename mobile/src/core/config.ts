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

/**
 * A simulator E2E build (sync-mac.sh sim sets VITE_E2E_AUTOSEND=true): an
 * ask:// link sends at once and a question seeded in Preferences is asked at
 * launch. Never on in a default or device build, where a link only fills the
 * box: a turn can write a lasting memory, so no outside app may send one.
 */
export function isE2eAutoSend(
  env: Record<string, string | undefined> = import.meta.env
): boolean {
  return env.VITE_E2E_AUTOSEND === 'true'
}
