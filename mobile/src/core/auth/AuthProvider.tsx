import {
  isAuthApiError,
  isAuthRetryableFetchError,
  isAuthSessionMissingError,
  type Session,
  type SupabaseClient
} from '@supabase/supabase-js'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'

import {
  preferencesStorage,
  type AuthStorage
} from '@/core/auth/preferences-storage'
import { googleSignInPending, runGoogleSignIn } from '@/core/auth/oauth'
import { AUTH_STORAGE_KEY } from '@/core/auth/supabase'
import { useAuthCallbackLink } from '@/core/deep-link'
import { takeSharedItem } from '@/core/shared-inbox'
import { resetModelChoice } from '@/features/compose/model-choice'
import { clearLibraryCache } from '@/features/library/library-cache'
import { resetNotesCache } from '@/features/notes/notes-cache'

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn'

export type Auth = {
  status: AuthStatus
  session: Session | null
  error: string | null
  /**
   * Information for the sign-in screen, not an error: why the user was
   * signed out (e.g. "Your account was deleted"). Set by signOut's `notice`,
   * cleared by the next sign-in attempt. Stand-ins may leave it out.
   */
  notice?: string | null
  signIn(email: string, password: string): Promise<boolean>
  /**
   * Google sign-in in the in-app browser. False when cancelled, failed (with
   * `error` saying why) or ignored because one is already under way.
   */
  signInWithGoogle(): Promise<boolean>
  /** Signs out on this device; `notice` is then shown on the sign-in screen. */
  signOut(options?: SignOutOptions): Promise<void>
  /** The current access token; supabase-js refreshes it first when needed. */
  getAccessToken(): Promise<string | null>
  /**
   * Refreshes the session now (the server refused its access token). Only a
   * definitive refusal of the refresh token is `failed`; anything that may
   * pass (no connection, a Supabase outage or rate limit) is `offline`.
   */
  refreshAccessToken(): Promise<RefreshResult>
}

/** The sign-in screen's notice after a session the server refused. */
export const SIGNED_OUT_NOTICE = 'You’ve been signed out.'

export type RefreshResult =
  | { status: 'refreshed'; token: string }
  | { status: 'failed' }
  | { status: 'offline' }

export type SignOutOptions = {
  notice?: string
  /**
   * Leaves a share waiting in the inbox (by default it is dropped, so it
   * never reaches the next account's composer).
   */
  keepSharedItem?: boolean
}

type View = { status: AuthStatus; session: Session | null }

const AuthContext = createContext<Auth | null>(null)

// The messages WebKit, Chromium and Firefox give a fetch that never reached
// the server.
const FETCH_FAILURE = /Failed to fetch|Load failed|NetworkError/

function isNetworkFailure(err: unknown): boolean {
  return (
    isAuthRetryableFetchError(err) ||
    (err instanceof TypeError && FETCH_FAILURE.test(err.message))
  )
}

const NETWORK_ERROR = 'Network error. Check your connection.'

/**
 * How long a refresh may take before it counts as offline: supabase-js keeps
 * retrying a Supabase outage for up to ~30 s, and the 401'd requests wait.
 */
export const REFRESH_TIMEOUT_MS = 8_000

const REFRESH_FAILED: RefreshResult = { status: 'failed' }
const REFRESH_OFFLINE: RefreshResult = { status: 'offline' }

/**
 * What a failed refresh means. Only Supabase refusing the refresh token
 * (400: invalid, revoked or expired; 401: the user is gone) or having no
 * refresh token to send is definitive. Everything else (no connection, a
 * 5xx, a 429, a timeout, anything unknown) may pass, so the session stays.
 */
function refreshFailure(err: unknown): RefreshResult {
  if (isNetworkFailure(err)) return REFRESH_OFFLINE
  if (isAuthApiError(err) && (err.status === 400 || err.status === 401)) {
    return REFRESH_FAILED
  }
  return isAuthSessionMissingError(err) ? REFRESH_FAILED : REFRESH_OFFLINE
}

/** A short, user-facing message for a failed sign-in. */
function signInErrorMessage(err: unknown): string {
  if (isNetworkFailure(err)) return NETWORK_ERROR
  if (isAuthApiError(err) && err.code === 'invalid_credentials') {
    return 'Invalid email or password'
  }
  return err instanceof Error ? err.message : 'Sign-in failed'
}

/**
 * The session supabase-js persisted, read straight from storage so a cold
 * start shows it without waiting for the network. Anything unreadable or
 * without a refresh token counts as nothing stored.
 */
async function readStoredSession(
  storage: AuthStorage
): Promise<Session | null> {
  try {
    const raw = await storage.getItem(AUTH_STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<Session> | null) : null
    return parsed?.refresh_token ? (parsed as Session) : null
  } catch {
    return null
  }
}

export function AuthProvider({
  client,
  storage = preferencesStorage,
  children
}: {
  client: SupabaseClient
  storage?: AuthStorage
  children: ReactNode
}) {
  const [view, setView] = useState<View>({ status: 'loading', session: null })
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Set by signOut until the next signIn: a refresh that races the sign-out
  // must not sign the user back in.
  const signedOutHere = useRef(false)
  // Bumped by every sign-out here, every sign-in and every change of account:
  // a refresh that spans one belongs to a session that is gone.
  const sessionEpoch = useRef(0)

  // The user the app last showed. Account state kept in memory (the shared
  // model pick and its save queue, the notes) is reset whenever the account
  // changes, so nothing of one account's is ever shown to, or sent for, the
  // next.
  const accountId = useRef<string | null>(null)

  const showSession = useCallback((session: Session) => {
    if (signedOutHere.current) return
    const id = session.user.id
    if (accountId.current !== null && accountId.current !== id) {
      sessionEpoch.current++
      resetModelChoice()
      resetNotesCache()
    }
    accountId.current = id
    setView({ status: 'signedIn', session })
  }, [])

  // However the session ended (signOut here, or supabase-js dropping it: a
  // revoked or expired refresh, a sign-out elsewhere), the cached Library
  // rows and notes of that account go too. Not awaited: a failure to clear
  // never keeps the app signed in.
  const showSignedOut = useCallback(() => {
    accountId.current = null
    resetModelChoice()
    resetNotesCache()
    clearLibraryCache(storage).catch(() => {})
    setView({ status: 'signedOut', session: null })
  }, [storage])

  useEffect(() => {
    // Only SIGNED_OUT (supabase-js emits it whenever it drops the session)
    // signs out here. A null INITIAL_SESSION also comes from a refresh that
    // failed offline, and the stored session is still good then.
    const { data } = client.auth.onAuthStateChange((event, next) => {
      if (event === 'SIGNED_OUT') showSignedOut()
      else if (next) showSession(next)
    })

    async function restore() {
      const stored = await readStoredSession(storage)
      if (stored && !signedOutHere.current) {
        accountId.current ??= stored.user?.id ?? null
        // Optimistic: only if nothing (e.g. a SIGNED_OUT) has settled it yet.
        setView(prev =>
          prev.status === 'loading'
            ? { status: 'signedIn', session: stored }
            : prev
        )
      }
      // Then reconcile: refreshed if expired, which can take a while offline.
      const fresh = await client.auth.getSession().then(
        ({ data }) => data.session,
        () => null
      )
      if (fresh) showSession(fresh)
      else if (!stored) showSignedOut()
    }
    void restore()

    return () => data.subscription.unsubscribe()
  }, [client, storage, showSession, showSignedOut])

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null)
      setNotice(null)
      try {
        const { data, error: authError } = await client.auth.signInWithPassword(
          { email, password }
        )
        if (authError) throw authError
        signedOutHere.current = false
        sessionEpoch.current++
        showSession(data.session)
        return true
      } catch (err) {
        setError(signInErrorMessage(err))
        return false
      }
    },
    [client, showSession]
  )

  // Google's callback comes back as an app URL, whichever screen is showing.
  useAuthCallbackLink()

  const signInWithGoogle = useCallback(async () => {
    // A second tap while one is under way changes nothing.
    if (googleSignInPending()) return false
    setError(null)
    setNotice(null)
    try {
      const result = await runGoogleSignIn(client)
      if (result.outcome === 'signedIn') {
        // As signIn: supabase-js has already emitted SIGNED_IN, which a
        // sign-out earlier in this run makes showSession ignore.
        signedOutHere.current = false
        sessionEpoch.current++
        showSession(result.session)
        return true
      }
      if (result.outcome === 'failed') setError(result.error)
      return false
    } catch (err) {
      setError(isNetworkFailure(err) ? NETWORK_ERROR : 'Google sign-in failed')
      return false
    }
  }, [client, showSession])

  const signOut = useCallback(
    async (options?: SignOutOptions) => {
      signedOutHere.current = true
      sessionEpoch.current++
      // Before the server is awaited: supabase-js's SIGNED_OUT may show the
      // sign-in screen meanwhile, and it shows the notice from the start.
      setNotice(options?.notice ?? null)
      // At once, before awaiting the server: a save that settles meanwhile
      // must not send a waiting pick for this account.
      resetModelChoice()
      // A share waiting in the inbox was meant for this account's composer,
      // not the next one's: taken and dropped (unless keepSharedItem).
      const sharedItemDropped = options?.keepSharedItem
        ? null
        : takeSharedItem()
      // supabase-js keeps the local session when the server can't be reached;
      // remove it ourselves so the next cold start doesn't restore it.
      const cleared = await client.auth.signOut({ scope: 'local' }).then(
        ({ error: authError }) => !authError,
        () => false
      )
      const authKeys = cleared ? [] : ['', '-code-verifier', '-user']
      await Promise.allSettled([
        ...authKeys.map(suffix =>
          storage.removeItem(AUTH_STORAGE_KEY + suffix)
        ),
        sharedItemDropped
      ])
      setError(null)
      // Also clears the cached Library rows and notes, which belong to this
      // account; device preferences (search settings, Library sort and
      // segment, custom instructions) stay.
      showSignedOut()
    },
    [client, storage, showSignedOut]
  )

  const getAccessToken = useCallback(async () => {
    const { data } = await client.auth.getSession()
    return data.session?.access_token ?? null
  }, [client])

  const refreshAccessToken = useCallback(async (): Promise<RefreshResult> => {
    // Once a sign-out here has begun (Settings, a deleted account), a late
    // 401 changes nothing: no refresh, and never a second sign-out.
    if (signedOutHere.current) return REFRESH_OFFLINE
    const epoch = sessionEpoch.current
    const account = accountId.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<RefreshResult>(resolve => {
      timer = setTimeout(() => resolve(REFRESH_OFFLINE), REFRESH_TIMEOUT_MS)
    })
    const refresh = async (): Promise<RefreshResult> => {
      try {
        const { data, error: authError } = await client.auth.refreshSession()
        if (authError) return refreshFailure(authError)
        const token = data.session?.access_token
        return token ? { status: 'refreshed', token } : REFRESH_FAILED
      } catch (err) {
        return refreshFailure(err)
      }
    }
    const result = await Promise.race([refresh(), timedOut])
    clearTimeout(timer)
    // Signed out here, or another session (another account, or a new sign-in)
    // since it began: the request that asked belongs to a session that is
    // gone, so nothing is resent and nobody is signed out. Supabase dropping
    // the session over this very refusal is not one of these: it stays failed.
    if (signedOutHere.current || sessionEpoch.current !== epoch) {
      return REFRESH_OFFLINE
    }
    if (result.status === 'refreshed' && accountId.current !== account) {
      return REFRESH_OFFLINE
    }
    return result
  }, [client])

  const value = useMemo(
    () => ({
      ...view,
      error,
      notice,
      signIn,
      signInWithGoogle,
      signOut,
      getAccessToken,
      refreshAccessToken
    }),
    [
      view,
      error,
      notice,
      signIn,
      signInWithGoogle,
      signOut,
      getAccessToken,
      refreshAccessToken
    ]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth must be used inside AuthProvider')
  return auth
}
