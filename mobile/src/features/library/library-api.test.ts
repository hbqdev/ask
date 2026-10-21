import { describe, expect, it, vi } from 'vitest'

import { createApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import {
  clearAllChats,
  deleteChat,
  fetchChatsPage,
  renameChat,
  searchChats,
  touchChat
} from '@/features/library/library-api'

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

/** The URL and init of the nth request. */
function request(fetchImpl: ReturnType<typeof client>['fetchImpl'], n = 0) {
  const [url, init] = fetchImpl.mock.calls[n]
  return { url: new URL(String(url)), init }
}

const SERVER_CHAT = {
  id: 'c1',
  title: 'Tides',
  createdAt: '2026-10-20T10:00:00.000Z',
  userId: 'user-1',
  visibility: 'private',
  lastViewedAt: '2026-10-21T08:00:00.000Z'
}

describe('fetchChatsPage', () => {
  it('GETs /api/chats with offset, limit 30 by default, sort and withCount=1', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ chats: [], nextOffset: null, badges: {} })
    )
    await fetchChatsPage(api, { offset: 0, sort: 'recent', withCount: true })
    const { url, init } = request(fetchImpl)
    expect(url.origin + url.pathname).toBe(`${BASE}/api/chats`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      offset: '0',
      limit: '30',
      sort: 'recent',
      withCount: '1'
    })
    expect(init?.method ?? 'GET').toBe('GET')
  })

  it('sends the given limit and no withCount for a later page', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ chats: [], nextOffset: null, badges: {} })
    )
    await fetchChatsPage(api, { offset: 30, limit: 10, sort: 'title' })
    expect(Object.fromEntries(request(fetchImpl).url.searchParams)).toEqual({
      offset: '30',
      limit: '10',
      sort: 'title'
    })
  })

  it('maps the rows, merging each chat badge into its row', async () => {
    const { client: api } = client(() =>
      json({
        chats: [
          SERVER_CHAT,
          {
            ...SERVER_CHAT,
            id: 'c2',
            title: 'Untitled',
            lastViewedAt: null
          }
        ],
        nextOffset: 30,
        badges: { c1: { searchMode: 'quality', fileCount: 2 } },
        total: 41
      })
    )
    await expect(
      fetchChatsPage(api, { offset: 0, sort: 'recent', withCount: true })
    ).resolves.toEqual({
      chats: [
        {
          id: 'c1',
          title: 'Tides',
          createdAt: '2026-10-20T10:00:00.000Z',
          lastViewedAt: '2026-10-21T08:00:00.000Z',
          searchMode: 'quality',
          fileCount: 2
        },
        {
          id: 'c2',
          title: 'Untitled',
          createdAt: '2026-10-20T10:00:00.000Z',
          lastViewedAt: null,
          fileCount: 0
        }
      ],
      nextOffset: 30,
      total: 41
    })
  })

  it('leaves total out when the server sends none, and tolerates missing badges', async () => {
    const { client: api } = client(() =>
      json({ chats: [SERVER_CHAT], nextOffset: null })
    )
    const page = await fetchChatsPage(api, { offset: 0, sort: 'newest' })
    expect(page).toEqual({
      chats: [expect.objectContaining({ id: 'c1', fileCount: 0 })],
      nextOffset: null
    })
    expect('total' in page).toBe(false)
    expect('searchMode' in page.chats[0]).toBe(false)
  })

  it('rejects with an ApiError for a failed response', async () => {
    const { client: api } = client(() =>
      json({ chats: [], nextOffset: null, badges: {} }, 500)
    )
    const error = await fetchChatsPage(api, {
      offset: 0,
      sort: 'recent'
    }).catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(500)
  })
})

describe('searchChats', () => {
  it('GETs /api/chats/search with the encoded query and maps the hits', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({
        results: [
          {
            chatId: 'c1',
            chatTitle: 'Tides & moons',
            snippet: '…the moon pulls…',
            role: 'assistant',
            lastViewedAt: '2026-10-21T08:00:00.000Z'
          },
          {
            chatId: 'c2',
            chatTitle: 'Orbits',
            snippet: 'moon',
            role: 'user',
            lastViewedAt: null
          }
        ]
      })
    )
    await expect(searchChats(api, 'moon & tides')).resolves.toEqual([
      {
        chatId: 'c1',
        title: 'Tides & moons',
        snippet: '…the moon pulls…',
        lastViewedAt: '2026-10-21T08:00:00.000Z'
      },
      { chatId: 'c2', title: 'Orbits', snippet: 'moon', lastViewedAt: null }
    ])
    const { url } = request(fetchImpl)
    expect(url.pathname).toBe('/api/chats/search')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'moon & tides' })
  })

  it('asks for semantic recall with semantic=1 and passes the abort signal', async () => {
    const { client: api, fetchImpl } = client(() => json({ results: [] }))
    const controller = new AbortController()
    await searchChats(api, 'moon', {
      semantic: true,
      signal: controller.signal
    })
    const { url, init } = request(fetchImpl)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'moon',
      semantic: '1'
    })
    expect(init?.signal).toBe(controller.signal)
  })

  it('rejects with an ApiError when the search fails', async () => {
    const { client: api } = client(() => json({ results: [] }, 500))
    const error = await searchChats(api, 'moon').catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(500)
  })
})

describe('deleteChat', () => {
  it('DELETEs /api/chats/{id}, encoding the id', async () => {
    const { client: api, fetchImpl } = client(() => json({ ok: true }))
    await expect(deleteChat(api, 'a/b')).resolves.toBeUndefined()
    const { url, init } = request(fetchImpl)
    expect(url.pathname).toBe('/api/chats/a%2Fb')
    expect(init?.method).toBe('DELETE')
  })

  it('rejects with the server error as an ApiError', async () => {
    const { client: api } = client(() => json({ error: 'Not found' }, 404))
    const error = await deleteChat(api, 'gone').catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(404)
    expect(error.message).toBe('Not found')
  })
})

describe('renameChat', () => {
  it('PATCHes the title as JSON and resolves with the saved title', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ ok: true, title: 'Moon tides' })
    )
    await expect(renameChat(api, 'c1', 'Moon tides ')).resolves.toBe(
      'Moon tides'
    )
    const { url, init } = request(fetchImpl)
    expect(url.pathname).toBe('/api/chats/c1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'Moon tides ' })
    expect(new Headers(init?.headers).get('Content-Type')).toBe(
      'application/json'
    )
  })

  it.each([
    [400, 'Title is required'],
    [404, 'Not found']
  ])('maps a %i to an ApiError', async (status, message) => {
    const { client: api } = client(() => json({ error: message }, status))
    const error = await renameChat(api, 'c1', '').catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(status)
    expect(error.message).toBe(message)
    expect(error.retryable).toBe(false)
  })
})

describe('clearAllChats', () => {
  it('DELETEs /api/chats', async () => {
    const { client: api, fetchImpl } = client(() => json({ ok: true }))
    await expect(clearAllChats(api)).resolves.toBeUndefined()
    const { url, init } = request(fetchImpl)
    expect(url.pathname).toBe('/api/chats')
    expect(url.search).toBe('')
    expect(init?.method).toBe('DELETE')
  })

  it('rejects with a retryable ApiError on a 500', async () => {
    const { client: api } = client(() =>
      json({ error: 'Failed to clear chats', retryable: true }, 500)
    )
    const error = await clearAllChats(api).catch(e => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.retryable).toBe(true)
  })
})

describe('touchChat', () => {
  it('POSTs /api/chats/{id}/touch', async () => {
    const { client: api, fetchImpl } = client(
      () => new Response(null, { status: 204 })
    )
    await expect(touchChat(api, 'c1')).resolves.toBeUndefined()
    const { url, init } = request(fetchImpl)
    expect(url.pathname).toBe('/api/chats/c1/touch')
    expect(init?.method).toBe('POST')
  })

  it('swallows a failed response', async () => {
    const { client: api } = client(() => json({ error: 'boom' }, 500))
    await expect(touchChat(api, 'c1')).resolves.toBeUndefined()
  })

  it('swallows a network failure', async () => {
    const { client: api } = client(() => {
      throw new TypeError('Load failed')
    })
    await expect(touchChat(api, 'c1')).resolves.toBeUndefined()
  })

  it('swallows a missing token', async () => {
    const fetchImpl = vi.fn()
    const api = createApiClient({
      baseUrl: BASE,
      getToken: async () => null,
      fetchImpl
    })
    await expect(touchChat(api, 'c1')).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
