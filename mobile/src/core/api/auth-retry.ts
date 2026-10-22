// A fetch that answers a server 401 once: the handler refreshes the session
// (deduplicated app-wide by ApiProvider) and, when it says so, the request is
// sent again with the fresh token. A second 401 tells the handler the session
// is dead (it signs out). Anything else passes through untouched.

/** Which 401 this is: the request's first, or the one after the resend. */
export type UnauthorizedStage = 'first' | 'afterRetry'

/** Decides what a 401 means: `retry` resends once, `stop` returns the 401. */
export type UnauthorizedHandler = (
  stage: UnauthorizedStage
) => Promise<'retry' | 'stop'>

export type AuthRetryOptions = {
  fetchImpl: typeof fetch
  /** The token to resend with, read after the handler refreshed it. */
  getToken: () => Promise<string | null>
  onUnauthorized: UnauthorizedHandler
}

export function authRetryFetch({
  fetchImpl,
  getToken,
  onUnauthorized
}: AuthRetryOptions): (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response> {
  return async (input, init) => {
    const first = await fetchImpl(input, init)
    if (first.status !== 401) return first
    if ((await onUnauthorized('first')) !== 'retry') return first
    // A stream body has been read by the first send; it cannot go again.
    if (init?.body instanceof ReadableStream) return first
    // Never resent without a token: the 401 stands.
    const token = await getToken().catch(() => null)
    if (!token) return first

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    headers.set('Authorization', `Bearer ${token}`)
    const second = await fetchImpl(input, { ...init, headers })
    if (second.status === 401) await onUnauthorized('afterRetry')
    return second
  }
}
