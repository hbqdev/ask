import { describe, expect, it, vi } from 'vitest'

import {
  createApiClient,
  isServerUnauthorized,
  SIGNED_OUT_MESSAGE
} from '@/core/api/client'
import { ApiError } from '@/core/api/errors'

// Fake values only.
const BASE = 'https://ask.test.invalid'
const TOKEN = 'fake-access-token'

function setup(
  respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  token: string | null = TOKEN
) {
  const fetchImpl = vi.fn(respond)
  const getToken = vi.fn(async () => token)
  const client = createApiClient({
    baseUrl: BASE,
    getToken,
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl, getToken }
}

function sentHeaders(fetchImpl: ReturnType<typeof vi.fn>): Headers {
  const init = fetchImpl.mock.calls[0][1] as RequestInit
  return new Headers(init.headers)
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}

describe('createApiClient().url', () => {
  it('joins the base and path with exactly one slash', () => {
    const { client } = setup(async () => new Response(null))
    expect(client.url('/api/chats')).toBe(`${BASE}/api/chats`)
    expect(client.url('api/chats')).toBe(`${BASE}/api/chats`)
  })

  it('tolerates a trailing slash on the base', () => {
    const client = createApiClient({
      baseUrl: `${BASE}/`,
      getToken: async () => null,
      fetchImpl: vi.fn() as unknown as typeof fetch
    })
    expect(client.url('/api/chats')).toBe(`${BASE}/api/chats`)
  })
})

describe('createApiClient().fetch', () => {
  it('sends the bearer token when one exists', async () => {
    const { client, fetchImpl, getToken } = setup(
      async () => new Response('ok')
    )
    await client.fetch('/api/chats')
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/chats`)
    expect(sentHeaders(fetchImpl).get('Authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('rejects with a non-retryable 401 and never fetches when there is no token', async () => {
    const { client, fetchImpl } = setup(async () => new Response('ok'), null)
    const err = await rejection(client.fetch('/api/chats'))
    expect(err.status).toBe(401)
    expect(err.message).toBe('Signed out')
    expect(err.retryable).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects with a 401 and never fetches when getToken throws', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const client = createApiClient({
      baseUrl: BASE,
      getToken: async () => {
        throw new Error('refresh failed')
      },
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    const err = await rejection(client.fetch('/api/chats'))
    expect(err.status).toBe(401)
    expect(err.message).toBe('Signed out')
    expect(err.retryable).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('json() also rejects signed-out without fetching', async () => {
    const { client, fetchImpl } = setup(async () => Response.json({}), null)
    const err = await rejection(client.json('/api/chats'))
    expect(err.status).toBe(401)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('skips the token entirely for a public request (auth: false)', async () => {
    const { client, fetchImpl, getToken } = setup(
      async () => new Response('ok'),
      null
    )
    const res = await client.fetch('/api/config', { auth: false })
    expect(res.status).toBe(200)
    expect(getToken).not.toHaveBeenCalled()
    expect(sentHeaders(fetchImpl).has('Authorization')).toBe(false)
    const init = fetchImpl.mock.calls[0][1] as Record<string, unknown>
    expect('auth' in init).toBe(false)
  })

  it('json() honours auth: false', async () => {
    const { client, getToken } = setup(async () => Response.json({ ok: 1 }))
    await expect(
      client.json('/api/config', { auth: false, method: 'GET' })
    ).resolves.toEqual({ ok: 1 })
    expect(getToken).not.toHaveBeenCalled()
  })

  it('keeps the caller init and headers', async () => {
    const { client, fetchImpl } = setup(async () => new Response('ok'))
    await client.fetch('/api/chats', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' }
    })
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    const headers = sentHeaders(fetchImpl)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('uses the global fetch when no fetchImpl is given', async () => {
    const globalFetch = vi.fn(async () => new Response('ok'))
    vi.stubGlobal('fetch', globalFetch)
    try {
      const client = createApiClient({
        baseUrl: BASE,
        getToken: async () => TOKEN
      })
      const res = await client.fetch('/api/chats')
      expect(res.status).toBe(200)
      expect(globalFetch).toHaveBeenCalledWith(
        `${BASE}/api/chats`,
        expect.objectContaining({ headers: expect.any(Headers) })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns non-2xx responses without throwing', async () => {
    const { client } = setup(async () => new Response('nope', { status: 500 }))
    const res = await client.fetch('/api/chats')
    expect(res.status).toBe(500)
  })

  it('turns a network TypeError into a retryable status-0 ApiError', async () => {
    const { client } = setup(async () => {
      throw new TypeError('Failed to fetch')
    })
    const err = await rejection(client.fetch('/api/chats'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(0)
    expect(err.retryable).toBe(true)
    expect(err.message).toBe('Network error. Check your connection.')
  })

  it('rethrows an abort unchanged so cancellation is not reported as offline', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const { client } = setup(async () => {
      throw abort
    })
    await expect(client.fetch('/api/chats')).rejects.toBe(abort)
  })

  it('rethrows the original rejection when the caller aborted with a custom reason', async () => {
    const controller = new AbortController()
    const reason = new Error('user pressed stop')
    const { client } = setup(async () => {
      controller.abort(reason)
      throw reason
    })
    await expect(
      client.fetch('/api/chat', { signal: controller.signal })
    ).rejects.toBe(reason)
  })

  it('still reports a network error when the signal was not aborted', async () => {
    const controller = new AbortController()
    const { client } = setup(async () => {
      throw new TypeError('Failed to fetch')
    })
    const err = await rejection(
      client.fetch('/api/chat', { signal: controller.signal })
    )
    expect(err.status).toBe(0)
  })
})

describe('createApiClient().json', () => {
  it('parses a 200 JSON body', async () => {
    const { client } = setup(async () =>
      Response.json({ chats: [{ id: 'c1' }] })
    )
    await expect(
      client.json<{ chats: { id: string }[] }>('/api/chats')
    ).resolves.toEqual({ chats: [{ id: 'c1' }] })
  })

  it('returns undefined for 204', async () => {
    const { client } = setup(async () => new Response(null, { status: 204 }))
    await expect(client.json('/api/chats/c1')).resolves.toBeUndefined()
  })

  it('throws an ApiError for a 401 JSON error', async () => {
    const { client } = setup(async () =>
      Response.json({ error: 'Authentication required' }, { status: 401 })
    )
    const err = await rejection(client.json('/api/chats'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('Authentication required')
    expect(err.retryable).toBe(false)
  })

  it('throws a retryable ApiError for a plain-text 503', async () => {
    const { client } = setup(
      async () => new Response('No enabled model is available', { status: 503 })
    )
    const err = await rejection(client.json('/api/chats'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(503)
    expect(err.message).toBe('No enabled model is available')
    expect(err.retryable).toBe(true)
  })

  it('propagates a network failure as a status-0 ApiError', async () => {
    const { client } = setup(async () => {
      throw new TypeError('Network request failed')
    })
    const err = await rejection(client.json('/api/chats'))
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(0)
  })
})

describe('createApiClient: a server 401', () => {
  function withHandler(answers: Array<'retry' | 'stop'>, responses: number[]) {
    const fetchImpl = vi.fn<typeof fetch>()
    for (const code of responses) {
      fetchImpl.mockResolvedValueOnce(new Response(null, { status: code }))
    }
    const tokens = [TOKEN, 'fake-fresh-token']
    const getToken = vi.fn(async () => tokens.shift() ?? null)
    const onUnauthorized = vi.fn(async () => answers.shift() ?? 'stop')
    const client = createApiClient({
      baseUrl: BASE,
      getToken,
      fetchImpl,
      onUnauthorized
    })
    return { client, fetchImpl, onUnauthorized }
  }

  it('goes to the handler, and is resent once with the fresh token', async () => {
    const { client, fetchImpl, onUnauthorized } = withHandler(
      ['retry'],
      [401, 200]
    )

    const res = await client.fetch('/api/chats')

    expect(res.status).toBe(200)
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('first')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]![0]).toBe(`${BASE}/api/chats`)
    expect(
      new Headers(fetchImpl.mock.calls[1]![1]?.headers).get('Authorization')
    ).toBe('Bearer fake-fresh-token')
  })

  it('json() rejects with the server’s 401 when the handler stops', async () => {
    const { client, onUnauthorized } = withHandler(['stop'], [401])
    const err = await rejection(client.json('/api/chats'))
    expect(err.status).toBe(401)
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('first')
  })

  it('signOutOn401:false leaves the 401 to the caller', async () => {
    const { client, fetchImpl, onUnauthorized } = withHandler(['retry'], [401])

    const err = await rejection(
      client.json('/api/account', { method: 'DELETE', signOutOn401: false })
    )

    expect(err.status).toBe(401)
    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a public request (auth: false) never goes to the handler', async () => {
    const { client, onUnauthorized } = withHandler(['retry'], [401])
    await expect(
      client.fetch('/api/x', { auth: false })
    ).resolves.toHaveProperty('status', 401)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('the option is not passed on to fetch', async () => {
    const { client, fetchImpl } = withHandler([], [200])
    await client.fetch('/api/chats', { signOutOn401: false })
    expect(fetchImpl.mock.calls[0]![1]).not.toHaveProperty('signOutOn401')
  })

  it('a network failure on the resend is a status-0 ApiError', async () => {
    const { client, fetchImpl } = withHandler(['retry'], [401])
    fetchImpl.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const err = await rejection(client.fetch('/api/chats'))
    expect(err.status).toBe(0)
  })
})

describe('isServerUnauthorized', () => {
  it('is a 401 the server answered, not the client’s own', () => {
    expect(isServerUnauthorized(new ApiError(401, 'Unauthorized'))).toBe(true)
    expect(isServerUnauthorized(new ApiError(401, SIGNED_OUT_MESSAGE))).toBe(
      false
    )
    expect(isServerUnauthorized(new ApiError(403, 'Forbidden'))).toBe(false)
    expect(isServerUnauthorized(new Error('Unauthorized'))).toBe(false)
  })
})
