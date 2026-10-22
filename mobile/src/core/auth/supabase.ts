import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import type { AppConfig } from '@/core/config'

/** Where supabase-js keeps the session (also `-code-verifier` and `-user`). */
export const AUTH_STORAGE_KEY = 'ask-auth'

/**
 * The app's Supabase client. The session persists in `storage` and supabase-js
 * refreshes the access token on its own, so a cold start restores the session
 * without a sign-in. The page URL is never read for a session: Google
 * sign-in comes back as an ask://auth-callback app URL, whose PKCE code
 * core/auth/oauth exchanges itself.
 */
export function createSupabase(
  config: AppConfig,
  storage: AuthStorage = preferencesStorage
): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      storage,
      storageKey: AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce'
    }
  })
}
