// "Continue with Google": supabase-js PKCE in the system in-app browser
// (SFSafariViewController on iOS, which Google allows; an embedded webview it
// does not). Supabase sends the browser back to ask://auth-callback with a
// code (or an error); the app's appUrlOpen listener (useAuthCallbackLink)
// hands that URL here, and the code is exchanged, with the verifier
// supabase-js stored in the app's auth storage, for a session.
//
// One sign-in at a time. The pending attempt lives in this module, not in a
// component, so a callback that arrives after the sign-in screen re-rendered
// still finds it; a callback with no attempt pending is ignored.

import { Browser } from '@capacitor/browser'
import type { PluginListenerHandle } from '@capacitor/core'
import type { Session, SupabaseClient } from '@supabase/supabase-js'

/** Where Supabase sends the browser back to; on its Redirect URLs allow-list. */
export const AUTH_CALLBACK_URL = 'ask://auth-callback'

/** How long a sign-in waits for the browser to come back. */
export const GOOGLE_SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000

/**
 * How long a closed browser waits for the callback before the sign-in counts
 * as cancelled: iOS may report the browser closed before it hands the app
 * the ask://auth-callback URL.
 */
export const BROWSER_CLOSED_GRACE_MS = 1500

export const GOOGLE_SIGN_IN_FAILED = 'Google sign-in failed. Try again.'
export const SIGN_IN_CANCELLED = 'Sign-in was cancelled.'
const TIMED_OUT = 'Sign-in timed out'
const NO_BROWSER = "Couldn't open the browser"

// What the user is told for an OAuth error code (RFC 6749 §4.1.2.1); any
// other code gets GOOGLE_SIGN_IN_FAILED. Supabase's error_description is
// never shown: any app can open ask://auth-callback while a sign-in is
// pending, so it is text an attacker chooses.
const ERROR_MESSAGES = new Map([['access_denied', SIGN_IN_CANCELLED]])

export type AuthCallback = { code: string } | { error: string }

export type GoogleSignIn =
  | { outcome: 'signedIn'; session: Session }
  /** The user closed the browser without signing in. */
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; error: string }
  /** Another sign-in was already under way; this one did nothing. */
  | { outcome: 'busy' }

type Settled = AuthCallback | { cancelled: true }

const ignore = () => {}

// The pending sign-in's resolver; resolving twice is a no-op, so the first of
// callback, cancel and timeout wins.
let settlePending: ((result: Settled) => void) | null = null

/**
 * The code, or a user-facing error, in an ask://auth-callback URL; null for
 * any other URL. The error is the app's own message for the `error` code
 * (query or fragment).
 */
export function parseAuthCallback(url: string): AuthCallback | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'ask:' || parsed.host !== 'auth-callback') {
    return null
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null
  const query = parsed.searchParams
  const code = query.get('code')
  if (code) return { code }
  const fragment = new URLSearchParams(parsed.hash.slice(1))
  const errorCode = query.get('error') ?? fragment.get('error') ?? ''
  return { error: ERROR_MESSAGES.get(errorCode) ?? GOOGLE_SIGN_IN_FAILED }
}

/** Whether a Google sign-in is under way. */
export function googleSignInPending(): boolean {
  return settlePending !== null
}

function closeBrowser() {
  // On iOS the browser may already be closing; that rejection means nothing.
  Browser.close().catch(ignore)
}

/**
 * Hands an app URL to the pending sign-in when it is its callback, and closes
 * the browser. A callback with no sign-in pending (a stale or replayed link)
 * is ignored; any other URL is not this module's.
 */
export function deliverAuthCallback(url: string): void {
  const callback = parseAuthCallback(url)
  if (!callback) return
  if (!settlePending) {
    console.warn('[auth] ignored a sign-in callback: no sign-in is under way')
    return
  }
  settlePending(callback)
  closeBrowser()
}

/**
 * Signs in with Google: opens Supabase's authorize URL in the in-app browser
 * and waits for exactly one of the callback, the user closing the browser, or
 * the timeout. A code is exchanged for a session (supabase-js stores it and
 * emits SIGNED_IN). Throws when Supabase fails to start or exchange.
 */
export async function runGoogleSignIn(
  client: SupabaseClient
): Promise<GoogleSignIn> {
  if (settlePending) return { outcome: 'busy' }
  let settle: (result: Settled) => void = ignore
  const settled = new Promise<Settled>(resolve => {
    settle = resolve
  })
  settlePending = settle
  const timer = setTimeout(() => {
    settle({ error: TIMED_OUT })
    closeBrowser()
  }, GOOGLE_SIGN_IN_TIMEOUT_MS)
  let finished: PluginListenerHandle | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true }
    })
    if (error) throw error
    // Fires when the user closes the browser, or after it is closed here; a
    // callback that came first has already settled the sign-in by then, and
    // one that comes within the grace period still wins.
    finished = await Browser.addListener('browserFinished', () => {
      clearTimeout(grace)
      grace = setTimeout(
        () => settle({ cancelled: true }),
        BROWSER_CLOSED_GRACE_MS
      )
    })
    const opened = await Browser.open({ url: data.url }).then(
      () => true,
      () => false
    )
    if (!opened) return { outcome: 'failed', error: NO_BROWSER }

    const result = await settled
    if ('cancelled' in result) return { outcome: 'cancelled' }
    if ('error' in result) return { outcome: 'failed', error: result.error }
    const exchanged = await client.auth.exchangeCodeForSession(result.code)
    if (exchanged.error) throw exchanged.error
    return { outcome: 'signedIn', session: exchanged.data.session }
  } finally {
    clearTimeout(timer)
    clearTimeout(grace)
    settlePending = null
    finished?.remove().catch(ignore)
  }
}
