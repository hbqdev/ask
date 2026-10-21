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
  useState,
  type ReactNode
} from 'react'

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

const AuthContext = createContext<Auth | null>(null)

/** A short, user-facing message for a failed sign-in. */
function signInErrorMessage(err: unknown): string {
  // supabase-js reports an unreachable server as AuthRetryableFetchError; a
  // raw fetch rejection is a TypeError ("Failed to fetch" / "Load failed").
  if (isAuthRetryableFetchError(err) || err instanceof TypeError) {
    return 'Network error. Check your connection.'
  }
  if (isAuthApiError(err) && err.code === 'invalid_credentials') {
    return 'Invalid email or password'
  }
  return err instanceof Error ? err.message : 'Sign-in failed'
}

export function AuthProvider({
  client,
  children
}: {
  client: SupabaseClient
  children: ReactNode
}) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = useCallback((next: Session | null) => {
    setSession(next)
    setStatus(next ? 'signedIn' : 'signedOut')
  }, [])

  useEffect(() => {
    // Restore the persisted session (refreshed if expired) before deciding
    // whether to show sign-in; until then the status stays 'loading'.
    client.auth.getSession().then(
      ({ data }) => apply(data.session),
      () => apply(null)
    )
    // Refreshes, sign-outs and recoveries after a failed refresh.
    const { data } = client.auth.onAuthStateChange((_event, next) =>
      apply(next)
    )
    return () => data.subscription.unsubscribe()
  }, [client, apply])

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null)
      try {
        const { data, error: authError } =
          await client.auth.signInWithPassword({ email, password })
        if (authError) throw authError
        apply(data.session)
        return true
      } catch (err) {
        setError(signInErrorMessage(err))
        return false
      }
    },
    [client, apply]
  )

  const signOut = useCallback(async () => {
    await client.auth.signOut()
    setError(null)
    apply(null)
  }, [client, apply])

  const getAccessToken = useCallback(async () => {
    const { data } = await client.auth.getSession()
    return data.session?.access_token ?? null
  }, [client])

  const value = useMemo(
    () => ({ status, session, error, signIn, signOut, getAccessToken }),
    [status, session, error, signIn, signOut, getAccessToken]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): Auth {
  const auth = useContext(AuthContext)
  if (!auth) throw new Error('useAuth must be used inside AuthProvider')
  return auth
}
