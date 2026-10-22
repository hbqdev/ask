import { cache } from 'react'
import { headers } from 'next/headers'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import {
  getSupabasePublishableKey,
  hasSupabasePublicConfig
} from '@/lib/supabase/keys'
import { createClient } from '@/lib/supabase/server'
import { perfLog } from '@/lib/utils/perf-logging'
import { incrementAuthCallCount } from '@/lib/utils/perf-tracking'

/**
 * Extract the token from an `Authorization: Bearer <token>` header value.
 * Returns null for a missing, empty, non-Bearer, or token-less header.
 */
export function bearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(headerValue)
  return match ? match[1] : null
}

async function readAuthorizationHeader(): Promise<string | null> {
  try {
    return (await headers()).get('authorization')
  } catch {
    // Outside a request scope (scripts, some tests): no header to honour.
    return null
  }
}

// Validates a bearer with a client that has no session storage. The cookie-
// bound SSR client must not be used here: auth-js removes the stored session
// when getUser(jwt) hits AuthSessionMissingError, and for the SSR client that
// storage is the request's cookies, so a revoked bearer could wipe a
// co-present cookie session.
async function getUserFromBearer(token: string) {
  const supabase = createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    getSupabasePublishableKey()!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  )
  const { data } = await supabase.auth.getUser(token)
  return data.user ?? null
}

// Once per request (React cache() is request-scoped on the server): a route
// whose actions each resolve the user validates the bearer, a Supabase round
// trip, only once. Outside a request it is a plain call.
export const getCurrentUser = cache(async function getCurrentUser() {
  if (!hasSupabasePublicConfig()) {
    return null // Supabase is not configured
  }

  // Native clients (the mobile app) cannot carry the cookie session, so they
  // send the Supabase access token as a bearer. A request that uses the Bearer
  // scheme is decided by that token alone: a malformed or invalid bearer
  // resolves to null and never falls back to the cookie session. Other schemes
  // (e.g. Basic) are not ours and keep the cookie path.
  const authorization = await readAuthorizationHeader()
  if (authorization && /^Bearer(\s|$)/i.test(authorization)) {
    const token = bearerToken(authorization)
    return token ? getUserFromBearer(token) : null
  }

  const supabase = await createClient()
  const { data } = await supabase.auth.getUser()
  return data.user ?? null
})

export async function getCurrentUserId() {
  const count = incrementAuthCallCount()
  perfLog(`getCurrentUserId called - count: ${count}`)

  // Skip authentication mode (for personal Docker deployments)
  if (process.env.ENABLE_AUTH === 'false') {
    // Guard: Prevent disabling auth in Morphic Cloud deployments
    if (process.env.MORPHIC_CLOUD_DEPLOYMENT === 'true') {
      throw new Error(
        'ENABLE_AUTH=false is not allowed in MORPHIC_CLOUD_DEPLOYMENT'
      )
    }

    // Always warn when authentication is disabled (except in tests)
    if (process.env.NODE_ENV !== 'test') {
      console.warn(
        '⚠️  Authentication disabled. Running in anonymous mode.\n' +
          '   All users share the same user ID. For personal use only.'
      )
    }

    return process.env.ANONYMOUS_USER_ID || 'anonymous-user'
  }

  const user = await getCurrentUser()
  return user?.id
}
