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
   * session), one after the resend signs out. Concurrent calls share one
   * refresh, and a session is signed out at most once.
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
  const { status, getAccessToken, refreshAccessToken, signOut } = useAuth()
  const auth = useRef({ refreshAccessToken, signOut })
  useEffect(() => {
    auth.current = { refreshAccessToken, signOut }
  }, [refreshAccessToken, signOut])

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

    const endSession = async () => {
      if (signedOut.current) return
      signedOut.current = true
      try {
        await auth.current.signOut({ notice: SIGNED_OUT_NOTICE })
      } catch {
        // Signing out cleans up after itself; nothing more to do here.
      }
    }

    const run = async (): Promise<'retry' | 'stop'> => {
      if (signedOut.current) return 'stop'
      if (stage === 'afterRetry') {
        await endSession()
        return 'stop'
      }
      let refreshed: RefreshResult
      try {
        refreshed = await auth.current.refreshAccessToken()
      } catch {
        // Not a definitive refusal: the session stays.
        refreshed = OFFLINE
      }
      if (refreshed.status === 'refreshed') return 'retry'
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
