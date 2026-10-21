import { headers } from 'next/headers'

import { hasSupabasePublicConfig } from '@/lib/supabase/keys'
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

export async function getCurrentUser() {
  if (!hasSupabasePublicConfig()) {
    return null // Supabase is not configured
  }

  const supabase = await createClient()
  // Native clients (the mobile app) cannot carry the cookie session, so they
  // send the Supabase access token as a bearer. A present-but-invalid token
  // resolves to null; it never falls back to the cookie session.
  const token = bearerToken(await readAuthorizationHeader())
  const { data } = token
    ? await supabase.auth.getUser(token)
    : await supabase.auth.getUser()
  return data.user ?? null
}

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
