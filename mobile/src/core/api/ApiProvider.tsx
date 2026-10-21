import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { createApiClient, type ApiClient } from '@/core/api/client'
import { useAuth } from '@/core/auth/AuthProvider'

export type Api = {
  client: ApiClient
  /** The Ask server origin, without a trailing slash. */
  baseUrl: string
  /** The current access token (refreshed first when needed), or null. */
  getToken: () => Promise<string | null>
}

const ApiContext = createContext<Api | null>(null)

/** One API client for the signed-in app, on `baseUrl` with the auth token. */
export function ApiProvider({
  baseUrl,
  children
}: {
  baseUrl: string
  children: ReactNode
}) {
  const { getAccessToken } = useAuth()
  const value = useMemo(
    () => ({
      client: createApiClient({ baseUrl, getToken: getAccessToken }),
      baseUrl,
      getToken: getAccessToken
    }),
    [baseUrl, getAccessToken]
  )
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
}

export function useApi(): Api {
  const api = useContext(ApiContext)
  if (!api) throw new Error('useApi must be used inside ApiProvider')
  return api
}
