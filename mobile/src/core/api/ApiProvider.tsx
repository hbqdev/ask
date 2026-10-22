import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode
} from 'react'

import type {
  UnauthorizedHandler,
  UnauthorizedStage
} from '@/core/api/auth-retry'
import { createApiClient, type ApiClient } from '@/core/api/client'
import {
  SIGNED_OUT_NOTICE,
  useAuth,
  type RefreshResult
} from '@/core/auth/AuthProvider'

export type Api = {
  client: ApiClient
  /** The Ask server origin, without a trailing slash. */
  baseUrl: string
  /** The current access token (refreshed first when needed), or null. */
  getToken: () => Promise<string | null>
  /**
   * What a server 401 means, app-wide: the first refreshes the session
   * (`retry` once refreshed; a refused refresh signs out; offline keeps the
   * session). A 401 again after a refresh Supabase accepted stops without
   * signing out (P6-R14): the session is valid, the server could not check
   * it. Concurrent calls share one refresh, and a session is signed out at
   * most once. Bound to this provider's mount and account: once either is
   * gone, a late 401 neither refreshes nor resends.
   */
  handleUnauthorized: UnauthorizedHandler
}

const ApiContext = createContext<Api | null>(null)

const OFFLINE: RefreshResult = { status: 'offline' }

/** One API client for the signed-in app, on `baseUrl` with the auth token. */
export function ApiProvider({
  baseUrl,
  children
}: {
  baseUrl: string
  children: ReactNode
}) {
  const { status, session, getAccessToken, refreshAccessToken, signOut } =
    useAuth()
  const userId = session?.user?.id
  const auth = useRef({ refreshAccessToken, signOut })
  useEffect(() => {
    auth.current = { refreshAccessToken, signOut }
  }, [refreshAccessToken, signOut])

  // The account this provider was mounted for, and the one shown now. A sign-
  // out unmounts the provider (AppShell), so a mount is one signed-in session.
  const mountedFor = useRef(userId)
  const shownFor = useRef(userId)
  useEffect(() => {
    shownFor.current = userId
  }, [userId])
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Set once this session is signed out over a 401; the next sign-in clears
  // it. Late 401s (a burst's stragglers) then change nothing.
  const signedOut = useRef(false)
  useEffect(() => {
    if (status === 'signedIn') signedOut.current = false
  }, [status])

  // The handling under way for each stage, shared by concurrent 401s.
  const inFlight = useRef<
    Partial<Record<UnauthorizedStage, Promise<'retry' | 'stop'>>>
  >({})

  const handleUnauthorized = useCallback<UnauthorizedHandler>(stage => {
    const shared = inFlight.current[stage]
    if (shared) return shared

    // Reached only by the one 'first' handling under way (calls share it),
    // which checked `signedOut` before refreshing.
    const endSession = async () => {
      signedOut.current = true
      try {
        await auth.current.signOut({ notice: SIGNED_OUT_NOTICE })
      } catch {
        // Signing out cleans up after itself; nothing more to do here.
      }
    }

    // Still the session the request was sent in.
    const current = () =>
      alive.current && shownFor.current === mountedFor.current

    const run = async (): Promise<'retry' | 'stop'> => {
      // P6-R14: Supabase has just accepted the refresh, so the session is
      // valid; the server could not check the token (e.g. its link to
      // Supabase is down). The request shows its own error; nobody is signed
      // out. A dead session is caught by the refused refresh instead.
      if (stage === 'afterRetry') return 'stop'
      if (signedOut.current || !current()) return 'stop'
      let refreshed: RefreshResult
      try {
        refreshed = await auth.current.refreshAccessToken()
      } catch {
        // Not a definitive refusal: the session stays.
        refreshed = OFFLINE
      }
      // Never resent once the provider or its account is gone: the request
      // would go out with whatever session exists now.
      if (refreshed.status === 'refreshed') return current() ? 'retry' : 'stop'
      // Even unmounted: supabase-js's own SIGNED_OUT over this very refusal
      // unmounts the provider before the refresh resolves. AuthProvider
      // reports a refusal that spans a sign-out or another session as
      // offline, so this never follows anyone else's sign-out.
      if (refreshed.status === 'failed') await endSession()
      return 'stop'
    }

    const handling = run().finally(() => {
      delete inFlight.current[stage]
    })
    inFlight.current[stage] = handling
    return handling
  }, [])

  const value = useMemo(
    () => ({
      client: createApiClient({
        baseUrl,
        getToken: getAccessToken,
        onUnauthorized: handleUnauthorized
      }),
      baseUrl,
      getToken: getAccessToken,
      handleUnauthorized
    }),
    [baseUrl, getAccessToken, handleUnauthorized]
  )
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
}

export function useApi(): Api {
  const api = useContext(ApiContext)
  if (!api) throw new Error('useApi must be used inside ApiProvider')
  return api
}
