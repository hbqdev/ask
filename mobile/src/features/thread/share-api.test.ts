import { describe, expect, it, vi } from 'vitest'

import { createApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import {
  isShareCancelled,
  reasonOf,
  shareChat,
  unshareChat
} from '@/features/thread/share-api'

const BASE = 'https://ask.test.invalid'

function client(respond: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (..._args: Parameters<typeof fetch>) =>
    respond()
  )
  return {
    fetchImpl,
    client: createApiClient({
      baseUrl: BASE,
      getToken: async () => 'token',
      fetchImpl
    })
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

function request(fetchImpl: ReturnType<typeof client>['fetchImpl']) {
  const [url, init] = fetchImpl.mock.calls[0]
  return { url: String(url), init: init!, headers: new Headers(init!.headers) }
}

describe('shareChat', () => {
  it('POSTs to the chat’s share route with the bearer token and resolves with the link', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({
        ok: true,
        url: 'https://ask.example.invalid/search/c%2F1',
        visibility: 'public'
      })
    )

    await expect(shareChat(api, 'c/1')).resolves.toBe(
      'https://ask.example.invalid/search/c%2F1'
    )

    const { url, init, headers } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/chats/c%2F1/share`)
    expect(init.method).toBe('POST')
    expect(headers.get('Authorization')).toBe('Bearer token')
  })

  it('rejects with the server’s error and status', async () => {
    const { client: api } = client(() => json({ error: 'Not found' }, 404))
    const error = await shareChat(api, 'c1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, message: 'Not found' })
  })

  it('rejects when signed out', async () => {
    const { client: api } = client(() => json({ error: 'Unauthorized' }, 401))
    await expect(shareChat(api, 'c1')).rejects.toMatchObject({ status: 401 })
  })

  it('rejects an answer that carries no link', async () => {
    const { client: api } = client(() => json({ ok: true, url: '' }))
    await expect(shareChat(api, 'c1')).rejects.toThrow(
      'The server sent no link.'
    )
    const other = client(() => json({ ok: true }))
    await expect(shareChat(other.client, 'c1')).rejects.toThrow(
      'The server sent no link.'
    )
  })
})

describe('unshareChat', () => {
  it('DELETEs the chat’s share route with the bearer token', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ ok: true, visibility: 'private' })
    )

    await expect(unshareChat(api, 'c/1')).resolves.toBeUndefined()

    const { url, init, headers } = request(fetchImpl)
    expect(url).toBe(`${BASE}/api/chats/c%2F1/share`)
    expect(init.method).toBe('DELETE')
    expect(headers.get('Authorization')).toBe('Bearer token')
  })

  it('rejects with the server’s error and status', async () => {
    const { client: api } = client(() =>
      json({ error: 'Failed to unshare chat', retryable: true }, 500)
    )
    await expect(unshareChat(api, 'c1')).rejects.toMatchObject({
      status: 500,
      message: 'Failed to unshare chat',
      retryable: true
    })
  })
})

describe('reasonOf', () => {
  it('is an Error’s message, or the rejection itself as text', () => {
    expect(reasonOf(new Error('Not found'))).toBe('Not found')
    expect(reasonOf('boom')).toBe('boom')
    expect(reasonOf(undefined)).toBe('undefined')
  })
})

describe('isShareCancelled', () => {
  it('is true for the share sheet’s cancel, as an Error or a bare string', () => {
    expect(isShareCancelled(new Error('Share canceled'))).toBe(true)
    expect(isShareCancelled('User cancelled')).toBe(true)
  })

  it('is false for any other failure', () => {
    expect(isShareCancelled(new Error('unavailable'))).toBe(false)
    expect(isShareCancelled(undefined)).toBe(false)
  })
})
