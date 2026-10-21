// The app's HTTP client for Ask's API: absolute URLs on the configured server,
// the Supabase access token as a bearer header (never sent without one, unless
// a request opts out with `auth: false`), and typed errors.

import { ApiError, toApiError } from '@/core/api/errors'

/** RequestInit plus `auth: false` for public endpoints that take no token. */
export type ApiRequestInit = RequestInit & {
  /** Defaults to true. `false` sends no Authorization and skips getToken. */
  auth?: boolean
}

export type ApiClient = {
  /** The absolute URL for an API path such as `/api/chats`. */
  url(path: string): string
  /**
   * Authenticated fetch. Resolves with any HTTP response (non-2xx included).
   * Rejects with a 401 ApiError, without sending, when there is no token
   * (never falls back to an unauthenticated request); with a status-0
   * ApiError when the network fails; and with the original reason when the
   * caller aborted.
   */
  fetch(path: string, init?: ApiRequestInit): Promise<Response>
  /**
   * Fetch and parse JSON. Rejects like `fetch`, and with an ApiError for a
   * non-2xx status.
   */
  json<T>(path: string, init?: ApiRequestInit): Promise<T>
}

export type ApiClientOptions = {
  baseUrl: string
  /** Pass `useAuth().getAccessToken`, which refreshes an expired token. */
  getToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
}

export const NETWORK_ERROR_MESSAGE = 'Network error. Check your connection.'
export const SIGNED_OUT_MESSAGE = 'Signed out'

export function createApiClient({
  baseUrl,
  getToken,
  fetchImpl = (...args) => globalThis.fetch(...args)
}: ApiClientOptions): ApiClient {
  const base = baseUrl.replace(/\/+$/, '')

  const url = (path: string) => `${base}/${path.replace(/^\/+/, '')}`

  const signedOut = () =>
    new ApiError(401, SIGNED_OUT_MESSAGE, { retryable: false })

  async function bearer(): Promise<string> {
    let token: string | null
    try {
      token = await getToken()
    } catch {
      throw signedOut()
    }
    if (!token) throw signedOut()
    return token
  }

  async function apiFetch(path: string, init: ApiRequestInit = {}) {
    const { auth = true, ...rest } = init
    const headers = new Headers(rest.headers)
    if (auth) headers.set('Authorization', `Bearer ${await bearer()}`)
    try {
      return await fetchImpl(url(path), { ...rest, headers })
    } catch (error) {
      // A caller's abort is a cancellation, not a lost connection — whatever
      // reason the caller aborted with.
      if (
        rest.signal?.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        throw error
      }
      throw new ApiError(0, NETWORK_ERROR_MESSAGE, { retryable: true })
    }
  }

  async function json<T>(path: string, init?: ApiRequestInit): Promise<T> {
    const res = await apiFetch(path, init)
    if (!res.ok) throw await toApiError(res)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return { url, fetch: apiFetch, json }
}
