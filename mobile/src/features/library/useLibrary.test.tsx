import { Preferences } from '@capacitor/preferences'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { emitChatsChanged } from '@/core/chats-events'
import type { ChatRow, ChatSort } from '@/features/library/library-api'
import {
  LIBRARY_CACHE_KEY,
  saveLibraryCache
} from '@/features/library/library-cache'
import {
  SEARCH_DEBOUNCE_MS,
  useChatSearch,
  useLibrary
} from '@/features/library/useLibrary'

// --- Mocks ------------------------------------------------------------------

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))

const prefsData = vi.hoisted(() => new Map<string, string>())
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefsData.get(key) ?? null
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefsData.set(key, value)
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      prefsData.delete(key)
    })
  }
}))

const BASE = 'https://ask.test.invalid'

// --- A fake Ask server: GET/DELETE /api/chats[/id], PATCH /api/chats/id -----

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const row = (n: number): ChatRow => ({
  id: `c${n}`,
  title: `Chat ${n}`,
  createdAt: new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString(),
  lastViewedAt: null,
  fileCount: 0
})

function fakeServer(count: number) {
  const chats = Array.from({ length: count }, (_, i) => row(i))
  /** Per-path overrides, consulted before the default behaviour. */
  const overrides: Array<{ match: RegExp; method: string; handle: Handler }> =
    []
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      const override = overrides.find(
        o => o.method === method && o.match.test(url.pathname)
      )
      if (override) return override.handle(url, init)
      if (method === 'GET' && url.pathname === '/api/chats') {
        const offset = Number(url.searchParams.get('offset'))
        const limit = Number(url.searchParams.get('limit'))
        const rows = chats.slice(offset, offset + limit)
        return json({
          chats: rows.map(c => ({
            ...c,
            userId: 'user-1',
            visibility: 'private'
          })),
          nextOffset: rows.length === limit ? offset + limit : null,
          badges: {},
          ...(url.searchParams.get('withCount') === '1'
            ? { total: chats.length }
            : {})
        })
      }
      const one = url.pathname.match(/^\/api\/chats\/([^/]+)$/)
      if (method === 'DELETE' && one) {
        const index = chats.findIndex(c => c.id === one[1])
        if (index < 0) return json({ error: 'Not found' }, 404)
        chats.splice(index, 1)
        return json({ ok: true })
      }
      if (method === 'PATCH' && one) {
        const { title } = JSON.parse(String(init.body)) as { title: string }
        const chat = chats.find(c => c.id === one[1])!
        chat.title = title.trim()
        return json({ ok: true, title: chat.title })
      }
      if (method === 'DELETE' && url.pathname === '/api/chats') {
        chats.splice(0)
        return json({ ok: true })
      }
      return json({ error: 'unexpected' }, 418)
    }
  )
  return {
    chats,
    fetchImpl,
    on(method: string, match: RegExp, handle: Handler) {
      overrides.unshift({ match, method, handle })
    },
    /** GET /api/chats requests made so far, as their query strings. */
    pageRequests() {
      return fetchImpl.mock.calls
        .map(([input, init]) => ({ url: new URL(String(input)), init }))
        .filter(
          ({ url, init }) =>
            url.pathname === '/api/chats' && (init?.method ?? 'GET') === 'GET'
        )
        .map(({ url }) => Object.fromEntries(url.searchParams))
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => (resolve = r))
  return { promise, resolve }
}

let server: ReturnType<typeof fakeServer>

function useServer(
  s: ReturnType<typeof fakeServer>,
  userId: string | null = 'user-1'
) {
  server = s
  vi.mocked(useApi).mockReturnValue({
    client: createApiClient({
      baseUrl: BASE,
      getToken: async () => 'token',
      fetchImpl: s.fetchImpl
    }),
    baseUrl: BASE,
    getToken: async () => 'token'
  } as Api)
  signIn(userId)
}

function signIn(userId: string | null) {
  vi.mocked(useAuth).mockReturnValue({
    session: userId ? { user: { id: userId } } : null
  } as unknown as Auth)
}

function renderLibrary(sort: ChatSort = 'recent') {
  return renderHook(({ sort }) => useLibrary({ sort }), {
    initialProps: { sort }
  })
}

const ids = (rows: ChatRow[]) => rows.map(c => c.id)

beforeEach(() => {
  prefsData.clear()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

// --- useLibrary ---------------------------------------------------------------

describe('useLibrary', () => {
  it('loads page 0 with the count, then is ready', async () => {
    useServer(fakeServer(45))
    const { result } = renderLibrary()
    expect(result.current.status).toBe('loading')
    expect(result.current.chats).toEqual([])
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(ids(result.current.chats)).toEqual(ids(server.chats.slice(0, 30)))
    expect(result.current.total).toBe(45)
    expect(result.current.hasMore).toBe(true)
    expect(server.pageRequests()).toEqual([
      { offset: '0', limit: '30', sort: 'recent', withCount: '1' }
    ])
  })

  it('shows the cache first, then server data', async () => {
    const s = fakeServer(3)
    const page = deferred<Response>()
    s.on('GET', /^\/api\/chats$/, () => page.promise)
    useServer(s)
    const cached = [{ ...row(9), title: 'Cached chat' }]
    await saveLibraryCache('user-1', {
      sort: 'recent',
      chats: cached,
      total: 9
    })

    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('refreshing'))
    expect(result.current.chats).toEqual(cached)
    expect(result.current.total).toBe(9)

    await act(async () =>
      page.resolve(
        json({
          chats: [row(0), row(1)],
          nextOffset: null,
          badges: {},
          total: 2
        })
      )
    )
    expect(result.current.status).toBe('ready')
    expect(ids(result.current.chats)).toEqual(['c0', 'c1'])
    expect(result.current.total).toBe(2)
    expect(result.current.hasMore).toBe(false)
  })

  it('saves the loaded rows to the cache for the signed-in user', async () => {
    useServer(fakeServer(2))
    const { result } = renderLibrary('title')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await waitFor(() => expect(prefsData.has(LIBRARY_CACHE_KEY)).toBe(true))
    const stored = JSON.parse(prefsData.get(LIBRARY_CACHE_KEY)!)
    expect(stored).toMatchObject({ userId: 'user-1', sort: 'title', total: 2 })
    expect(ids(stored.chats)).toEqual(['c0', 'c1'])
  })

  it('ignores a cache saved for another sort', async () => {
    const s = fakeServer(1)
    const page = deferred<Response>()
    s.on('GET', /^\/api\/chats$/, () => page.promise)
    useServer(s)
    await saveLibraryCache('user-1', { sort: 'title', chats: [row(9)] })
    const { result } = renderLibrary('recent')
    await waitFor(() => expect(Preferences.get).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.status).toBe('loading')
    expect(result.current.chats).toEqual([])
  })

  it('with no signed-in user it neither reads nor writes the cache, nor asks the server', async () => {
    useServer(fakeServer(2), null)
    await saveLibraryCache('user-1', { sort: 'recent', chats: [row(9)] })
    vi.mocked(Preferences.set).mockClear()
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.refresh())
    act(() => emitChatsChanged('created', 'c9'))
    await act(async () => {})
    expect(Preferences.get).not.toHaveBeenCalled()
    expect(Preferences.set).not.toHaveBeenCalled()
    expect(server.fetchImpl).not.toHaveBeenCalled()
    expect(result.current.chats).toEqual([])
    expect(result.current.hasMore).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it('never shows another user’s rows after the user changes, not even for one render', async () => {
    useServer(fakeServer(2))
    // Every render's output, with the user it was rendered for.
    const renders: Array<{ user?: string; ids: string[] }> = []
    const { result, rerender } = renderHook(
      ({ sort }) => {
        const library = useLibrary({ sort })
        renders.push({
          user: vi.mocked(useAuth).mock.results.at(-1)?.value.session?.user.id,
          ids: ids(library.chats)
        })
        return library
      },
      { initialProps: { sort: 'recent' as ChatSort } }
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(ids(result.current.chats)).toEqual(['c0', 'c1'])
    const page = deferred<Response>()
    server.on('GET', /^\/api\/chats$/, () => page.promise)
    signIn('user-2')
    rerender({ sort: 'recent' })
    expect(result.current.status).toBe('loading')
    await act(async () =>
      page.resolve(json({ chats: [row(7)], nextOffset: null, badges: {} }))
    )
    expect(ids(result.current.chats)).toEqual(['c7'])
    const user2 = renders.filter(r => r.user === 'user-2')
    expect(user2.length).toBeGreaterThan(0)
    for (const r of user2) expect(r.ids).not.toContain('c0')
    await waitFor(() =>
      expect(JSON.parse(prefsData.get(LIBRARY_CACHE_KEY)!).userId).toBe(
        'user-2'
      )
    )
  })

  it('reloads page 0 in the new order when the sort changes', async () => {
    useServer(fakeServer(2))
    const { result, rerender } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ sort: 'oldest' })
    expect(result.current.chats).toEqual([])
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(server.pageRequests().at(-1)).toMatchObject({
      offset: '0',
      sort: 'oldest'
    })
  })

  it('loadMore appends the next page', async () => {
    useServer(fakeServer(45))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.loadMore())
    expect(ids(result.current.chats)).toEqual(ids(server.chats))
    expect(result.current.hasMore).toBe(false)
    expect(server.pageRequests().at(-1)).toEqual({
      offset: '30',
      limit: '30',
      sort: 'recent'
    })
    // Nothing more to load: no request.
    await act(() => result.current.loadMore())
    expect(server.pageRequests()).toHaveLength(2)
  })

  it('loadMore asks once while a page is on its way', async () => {
    useServer(fakeServer(45))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      await Promise.all([result.current.loadMore(), result.current.loadMore()])
    })
    expect(server.pageRequests()).toHaveLength(2)
    expect(result.current.chats).toHaveLength(45)
  })

  it('next page after deleting a loaded row neither skips nor repeats', async () => {
    useServer(fakeServer(65))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => {
      await result.current.remove('c5')
      await result.current.remove('c20')
    })
    expect(result.current.total).toBe(63)
    await act(() => result.current.loadMore())
    expect(server.pageRequests().at(-1)).toMatchObject({ offset: '28' })
    await act(() => result.current.loadMore())

    const loaded = ids(result.current.chats)
    expect(new Set(loaded).size).toBe(loaded.length)
    expect(loaded).toEqual(ids(server.chats))
    expect(loaded).toHaveLength(63)
    expect(result.current.hasMore).toBe(false)
  })

  it('a remove that succeeds while a page is loading neither skips nor repeats', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))

    // The first page query runs on the server before the delete lands, and
    // its reply is held until the delete has succeeded.
    const held = deferred<void>()
    let calls = 0
    server.on('GET', /^\/api\/chats$/, async url => {
      const offset = Number(url.searchParams.get('offset'))
      const rows = server.chats.slice(offset, offset + 30)
      if (calls++ === 0) await held.promise
      return json({
        chats: rows,
        nextOffset: rows.length === 30 ? offset + 30 : null,
        badges: {}
      })
    })
    let more!: Promise<void>
    act(() => {
      more = result.current.loadMore()
    })
    await act(async () => {})
    expect(calls).toBe(1)
    await act(() => result.current.remove('c3').then(() => {}))
    held.resolve()
    await act(() => more)
    await act(() => result.current.loadMore())

    const loaded = ids(result.current.chats)
    expect(new Set(loaded).size).toBe(loaded.length)
    expect(loaded).toEqual(ids(server.chats.slice(0, 89)))
  })

  it('delete pending when the page is requested', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    // The server commits the delete at once but its reply is slow, so the
    // page query runs on the shifted list.
    const reply = deferred<void>()
    server.on('DELETE', /^\/api\/chats\/c3$/, async () => {
      server.chats.splice(3, 1)
      await reply.promise
      return json({ ok: true })
    })
    let removed!: Promise<boolean>
    let more!: Promise<void>
    act(() => {
      removed = result.current.remove('c3')
      more = result.current.loadMore()
    })
    await act(() => more)
    expect(server.pageRequests().at(-1)).toMatchObject({ offset: '29' })
    await act(async () => {
      reply.resolve()
      await removed
    })
    await act(() => result.current.loadMore())
    await act(() => result.current.loadMore())

    const loaded = ids(result.current.chats)
    expect(loaded).toContain('c30')
    expect(new Set(loaded).size).toBe(loaded.length)
    expect(loaded).toEqual(ids(server.chats))
  })

  it('delete pending when the page is requested, landing after the page query', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    // The page query runs first on the unshifted list; the delete lands and
    // succeeds while the page reply is still on its way.
    const commit = deferred<void>()
    server.on('DELETE', /^\/api\/chats\/c3$/, async () => {
      await commit.promise
      server.chats.splice(3, 1)
      return json({ ok: true })
    })
    const held = deferred<void>()
    let calls = 0
    server.on('GET', /^\/api\/chats$/, async url => {
      const offset = Number(url.searchParams.get('offset'))
      const rows = server.chats.slice(offset, offset + 30)
      if (calls++ === 0) await held.promise
      return json({
        chats: rows,
        nextOffset: rows.length === 30 ? offset + 30 : null,
        badges: {}
      })
    })
    let removed!: Promise<boolean>
    let more!: Promise<void>
    act(() => {
      removed = result.current.remove('c3')
      more = result.current.loadMore()
    })
    await act(async () => {})
    expect(calls).toBe(1)
    await act(async () => {
      commit.resolve()
      await removed
    })
    held.resolve()
    await act(() => more)
    await act(() => result.current.loadMore())
    await act(() => result.current.loadMore())

    const loaded = ids(result.current.chats)
    expect(new Set(loaded).size).toBe(loaded.length)
    expect(loaded).toEqual(ids(server.chats))
  })

  it('a delete that lands after a sort change does not skip on the new list', async () => {
    useServer(fakeServer(95))
    const { result, rerender } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const commit = deferred<void>()
    server.on('DELETE', /^\/api\/chats\/c3$/, async () => {
      await commit.promise
      server.chats.splice(3, 1)
      return json({ ok: true })
    })
    let removed!: Promise<boolean>
    act(() => {
      removed = result.current.remove('c3')
    })
    // The new sort's page 0 is read before the delete lands (the fake
    // server keeps one order for every sort).
    rerender({ sort: 'oldest' })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.chats).toHaveLength(29)
    await act(async () => {
      commit.resolve()
      await removed
    })
    await act(() => result.current.loadMore())
    expect(ids(result.current.chats)).toContain('c30')
  })

  it('loadMore during a refresh does not skip rows', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.loadMore())
    expect(result.current.chats).toHaveLength(60)

    const page0 = deferred<void>()
    let held = true
    server.on('GET', /^\/api\/chats$/, async url => {
      const offset = Number(url.searchParams.get('offset'))
      if (offset === 0 && held) {
        held = false
        await page0.promise
      }
      const rows = server.chats.slice(offset, offset + 30)
      return json({
        chats: rows,
        nextOffset: rows.length === 30 ? offset + 30 : null,
        badges: {},
        total: 95
      })
    })
    const requestsBefore = server.pageRequests().length
    let refreshed!: Promise<void>
    act(() => {
      refreshed = result.current.refresh()
    })
    expect(result.current.status).toBe('refreshing')
    // The list scrolled to the end while page 0 is on its way.
    await act(() => result.current.loadMore())
    await act(async () => {})
    // Only page 0 has gone out: no page at the old list's offset (60).
    expect(server.pageRequests().slice(requestsBefore)).toEqual([
      { offset: '0', limit: '30', sort: 'recent', withCount: '1' }
    ])

    await act(async () => {
      page0.resolve()
      await refreshed
    })
    // Page 0 landed; the wanted next page follows from its offset, 30.
    await waitFor(() => expect(result.current.chats).toHaveLength(60))
    expect(server.pageRequests().slice(requestsBefore)).toEqual([
      { offset: '0', limit: '30', sort: 'recent', withCount: '1' },
      { offset: '30', limit: '30', sort: 'recent' }
    ])
    expect(ids(result.current.chats)).toEqual(ids(server.chats.slice(0, 60)))
  })

  it('loadMore between page 0 landing and its commit does not page from the old list', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.loadMore())
    expect(result.current.chats).toHaveLength(60)
    const requestsBefore = server.pageRequests().length

    const page0 = deferred<void>()
    let held = true
    server.on('GET', /^\/api\/chats$/, async url => {
      const offset = Number(url.searchParams.get('offset'))
      if (offset === 0 && held) {
        held = false
        await page0.promise
      }
      const rows = server.chats.slice(offset, offset + 30)
      return json({
        chats: rows,
        nextOffset: rows.length === 30 ? offset + 30 : null,
        badges: {},
        total: 95
      })
    })
    let refreshed!: Promise<void>
    act(() => {
      refreshed = result.current.refresh()
    })
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    // Outside act, React commits page 0 in a later task, as on a device.
    env.IS_REACT_ACT_ENVIRONMENT = false
    try {
      page0.resolve()
      await refreshed
      // Page 0 is stored but not committed: the old 60 rows still show.
      expect(result.current.chats).toHaveLength(60)
      void result.current.loadMore()
      await waitFor(() => expect(result.current.chats).toHaveLength(60))
      await waitFor(() =>
        expect(server.pageRequests().slice(requestsBefore)).toHaveLength(2)
      )
      await waitFor(() =>
        expect(ids(result.current.chats)).toEqual(
          ids(server.chats.slice(0, 60))
        )
      )
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true
    }
    expect(server.pageRequests().slice(requestsBefore)).toEqual([
      { offset: '0', limit: '30', sort: 'recent', withCount: '1' },
      { offset: '30', limit: '30', sort: 'recent' }
    ])
  })

  it('a loadMore wanted during a refresh is dropped when a newer refresh replaces it', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const first = deferred<Response>()
    let calls = 0
    server.on('GET', /^\/api\/chats$/, () =>
      calls++ === 0
        ? first.promise
        : json({ chats: [row(0)], nextOffset: 30, badges: {}, total: 95 })
    )
    act(() => {
      void result.current.refresh()
    })
    await act(() => result.current.loadMore())
    await act(() => result.current.refresh())
    await act(async () => {
      first.resolve(json({ chats: [], nextOffset: null, badges: {} }))
    })
    await act(async () => {})
    // Only the two page-0 requests: no page that nobody asked for since.
    expect(calls).toBe(2)
    expect(ids(result.current.chats)).toEqual(['c0'])
  })

  it('a loadMore wanted during a refresh is dropped by clearAll', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const first = deferred<Response>()
    server.on('GET', /^\/api\/chats$/, () => first.promise)
    act(() => {
      void result.current.refresh()
    })
    await act(() => result.current.loadMore())
    await act(async () => {
      await result.current.clearAll()
    })
    const requests = server.pageRequests().length
    server.on('GET', /^\/api\/chats$/, () =>
      json({ chats: [row(0)], nextOffset: 30, badges: {}, total: 95 })
    )
    // A change event loads the new page 0; no wanted page follows it.
    act(() => emitChatsChanged('created', 'c0'))
    await waitFor(() => expect(ids(result.current.chats)).toEqual(['c0']))
    await act(async () => {})
    expect(server.pageRequests()).toHaveLength(requests + 1)
  })

  it('a loadMore asked for during a refresh that fails is not run', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const page0 = deferred<Response>()
    server.on('GET', /^\/api\/chats$/, () => page0.promise)
    let refreshed!: Promise<void>
    act(() => {
      refreshed = result.current.refresh()
    })
    await act(() => result.current.loadMore())
    await act(async () => {
      page0.resolve(json({ error: 'down' }, 503))
      await refreshed
    })
    await act(async () => {})
    expect(result.current.status).toBe('error')
    expect(server.pageRequests()).toHaveLength(2)
    expect(result.current.chats).toHaveLength(30)
    // Nor later, when a refresh succeeds.
    server.on('GET', /^\/api\/chats$/, () =>
      json({ chats: [row(0)], nextOffset: 30, badges: {}, total: 95 })
    )
    await act(() => result.current.refresh())
    await act(async () => {})
    expect(server.pageRequests()).toHaveLength(3)
  })

  it('clearAll during a refresh does not leave loadMore blocked', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const page0 = deferred<Response>()
    server.on('GET', /^\/api\/chats$/, () => page0.promise)
    act(() => {
      void result.current.refresh()
    })
    await act(async () => {
      await result.current.clearAll()
    })
    expect(result.current.chats).toEqual([])
    // A list loaded after the clear can page again.
    server.chats.push(...Array.from({ length: 45 }, (_, i) => row(200 + i)))
    server.on('GET', /^\/api\/chats$/, url => {
      const offset = Number(url.searchParams.get('offset'))
      const rows = server.chats.slice(offset, offset + 30)
      return json({
        chats: rows,
        nextOffset: rows.length === 30 ? offset + 30 : null,
        badges: {}
      })
    })
    await act(() => result.current.refresh())
    await act(() => result.current.loadMore())
    expect(result.current.chats).toHaveLength(45)
  })

  it('a page dropped by a refresh does not block the next loadMore', async () => {
    useServer(fakeServer(45))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const stale = deferred<Response>()
    let calls = 0
    server.on('GET', /^\/api\/chats$/, url => {
      const offset = Number(url.searchParams.get('offset'))
      if (offset === 30 && calls++ === 0) return stale.promise
      const rows = server.chats.slice(offset, offset + 30)
      return json({
        chats: rows,
        nextOffset: rows.length === 30 ? offset + 30 : null,
        badges: {},
        total: 45
      })
    })
    let first!: Promise<void>
    act(() => {
      first = result.current.loadMore()
    })
    await act(() => result.current.refresh())
    // The stale page is still on its way; a new loadMore must still run.
    await act(() => result.current.loadMore())
    expect(result.current.chats).toHaveLength(45)
    await act(async () => {
      stale.resolve(json({ chats: [], nextOffset: null, badges: {} }))
      await first
    })
    expect(result.current.chats).toHaveLength(45)
  })

  it('an optimistic remove is restored on failure', async () => {
    useServer(fakeServer(3))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const reply = deferred<Response>()
    server.on('DELETE', /^\/api\/chats\/c1$/, () => reply.promise)

    let removed!: Promise<boolean>
    act(() => {
      removed = result.current.remove('c1')
    })
    expect(ids(result.current.chats)).toEqual(['c0', 'c2'])
    expect(result.current.total).toBe(2)

    await act(async () => {
      reply.resolve(
        json({ error: 'Failed to delete chat', retryable: true }, 500)
      )
      await expect(removed).resolves.toBe(false)
    })
    expect(ids(result.current.chats)).toEqual(['c0', 'c1', 'c2'])
    expect(result.current.total).toBe(3)
    expect(result.current.error).toBe('Failed to delete chat')
  })

  it('a failed remove never puts the row into another user’s list', async () => {
    useServer(fakeServer(3))
    const { result, rerender } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const reply = deferred<Response>()
    server.on('DELETE', /^\/api\/chats\/c1$/, () => reply.promise)
    let removed!: Promise<boolean>
    act(() => {
      removed = result.current.remove('c1')
    })
    server.on('GET', /^\/api\/chats$/, () =>
      json({ chats: [row(7)], nextOffset: null, badges: {} })
    )
    signIn('user-2')
    rerender({ sort: 'recent' })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      reply.resolve(
        json({ error: 'Failed to delete chat', retryable: true }, 500)
      )
      await expect(removed).resolves.toBe(false)
    })
    expect(ids(result.current.chats)).toEqual(['c7'])
    expect(result.current.error).toBe('Failed to delete chat')
  })

  it('counts a chat already gone on the server (404) as removed', async () => {
    useServer(fakeServer(3))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.chats.splice(1, 1)
    let ok!: boolean
    await act(async () => {
      ok = await result.current.remove('c1')
    })
    expect(ok).toBe(true)
    expect(ids(result.current.chats)).toEqual(['c0', 'c2'])
    expect(result.current.error).toBeUndefined()
  })

  it('remove of a row that is not loaded does nothing', async () => {
    useServer(fakeServer(3))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let ok!: boolean
    await act(async () => {
      ok = await result.current.remove('nope')
    })
    expect(ok).toBe(false)
    expect(server.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps a removed row out of a refresh that raced the delete', async () => {
    useServer(fakeServer(3))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const reply = deferred<Response>()
    server.on('DELETE', /^\/api\/chats\/c1$/, () => reply.promise)
    let removed!: Promise<boolean>
    act(() => {
      removed = result.current.remove('c1')
    })
    // The server still lists c1 until the delete lands.
    await act(() => result.current.refresh())
    expect(ids(result.current.chats)).toEqual(['c0', 'c2'])
    await act(async () => {
      reply.resolve(json({ ok: true }))
      await removed
    })
    expect(ids(result.current.chats)).toEqual(['c0', 'c2'])
  })

  it('rename shows the new title at once and keeps the saved one', async () => {
    useServer(fakeServer(2))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const reply = deferred<Response>()
    server.on('PATCH', /^\/api\/chats\/c1$/, () => reply.promise)
    let renamed!: Promise<boolean>
    act(() => {
      renamed = result.current.rename('c1', '  Moon tides  ')
    })
    expect(result.current.chats[1].title).toBe('Moon tides')
    await act(async () => {
      reply.resolve(json({ ok: true, title: 'Moon tides (saved)' }))
      await expect(renamed).resolves.toBe(true)
    })
    expect(result.current.chats[1].title).toBe('Moon tides (saved)')
  })

  it('rename reverts on failure', async () => {
    useServer(fakeServer(2))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.on('PATCH', /^\/api\/chats\/c1$/, () =>
      json({ error: 'Not found' }, 404)
    )
    let ok!: boolean
    await act(async () => {
      ok = await result.current.rename('c1', 'Moon tides')
    })
    expect(ok).toBe(false)
    expect(result.current.chats[1].title).toBe('Chat 1')
    expect(result.current.error).toBe('Not found')
  })

  it('rename blocks an empty title without asking the server', async () => {
    useServer(fakeServer(2))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let ok!: boolean
    await act(async () => {
      ok = await result.current.rename('c1', '   ')
    })
    expect(ok).toBe(false)
    expect(result.current.chats[1].title).toBe('Chat 1')
    expect(result.current.error).toBe('Title is required')
    expect(server.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rename of a row that is not loaded does nothing', async () => {
    useServer(fakeServer(2))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let ok!: boolean
    await act(async () => {
      ok = await result.current.rename('nope', 'Title')
    })
    expect(ok).toBe(false)
    expect(server.fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('a changed event re-fetches page 0', async () => {
    useServer(fakeServer(2))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.chats.unshift({ ...row(50), title: 'Brand new' })
    act(() => emitChatsChanged('created', 'c50'))
    expect(result.current.status).toBe('refreshing')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(ids(result.current.chats)).toEqual(['c50', 'c0', 'c1'])
    expect(server.pageRequests()).toHaveLength(2)
    expect(server.pageRequests()[1]).toMatchObject({
      offset: '0',
      withCount: '1'
    })
  })

  it('a cleared event re-fetches page 0', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.loadMore())
    server.chats.splice(0)

    act(() => emitChatsChanged('cleared'))

    await waitFor(() => expect(result.current.chats).toEqual([]))
    expect(result.current.total).toBe(0)
    expect(result.current.hasMore).toBe(false)
    expect(server.pageRequests().at(-1)).toMatchObject({ offset: '0' })
  })

  it('stops listening for changes once unmounted', async () => {
    useServer(fakeServer(2))
    const { result, unmount } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    unmount()
    emitChatsChanged('created', 'c0')
    expect(server.pageRequests()).toHaveLength(1)
  })

  describe('a chat changed in its thread', () => {
    const NOW = new Date(Date.UTC(2026, 9, 21, 12))

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
    })

    /** Three pages loaded (90 of 95 rows), more to come. */
    async function threePages(sort: ChatSort = 'recent') {
      useServer(fakeServer(95))
      const hook = renderLibrary(sort)
      await waitFor(() => expect(hook.result.current.status).toBe('ready'))
      await act(() => hook.result.current.loadMore())
      await act(() => hook.result.current.loadMore())
      expect(hook.result.current.chats).toHaveLength(90)
      expect(hook.result.current.hasMore).toBe(true)
      return hook
    }

    it('a follow-up from page 3 keeps loaded pages', async () => {
      const { result } = await threePages()
      const before = ids(result.current.chats)

      act(() => emitChatsChanged('updated', 'c75'))

      expect(ids(result.current.chats)).toEqual([
        'c75',
        ...before.filter(id => id !== 'c75')
      ])
      expect(result.current.chats[0].lastViewedAt).toBe(NOW.toISOString())
      expect(result.current.status).toBe('ready')
      expect(result.current.hasMore).toBe(true)
      await act(async () => {})
      // No page 0 again: the loaded pages (and the scroll) stay.
      expect(server.pageRequests()).toHaveLength(3)
    })

    it('a follow-up in title sort only updates lastViewedAt', async () => {
      const { result } = await threePages('title')
      const before = ids(result.current.chats)

      act(() => emitChatsChanged('updated', 'c75'))

      expect(ids(result.current.chats)).toEqual(before)
      expect(result.current.chats.find(c => c.id === 'c75')!.lastViewedAt).toBe(
        NOW.toISOString()
      )
      await act(async () => {})
      expect(server.pageRequests()).toHaveLength(3)
    })

    it('a follow-up in a chat that is not loaded fetches nothing', async () => {
      useServer(fakeServer(95))
      const { result } = renderLibrary()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const shown = result.current.chats

      act(() => emitChatsChanged('updated', 'c80'))
      act(() => emitChatsChanged('updated'))

      expect(result.current.chats).toBe(shown)
      await act(async () => {})
      expect(server.pageRequests()).toHaveLength(1)
    })

    it('a rename shows the new title in place, keeping loaded pages', async () => {
      const { result } = await threePages()
      const before = ids(result.current.chats)

      act(() => emitChatsChanged('renamed', 'c45', { title: 'New name' }))

      expect(ids(result.current.chats)).toEqual(before)
      expect(result.current.chats.find(c => c.id === 'c45')!.title).toBe(
        'New name'
      )
      await act(async () => {})
      expect(server.pageRequests()).toHaveLength(3)
      await waitFor(() =>
        expect(
          JSON.parse(prefsData.get(LIBRARY_CACHE_KEY)!).chats.find(
            (c: ChatRow) => c.id === 'c45'
          ).title
        ).toBe('New name')
      )
    })

    it('a rename of a chat that is not loaded, or without a title, fetches nothing', async () => {
      useServer(fakeServer(95))
      const { result } = renderLibrary()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const shown = result.current.chats

      act(() => emitChatsChanged('renamed', 'c80', { title: 'New name' }))
      act(() => emitChatsChanged('renamed', 'c1'))
      act(() => emitChatsChanged('renamed', undefined, { title: 'x' }))

      expect(result.current.chats).toBe(shown)
      await act(async () => {})
      expect(server.pageRequests()).toHaveLength(1)
    })

    it('a delete removes a loaded chat in place, and the next page neither skips nor repeats', async () => {
      const { result } = await threePages()
      // Deleted on the server by the thread's menu, then told.
      server.chats.splice(
        server.chats.findIndex(c => c.id === 'c40'),
        1
      )

      act(() => emitChatsChanged('deleted', 'c40'))

      expect(ids(result.current.chats)).not.toContain('c40')
      expect(result.current.chats).toHaveLength(89)
      expect(result.current.total).toBe(94)
      await act(async () => {})
      expect(server.pageRequests()).toHaveLength(3)

      await act(() => result.current.loadMore())
      expect(server.pageRequests().at(-1)).toMatchObject({ offset: '89' })
      const loaded = ids(result.current.chats)
      expect(new Set(loaded).size).toBe(loaded.length)
      expect(loaded).toEqual(ids(server.chats))
      expect(result.current.hasMore).toBe(false)
    })

    it('a delete of a chat that is not loaded fetches nothing', async () => {
      useServer(fakeServer(95))
      const { result } = renderLibrary()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const shown = result.current.chats

      act(() => emitChatsChanged('deleted', 'c80'))
      act(() => emitChatsChanged('deleted'))

      expect(result.current.chats).toBe(shown)
      expect(result.current.total).toBe(95)
      await act(async () => {})
      expect(server.pageRequests()).toHaveLength(1)
    })

    it('a deleted chat stays out of a refresh that raced the delete', async () => {
      const { result } = await threePages()
      // The refresh read page 0 before the delete landed on the server.
      const stale = server.chats.slice(0, 30)
      server.on('GET', /^\/api\/chats$/, () =>
        json({ chats: stale, nextOffset: 30, badges: {}, total: 95 })
      )

      act(() => emitChatsChanged('deleted', 'c3'))
      await act(() => result.current.refresh())

      expect(ids(result.current.chats)).not.toContain('c3')
    })
  })

  describe('a chat viewed elsewhere', () => {
    const NOW = new Date(Date.UTC(2026, 9, 21, 12))

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
    })

    it('viewing a chat moves it to the top in recent sort without refetching', async () => {
      useServer(fakeServer(95))
      const { result } = renderLibrary('recent')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.loadMore())
      expect(result.current.chats).toHaveLength(60)
      const before = ids(result.current.chats)

      act(() => emitChatsChanged('viewed', 'c40'))

      expect(ids(result.current.chats)).toEqual([
        'c40',
        ...before.filter(id => id !== 'c40')
      ])
      expect(result.current.chats[0].lastViewedAt).toBe(NOW.toISOString())
      expect(result.current.status).toBe('ready')
      expect(result.current.hasMore).toBe(true)
      await act(async () => {})
      // No page 0 again: the loaded pages (and the scroll) stay.
      expect(server.pageRequests()).toHaveLength(2)
      // The cache holds the new order.
      await waitFor(() =>
        expect(
          JSON.parse(prefsData.get(LIBRARY_CACHE_KEY)!).chats[0]
        ).toMatchObject({ id: 'c40', lastViewedAt: NOW.toISOString() })
      )
    })

    it('viewing in title sort only updates lastViewedAt', async () => {
      useServer(fakeServer(3))
      const { result } = renderLibrary('title')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const before = ids(result.current.chats)

      act(() => emitChatsChanged('viewed', 'c1'))

      expect(ids(result.current.chats)).toEqual(before)
      expect(result.current.chats.find(c => c.id === 'c1')!.lastViewedAt).toBe(
        NOW.toISOString()
      )
      expect(
        result.current.chats.filter(c => c.id !== 'c1').map(c => c.lastViewedAt)
      ).toEqual([null, null])
      await act(async () => {})
      expect(server.pageRequests()).toHaveLength(1)
    })

    it('an unloaded chat viewed does nothing', async () => {
      useServer(fakeServer(95))
      const { result } = renderLibrary('recent')
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const shown = result.current.chats

      act(() => emitChatsChanged('viewed', 'c80'))
      act(() => emitChatsChanged('viewed'))

      expect(result.current.chats).toBe(shown)
      await act(async () => {})
      expect(server.pageRequests()).toHaveLength(1)
    })
  })

  it('the error status keeps the rows', async () => {
    useServer(fakeServer(2))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.on('GET', /^\/api\/chats$/, () => {
      throw new TypeError('Load failed')
    })
    await act(() => result.current.refresh())
    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('Network error. Check your connection.')
    expect(ids(result.current.chats)).toEqual(['c0', 'c1'])
  })

  it('shows the cached rows with the error when the first load fails before the cache is read', async () => {
    const s = fakeServer(0)
    s.on('GET', /^\/api\/chats$/, () => json({ error: 'down' }, 503))
    useServer(s)
    await saveLibraryCache('user-1', { sort: 'recent', chats: [row(4)] })
    const read = deferred<void>()
    const get = vi.mocked(Preferences.get)
    const realGet = get.getMockImplementation()!
    get.mockImplementationOnce(async options => {
      await read.promise
      return realGet(options)
    })
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.chats).toEqual([])
    await act(async () => read.resolve())
    expect(result.current.status).toBe('error')
    expect(ids(result.current.chats)).toEqual(['c4'])
    expect(result.current.error).toBe('down')
  })

  it('after a failed refresh, loadMore still pages from the list shown', async () => {
    useServer(fakeServer(95))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.on('GET', /^\/api\/chats$/, () => json({ error: 'down' }, 503))
    await act(() => result.current.refresh())
    expect(result.current.status).toBe('error')
    server.on('GET', /^\/api\/chats$/, url => {
      const offset = Number(url.searchParams.get('offset'))
      const rows = server.chats.slice(offset, offset + 30)
      return json({ chats: rows, nextOffset: offset + 30, badges: {} })
    })
    await act(() => result.current.loadMore())
    expect(server.pageRequests().at(-1)).toMatchObject({ offset: '30' })
    expect(ids(result.current.chats)).toEqual(ids(server.chats.slice(0, 60)))
    expect(result.current.status).toBe('ready')
  })

  it('a failed loadMore keeps the rows and can be retried', async () => {
    useServer(fakeServer(45))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.on('GET', /^\/api\/chats$/, () => json({ error: 'busy' }, 503))
    await act(() => result.current.loadMore())
    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('busy')
    expect(result.current.chats).toHaveLength(30)
    expect(result.current.hasMore).toBe(true)
  })

  it('drops a page that arrives after a refresh started', async () => {
    useServer(fakeServer(45))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const page = deferred<Response>()
    server.on('GET', /^\/api\/chats$/, url =>
      url.searchParams.get('offset') === '30'
        ? page.promise
        : json({ chats: [row(0)], nextOffset: null, badges: {}, total: 1 })
    )
    let more!: Promise<void>
    act(() => {
      more = result.current.loadMore()
    })
    await act(() => result.current.refresh())
    await act(async () => {
      page.resolve(json({ chats: [row(31)], nextOffset: null, badges: {} }))
      await more
    })
    expect(ids(result.current.chats)).toEqual(['c0'])
  })

  it('clearAll empties the list and the count', async () => {
    useServer(fakeServer(3))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let ok!: boolean
    await act(async () => {
      ok = await result.current.clearAll()
    })
    expect(ok).toBe(true)
    expect(result.current.chats).toEqual([])
    expect(result.current.total).toBe(0)
    expect(result.current.hasMore).toBe(false)
    await waitFor(() =>
      expect(JSON.parse(prefsData.get(LIBRARY_CACHE_KEY)!).chats).toEqual([])
    )
  })

  it('a failed clearAll keeps the rows and sets the error', async () => {
    useServer(fakeServer(3))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.on('DELETE', /^\/api\/chats$/, () =>
      json({ error: 'Failed to clear chats', retryable: true }, 500)
    )
    let ok!: boolean
    await act(async () => {
      ok = await result.current.clearAll()
    })
    expect(ok).toBe(false)
    expect(result.current.chats).toHaveLength(3)
    expect(result.current.error).toBe('Failed to clear chats')
  })

  it('refresh clears an earlier error', async () => {
    useServer(fakeServer(2))
    const { result } = renderLibrary()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      await result.current.rename('c0', ' ')
    })
    expect(result.current.error).toBe('Title is required')
    await act(() => result.current.refresh())
    expect(result.current.error).toBeUndefined()
    expect(result.current.status).toBe('ready')
  })
})

// --- useChatSearch -------------------------------------------------------------

function searchServer() {
  const requests: Array<{
    q: string
    semantic: boolean
    signal?: AbortSignal | null
    reply: (titles: string[]) => void
    fail: () => void
  }> = []
  const fetchImpl = vi.fn(
    (input: RequestInfo | URL, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        const url = new URL(String(input))
        requests.push({
          q: url.searchParams.get('q') ?? '',
          semantic: url.searchParams.get('semantic') === '1',
          signal: init.signal,
          reply: titles =>
            resolve(
              json({
                results: titles.map((title, i) => ({
                  chatId: `${title}-${i}`,
                  chatTitle: title,
                  snippet: title,
                  role: 'user',
                  lastViewedAt: null
                }))
              })
            ),
          fail: () => reject(new TypeError('Load failed'))
        })
      })
  )
  vi.mocked(useApi).mockReturnValue({
    client: createApiClient({
      baseUrl: BASE,
      getToken: async () => 'token',
      fetchImpl
    }),
    baseUrl: BASE,
    getToken: async () => 'token'
  } as Api)
  return { requests, fetchImpl }
}

/** Lets the debounce run out and the request reach the fake server. */
async function settle(ms = SEARCH_DEBOUNCE_MS) {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

describe('useChatSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('debounces typing into one keyword search 300 ms after the last key', async () => {
    const { requests } = searchServer()
    const { result } = renderHook(() => useChatSearch())
    expect(SEARCH_DEBOUNCE_MS).toBe(300)
    expect(result.current.status).toBe('idle')

    act(() => result.current.setQuery('m'))
    await settle(200)
    act(() => result.current.setQuery('mo'))
    await settle(200)
    act(() => result.current.setQuery('moon'))
    expect(result.current.query).toBe('moon')
    await settle(299)
    expect(requests).toHaveLength(0)
    await settle(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ q: 'moon', semantic: false })
    expect(result.current.status).toBe('searching')

    await act(async () => requests[0].reply(['Moon tides']))
    expect(result.current.status).toBe('ready')
    expect(result.current.results).toEqual([
      {
        chatId: 'Moon tides-0',
        title: 'Moon tides',
        snippet: 'Moon tides',
        lastViewedAt: null
      }
    ])
  })

  it('search is latest-wins', async () => {
    const { requests } = searchServer()
    const { result } = renderHook(() => useChatSearch())
    act(() => result.current.setQuery('moo'))
    await settle()
    act(() => result.current.setQuery('moon'))
    await settle()
    expect(requests.map(r => r.q)).toEqual(['moo', 'moon'])
    expect(requests[0].signal?.aborted).toBe(true)

    // The newer answer arrives first; the slow first one resolves last.
    await act(async () => requests[1].reply(['Moon']))
    await act(async () => requests[0].reply(['Moo (stale)']))
    expect(result.current.results.map(r => r.title)).toEqual(['Moon'])
    expect(result.current.status).toBe('ready')
  })

  it('submit searches at once with semantic recall', async () => {
    const { requests } = searchServer()
    const { result } = renderHook(() => useChatSearch())
    act(() => result.current.setQuery('  tides  '))
    act(() => result.current.submit())
    expect(result.current.status).toBe('searching')
    await act(async () => {})
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ q: 'tides', semantic: true })
    // The pending keyword search was cancelled.
    await settle()
    expect(requests).toHaveLength(1)
  })

  it('an empty query clears the results and cancels the search', async () => {
    const { requests } = searchServer()
    const { result } = renderHook(() => useChatSearch())
    act(() => result.current.setQuery('moon'))
    await settle()
    await act(async () => requests[0].reply(['Moon']))
    expect(result.current.results).toHaveLength(1)

    act(() => result.current.setQuery('mo'))
    await settle()
    act(() => result.current.setQuery('   '))
    expect(requests[1].signal?.aborted).toBe(true)
    expect(result.current.results).toEqual([])
    expect(result.current.status).toBe('idle')
    await act(async () => requests[1].reply(['Mo (stale)']))
    expect(result.current.results).toEqual([])
  })

  it('submit with an empty query clears without a request', async () => {
    const { requests } = searchServer()
    const { result } = renderHook(() => useChatSearch())
    act(() => result.current.setQuery(' '))
    act(() => result.current.submit())
    await settle()
    expect(requests).toHaveLength(0)
    expect(result.current.status).toBe('idle')
  })

  it('a failed search is an error, keeping the earlier results', async () => {
    const { requests } = searchServer()
    const { result } = renderHook(() => useChatSearch())
    act(() => result.current.setQuery('moon'))
    await settle()
    await act(async () => requests[0].reply(['Moon']))
    act(() => result.current.submit())
    await act(async () => {})
    await act(async () => requests[1].fail())
    expect(result.current.status).toBe('error')
    expect(result.current.results.map(r => r.title)).toEqual(['Moon'])
  })

  it('cancels a pending search when unmounted', async () => {
    const { requests } = searchServer()
    const { result, unmount } = renderHook(() => useChatSearch())
    act(() => result.current.setQuery('moon'))
    await settle()
    act(() => result.current.setQuery('moons'))
    unmount()
    expect(requests[0].signal?.aborted).toBe(true)
    await settle()
    expect(requests).toHaveLength(1)
  })
})
