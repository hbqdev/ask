import { describe, expect, it, vi } from 'vitest'

import { createApiClient } from '@/core/api/client'
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

  it('omits Authorization when there is no token', async () => {
    const { client, fetchImpl } = setup(async () => new Response('ok'), null)
    await client.fetch('/api/chats')
    expect(sentHeaders(fetchImpl).has('Authorization')).toBe(false)
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
