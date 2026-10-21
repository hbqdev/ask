import {
  isAuthApiError,
  isAuthRetryableFetchError,
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
import { AUTH_STORAGE_KEY } from '@/core/auth/supabase'

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn'

export type Auth = {
  status: AuthStatus
  session: Session | null
  error: string | null
  signIn(email: string, password: string): Promise<boolean>
  signOut(): Promise<void>
  /** The current access token; supabase-js refreshes it first when needed. */
  getAccessToken(): Promise<string | null>
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

/** A short, user-facing message for a failed sign-in. */
function signInErrorMessage(err: unknown): string {
  if (isNetworkFailure(err)) return 'Network error. Check your connection.'
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
async function readStoredSession(storage: AuthStorage): Promise<Session | null> {
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
  // Set by signOut until the next signIn: a refresh that races the sign-out
  // must not sign the user back in.
  const signedOutHere = useRef(false)

  const showSession = useCallback((session: Session) => {
    if (signedOutHere.current) return
    setView({ status: 'signedIn', session })
  }, [])

  const showSignedOut = useCallback(() => {
    setView({ status: 'signedOut', session: null })
  }, [])

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
        // Optimistic: only if nothing (e.g. a SIGNED_OUT) has settled it yet.
        setView((prev) =>
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
      try {
        const { data, error: authError } =
          await client.auth.signInWithPassword({ email, password })
        if (authError) throw authError
        signedOutHere.current = false
        showSession(data.session)
        return true
      } catch (err) {
        setError(signInErrorMessage(err))
        return false
      }
    },
    [client, showSession]
  )

  const signOut = useCallback(async () => {
    signedOutHere.current = true
    // supabase-js keeps the local session when the server can't be reached;
    // remove it ourselves so the next cold start doesn't restore it.
    const cleared = await client.auth.signOut({ scope: 'local' }).then(
      ({ error: authError }) => !authError,
      () => false
    )
    if (!cleared) {
      await Promise.allSettled(
        ['', '-code-verifier', '-user'].map((suffix) =>
          storage.removeItem(AUTH_STORAGE_KEY + suffix)
        )
      )
    }
    setError(null)
    showSignedOut()
  }, [client, storage, showSignedOut])

  const getAccessToken = useCallback(async () => {
    const { data } = await client.auth.getSession()
    return data.session?.access_token ?? null
  }, [client])

  const value = useMemo(
    () => ({ ...view, error, signIn, signOut, getAccessToken }),
    [view, error, signIn, signOut, getAccessToken]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth must be used inside AuthProvider')
  return auth
}
