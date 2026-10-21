import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import type { AppConfig } from '@/core/config'

/**
 * The app's Supabase client. The session persists in `storage` and supabase-js
 * refreshes the access token on its own, so a cold start restores the session
 * without a sign-in. There is no OAuth redirect into the app, so the URL is
 * never read for a session.
 */
export function createSupabase(
  config: AppConfig,
  storage: AuthStorage = preferencesStorage
): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: {
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce'
    }
  })
}
