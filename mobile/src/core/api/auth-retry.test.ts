import { describe, expect, it, vi } from 'vitest'

import { authRetryFetch, type UnauthorizedHandler } from '@/core/api/auth-retry'

const URL_ = 'https://ask.test.invalid/api/chats'

const status = (code: number) => new Response(null, { status: code })

function setup(
  responses: Response[],
  answer: 'retry' | 'stop' = 'retry',
  token: () => Promise<string | null> = async () => 'fake-fresh-token'
) {
  const fetchImpl = vi.fn<typeof fetch>()
  for (const res of responses) fetchImpl.mockResolvedValueOnce(res)
  const onUnauthorized = vi.fn<UnauthorizedHandler>(async () => answer)
  const getToken = vi.fn(token)
  const send = authRetryFetch({ fetchImpl, getToken, onUnauthorized })
  return { fetchImpl, onUnauthorized, getToken, send }
}

const authOf = (init: RequestInit | undefined) =>
  new Headers(init?.headers).get('Authorization')

describe('authRetryFetch', () => {
  it('retries once with the refreshed token', async () => {
    const { fetchImpl, onUnauthorized, send } = setup([
      status(401),
      status(200)
    ])

    const res = await send(URL_, {
      method: 'POST',
      headers: { Authorization: 'Bearer fake-stale-token', 'X-Keep': 'yes' },
      body: '{"a":1}'
    })

    expect(res.status).toBe(200)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).toHaveBeenCalledWith('first')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const [input, init] = fetchImpl.mock.calls[1]!
    expect(input).toBe(URL_)
    expect(authOf(init)).toBe('Bearer fake-fresh-token')
    expect(new Headers(init?.headers).get('X-Keep')).toBe('yes')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{"a":1}')
  })

  it('a second 401 after the resend goes to the handler as afterRetry and is returned', async () => {
    const second = status(401)
    const { fetchImpl, onUnauthorized, send } = setup([status(401), second])

    const res = await send(URL_, { headers: { Authorization: 'Bearer x' } })

    expect(res).toBe(second)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(onUnauthorized.mock.calls).toEqual([['first'], ['afterRetry']])
  })

  it('passes non-401 responses through', async () => {
    for (const code of [200, 204, 403, 500]) {
      const res = status(code)
      const { fetchImpl, onUnauthorized, send } = setup([res])
      await expect(send(URL_)).resolves.toBe(res)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(onUnauthorized).not.toHaveBeenCalled()
    }
  })

  it('does not retry a stream body', async () => {
    const first = status(401)
    const { fetchImpl, onUnauthorized, getToken, send } = setup([first])
    const body = new ReadableStream()

    const res = await send(URL_, { method: 'POST', body })

    expect(res).toBe(first)
    // The handler still refreshes, so the next request has a fresh token.
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('first')
    expect(getToken).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a stop leaves the 401 to the caller without resending', async () => {
    const first = status(401)
    const { fetchImpl, onUnauthorized, send } = setup([first], 'stop')

    await expect(send(URL_)).resolves.toBe(first)
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('first')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('never resends without a token', async () => {
    for (const token of [
      async () => null,
      async () => {
        throw new Error('storage failed')
      }
    ]) {
      const first = status(401)
      const { fetchImpl, onUnauthorized, send } = setup([first], 'retry', token)
      await expect(send(URL_)).resolves.toBe(first)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('first')
    }
  })

  it('resends a Request input with its own headers and the fresh token', async () => {
    const { fetchImpl, send } = setup([status(401), status(200)])
    const request = new Request(URL_, {
      headers: { Authorization: 'Bearer fake-stale-token', 'X-Keep': 'yes' }
    })

    await expect(send(request)).resolves.toHaveProperty('status', 200)
    const init = fetchImpl.mock.calls[1]![1]
    expect(authOf(init)).toBe('Bearer fake-fresh-token')
    expect(new Headers(init?.headers).get('X-Keep')).toBe('yes')
  })

  it('does not resend a Request whose body was used', async () => {
    const first = status(401)
    const { fetchImpl, onUnauthorized, send } = setup([first])
    const request = new Request(URL_, { method: 'POST', body: 'x' })
    await request.text()

    await expect(send(request)).resolves.toBe(first)
    expect(onUnauthorized).toHaveBeenCalledExactlyOnceWith('first')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a network failure on the resend rejects as fetch does', async () => {
    const { fetchImpl, send } = setup([status(401)])
    fetchImpl.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(send(URL_)).rejects.toThrow('Failed to fetch')
  })
})
