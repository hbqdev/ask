// The app's HTTP client for Ask's API: absolute URLs on the configured server,
// the Supabase access token as a bearer header, and typed errors.

import { ApiError, toApiError } from '@/core/api/errors'

export type ApiClient = {
  /** The absolute URL for an API path such as `/api/chats`. */
  url(path: string): string
  /**
   * Authenticated fetch. Resolves with any HTTP response (non-2xx included);
   * rejects with a status-0 ApiError when the network fails.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Fetch and parse JSON; rejects with an ApiError for a non-2xx status. */
  json<T>(path: string, init?: RequestInit): Promise<T>
}

export type ApiClientOptions = {
  baseUrl: string
  /** Pass `useAuth().getAccessToken`, which refreshes an expired token. */
  getToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
}

export const NETWORK_ERROR_MESSAGE = 'Network error. Check your connection.'

export function createApiClient({
  baseUrl,
  getToken,
  fetchImpl = (...args) => globalThis.fetch(...args)
}: ApiClientOptions): ApiClient {
  const base = baseUrl.replace(/\/+$/, '')

  const url = (path: string) => `${base}/${path.replace(/^\/+/, '')}`

  async function apiFetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    const token = await getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)
    try {
      return await fetchImpl(url(path), { ...init, headers })
    } catch (error) {
      // A caller's abort is a cancellation, not a lost connection.
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      throw new ApiError(0, NETWORK_ERROR_MESSAGE, { retryable: true })
    }
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await apiFetch(path, init)
    if (!res.ok) throw await toApiError(res)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return { url, fetch: apiFetch, json }
}
