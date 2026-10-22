import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { NOTES_UNAVAILABLE, type Note } from '@/features/notes/notes-api'
import {
  addNote,
  dropNote,
  getNotesCache,
  isMessageSaved,
  resetNotesCache,
  setNotesCache
} from '@/features/notes/notes-cache'
import { saveAnswerToNotes, useNotes } from '@/features/notes/useNotes'

vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))

const BASE = 'https://ask.test.invalid'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

// Newest update first, as the server orders them.
const note = (n: number, over: Partial<Note> = {}): Note => ({
  id: `n${n}`,
  title: `Note ${n}`,
  content: `Content ${n}`,
  chatId: null,
  sourceMessageId: null,
  createdAt: new Date(Date.UTC(2026, 9, 21) - n * 60_000).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 21) - n * 60_000).toISOString(),
  ...over
})

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

/** A fake Ask server: GET /api/notes (keyset pages), DELETE /api/notes/id. */
function fakeServer(count: number, pageSize = 25) {
  const notes = Array.from({ length: count }, (_, i) => note(i))
  const overrides: Array<{ match: RegExp; method: string; handle: Handler }> =
    []
  /** GET /api/notes: the page after `cursorId`, newest first. */
  const page = (url: URL) => {
    const after = url.searchParams.get('cursorId')
    const start = after ? notes.findIndex(n => n.id === after) + 1 : 0
    const rows = notes.slice(start, start + pageSize)
    const hasMore = start + pageSize < notes.length
    const last = rows.at(-1)
    return json({
      notes: rows,
      nextCursor:
        hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
      hasMore
    })
  }
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      const override = overrides.find(
        o => o.method === method && o.match.test(url.pathname)
      )
      if (override) return override.handle(url, init)
      if (method === 'GET' && url.pathname === '/api/notes') return page(url)
      const one = url.pathname.match(/^\/api\/notes\/([^/]+)$/)
      if (method === 'DELETE' && one) {
        const index = notes.findIndex(n => n.id === one[1])
        if (index < 0) return json({ error: 'Not found' }, 404)
        notes.splice(index, 1)
        return json({ ok: true })
      }
      if (method === 'POST' && url.pathname === '/api/notes') {
        const body = JSON.parse(String(init.body)) as Partial<Note>
        const saved = note(99, {
          content: body.content,
          chatId: body.chatId ?? null,
          sourceMessageId: body.sourceMessageId ?? null
        })
        return json({ note: saved }, 201)
      }
      return json({ error: 'unexpected' }, 418)
    }
  )
  return {
    notes,
    fetchImpl,
    page,
    on(method: string, match: RegExp, handle: Handler) {
      overrides.unshift({ match, method, handle })
    },
    /** The GET /api/notes requests so far, as their cursor ids. */
    pages() {
      return fetchImpl.mock.calls
        .map(([input, init]) => ({ url: new URL(String(input)), init }))
        .filter(
          r =>
            (r.init?.method ?? 'GET') === 'GET' &&
            r.url.pathname === '/api/notes'
        )
        .map(r => r.url.searchParams.get('cursorId'))
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

let userId: string | undefined = 'user-1'

function mount(server: ReturnType<typeof fakeServer>) {
  const client = createApiClient({
    baseUrl: BASE,
    getToken: async () => 'token',
    fetchImpl: server.fetchImpl
  })
  vi.mocked(useApi).mockReturnValue({ client, baseUrl: BASE } as Api)
  vi.mocked(useAuth).mockImplementation(
    () =>
      ({
        session: userId ? { user: { id: userId } } : null
      }) as unknown as Auth
  )
  return { client, ...renderHook(() => useNotes()) }
}

beforeEach(() => {
  userId = 'user-1'
  resetNotesCache()
  vi.clearAllMocks()
})

describe('useNotes', () => {
  it('loads the first page, then is ready with more to come', async () => {
    const server = fakeServer(30)
    const { result } = mount(server)
    expect(result.current.status).toBe('loading')
    expect(result.current.notes).toEqual([])
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.notes.map(n => n.id)).toEqual(
      server.notes.slice(0, 25).map(n => n.id)
    )
    expect(result.current.hasMore).toBe(true)
    expect(result.current.error).toBeUndefined()
  })

  it('pages on by the next cursor until the last page', async () => {
    const server = fakeServer(30)
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(() => result.current.loadMore())
    expect(result.current.notes).toHaveLength(30)
    expect(result.current.hasMore).toBe(false)
    expect(server.pages()).toEqual([null, 'n24'])
    // No more pages: nothing more is asked for.
    await act(() => result.current.loadMore())
    expect(server.pages()).toHaveLength(2)
  })

  it('asks for one page at a time', async () => {
    const server = fakeServer(30)
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      void result.current.loadMore()
      void result.current.loadMore()
    })
    await waitFor(() => expect(result.current.notes).toHaveLength(30))
    expect(server.pages()).toEqual([null, 'n24'])
  })

  it('drops a page that a refresh overtook', async () => {
    const server = fakeServer(30)
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const gate = deferred<void>()
    server.on('GET', /^\/api\/notes$/, async url => {
      if (url.searchParams.get('cursorId')) await gate.promise
      return json({
        notes: url.searchParams.get('cursorId') ? [note(77)] : [note(0)],
        nextCursor: null,
        hasMore: false
      })
    })
    let more!: Promise<void>
    act(() => {
      more = result.current.loadMore()
    })
    await act(() => result.current.refresh())
    gate.resolve()
    await act(() => more)
    expect(result.current.notes.map(n => n.id)).toEqual(['n0'])
  })

  describe('a next page wanted during a refresh', () => {
    /** Holds the next first-page request until `release`. */
    function holdFirstPage(server: ReturnType<typeof fakeServer>) {
      const gate = deferred<void>()
      let held = true
      server.on('GET', /^\/api\/notes$/, async url => {
        if (!url.searchParams.get('cursorId') && held) {
          held = false
          await gate.promise
        }
        return server.page(url)
      })
      return () => gate.resolve()
    }

    /** Five notes saved elsewhere: the new first page ends at n19. */
    const savedElsewhere = (server: ReturnType<typeof fakeServer>) =>
      server.notes.unshift(...Array.from({ length: 5 }, (_, i) => note(i - 5)))

    it('loadMore during a refresh does not skip notes', async () => {
      const server = fakeServer(30)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      savedElsewhere(server)
      const release = holdFirstPage(server)
      let refreshed!: Promise<void>
      act(() => {
        refreshed = result.current.refresh()
      })
      // The list scrolled to the end while the first page is on its way.
      await act(() => result.current.loadMore())
      await act(async () => {})
      // No page after the old list's cursor (n24).
      expect(server.pages()).toEqual([null, null])
      await act(async () => {
        release()
        await refreshed
      })
      // The wanted page follows from the new first page's cursor.
      await waitFor(() => expect(result.current.notes).toHaveLength(35))
      expect(server.pages()).toEqual([null, null, 'n19'])
      expect(result.current.notes.map(n => n.id)).toEqual(
        server.notes.map(n => n.id)
      )
    })

    it('loadMore between the first page landing and its render does not page from the old list', async () => {
      const server = fakeServer(30)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      savedElsewhere(server)
      const release = holdFirstPage(server)
      let refreshed!: Promise<void>
      act(() => {
        refreshed = result.current.refresh()
      })
      const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      // Outside act, React renders the new list in a later task, as on a device.
      env.IS_REACT_ACT_ENVIRONMENT = false
      try {
        release()
        await refreshed
        void result.current.loadMore()
        await waitFor(() => expect(result.current.notes).toHaveLength(35))
      } finally {
        env.IS_REACT_ACT_ENVIRONMENT = true
      }
      expect(server.pages()).toEqual([null, null, 'n19'])
      expect(result.current.notes.map(n => n.id)).toEqual(
        server.notes.map(n => n.id)
      )
    })

    it('is dropped when a newer refresh replaces that one', async () => {
      const server = fakeServer(30)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const release = holdFirstPage(server)
      let first!: Promise<void>
      act(() => {
        first = result.current.refresh()
      })
      await act(() => result.current.loadMore())
      await act(() => result.current.refresh())
      await act(async () => {
        release()
        await first
      })
      await act(async () => {})
      // Only first pages: none that nobody asked for since.
      expect(server.pages()).toEqual([null, null, null])
      expect(result.current.notes).toHaveLength(25)
    })

    it('is not run when that refresh fails', async () => {
      const server = fakeServer(30)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const page0 = deferred<Response>()
      server.on('GET', /^\/api\/notes$/, () => page0.promise)
      let refreshed!: Promise<void>
      act(() => {
        refreshed = result.current.refresh()
      })
      await act(() => result.current.loadMore())
      await act(async () => {
        page0.resolve(json({ error: 'Down' }, 503))
        await refreshed
      })
      await act(async () => {})
      expect(result.current.status).toBe('error')
      expect(server.pages()).toEqual([null, null])
      expect(result.current.notes).toHaveLength(25)
    })
  })

  describe('sign-out while a load is on its way', () => {
    it('a first page that lands after the cache was reset is not stored', async () => {
      const server = fakeServer(3)
      const gate = deferred<void>()
      server.on('GET', /^\/api\/notes$/, async url => {
        await gate.promise
        return server.page(url)
      })
      mount(server)
      act(() => resetNotesCache())
      await act(async () => gate.resolve())
      expect(getNotesCache()).toBeNull()
    })

    it('a first page that lands after the list unmounted is not stored', async () => {
      const server = fakeServer(3)
      const gate = deferred<void>()
      server.on('GET', /^\/api\/notes$/, async url => {
        await gate.promise
        return server.page(url)
      })
      const { unmount } = mount(server)
      unmount()
      await act(async () => gate.resolve())
      expect(getNotesCache()).toBeNull()
    })

    it('a next page that lands after the cache was reset is not added', async () => {
      const server = fakeServer(30)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const gate = deferred<void>()
      server.on('GET', /^\/api\/notes$/, async url => {
        await gate.promise
        return server.page(url)
      })
      let more!: Promise<void>
      act(() => {
        more = result.current.loadMore()
      })
      // Signed out, then back in as the same user, with a fresh list.
      act(() => {
        resetNotesCache()
        setNotesCache({ userId: 'user-1', notes: [note(0)], nextCursor: null })
      })
      await act(async () => {
        gate.resolve()
        await more
      })
      expect(getNotesCache()!.notes.map(n => n.id)).toEqual(['n0'])
    })
  })

  it('keeps a note deleted on its own screen out of a refresh that raced it', async () => {
    const server = fakeServer(3)
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const stale = [...server.notes]
    server.on('GET', /^\/api\/notes$/, () =>
      json({ notes: stale, nextCursor: null, hasMore: false })
    )
    // NoteScreen's delete, before the server has applied it.
    act(() => {
      dropNote('user-1', 'n1')
    })
    await act(() => result.current.refresh())
    expect(result.current.notes.map(n => n.id)).toEqual(['n0', 'n2'])
  })

  it('shows the cached list at once while it revalidates', async () => {
    setNotesCache({ userId: 'user-1', notes: [note(5)], nextCursor: null })
    const server = fakeServer(2)
    const { result } = mount(server)
    expect(result.current.notes.map(n => n.id)).toEqual(['n5'])
    expect(result.current.status).toBe('refreshing')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.notes.map(n => n.id)).toEqual(['n0', 'n1'])
  })

  it('never shows another user’s cached list', async () => {
    setNotesCache({ userId: 'user-2', notes: [note(5)], nextCursor: null })
    const server = fakeServer(1)
    const { result } = mount(server)
    expect(result.current.notes).toEqual([])
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.notes).toHaveLength(1))
  })

  it('follows a note saved elsewhere', async () => {
    const server = fakeServer(2)
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => addNote('user-1', note(42)))
    expect(result.current.notes.map(n => n.id)).toEqual(['n42', 'n0', 'n1'])
  })

  it('a failed first load is an error, and a retry recovers', async () => {
    const server = fakeServer(2)
    let fail = true
    server.on('GET', /^\/api\/notes$/, () =>
      fail
        ? json({ error: 'Boom', retryable: true }, 500)
        : json({
            notes: [note(0)],
            nextCursor: null,
            hasMore: false
          })
    )
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('Boom')
    fail = false
    await act(() => result.current.refresh())
    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeUndefined()
    expect(result.current.notes).toHaveLength(1)
  })

  it('says notes are unavailable on a server without accounts (403)', async () => {
    const server = fakeServer(0)
    server.on('GET', /^\/api\/notes$/, () =>
      json({ error: 'Library is unavailable in anonymous mode.' }, 403)
    )
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.error).toBe(NOTES_UNAVAILABLE)
  })

  it('a failed next page keeps the list and says why', async () => {
    const server = fakeServer(30)
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    server.on('GET', /^\/api\/notes$/, () => json({ error: 'Down' }, 503))
    await act(() => result.current.loadMore())
    expect(result.current.notes).toHaveLength(25)
    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('Down')
    expect(result.current.hasMore).toBe(true)
  })

  it('a failed page that a refresh overtook says nothing', async () => {
    const server = fakeServer(30)
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const gate = deferred<void>()
    server.on('GET', /^\/api\/notes$/, async url => {
      if (!url.searchParams.get('cursorId')) {
        return json({ notes: [note(0)], nextCursor: null, hasMore: false })
      }
      await gate.promise
      return json({ error: 'Down' }, 503)
    })
    let more!: Promise<void>
    act(() => {
      more = result.current.loadMore()
    })
    await act(() => result.current.refresh())
    gate.resolve()
    await act(() => more)
    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeUndefined()
  })

  it('a failed first load that a refresh overtook says nothing', async () => {
    const server = fakeServer(1)
    const gate = deferred<void>()
    let first = true
    server.on('GET', /^\/api\/notes$/, async () => {
      if (first) {
        first = false
        await gate.promise
        return json({ error: 'Old' }, 500)
      }
      return json({ notes: [note(0)], nextCursor: null, hasMore: false })
    })
    const { result } = mount(server)
    await act(() => result.current.refresh())
    gate.resolve()
    await act(async () => {})
    expect(result.current.status).toBe('ready')
    expect(result.current.notes).toHaveLength(1)
  })

  it('signed out: nothing to show and nothing asked for', async () => {
    userId = undefined
    const server = fakeServer(3)
    const { result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.notes).toEqual([])
    expect(result.current.hasMore).toBe(false)
    await act(() => result.current.loadMore())
    expect(await act(() => result.current.remove('n0'))).toBe(false)
    expect(server.fetchImpl).not.toHaveBeenCalled()
  })

  describe('remove', () => {
    it('takes the note out at once and deletes it on the server', async () => {
      const server = fakeServer(3)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const gate = deferred<void>()
      server.on('DELETE', /^\/api\/notes\//, async () => {
        await gate.promise
        return json({ ok: true })
      })
      let removed!: Promise<boolean>
      act(() => {
        removed = result.current.remove('n1')
      })
      expect(result.current.notes.map(n => n.id)).toEqual(['n0', 'n2'])
      gate.resolve()
      expect(await act(() => removed)).toBe(true)
      expect(result.current.notes.map(n => n.id)).toEqual(['n0', 'n2'])
    })

    it('puts the note back where it was and says why when the delete fails', async () => {
      const server = fakeServer(3)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      server.on('DELETE', /^\/api\/notes\//, () => json({ error: 'Nope' }, 500))
      expect(await act(() => result.current.remove('n1'))).toBe(false)
      expect(result.current.notes.map(n => n.id)).toEqual(['n0', 'n1', 'n2'])
      expect(result.current.error).toBe('Nope')
      expect(result.current.status).toBe('ready')
    })

    it('counts a note already gone on the server (404) as removed', async () => {
      const server = fakeServer(3)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      server.notes.splice(1, 1)
      expect(await act(() => result.current.remove('n1'))).toBe(true)
      expect(result.current.notes.map(n => n.id)).toEqual(['n0', 'n2'])
      expect(result.current.error).toBeUndefined()
    })

    it('returns false for a note not in the list', async () => {
      const server = fakeServer(1)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(await act(() => result.current.remove('n9'))).toBe(false)
    })

    it('keeps a removed note out of a page that raced its delete', async () => {
      const server = fakeServer(3)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const stale = [...server.notes]
      server.on('GET', /^\/api\/notes$/, () =>
        json({ notes: stale, nextCursor: null, hasMore: false })
      )
      await act(() => result.current.remove('n1'))
      await act(() => result.current.refresh())
      expect(result.current.notes.map(n => n.id)).toEqual(['n0', 'n2'])
      await act(() => result.current.loadMore())
      expect(result.current.notes.map(n => n.id)).toEqual(['n0', 'n2'])
    })

    it('keeps a removed note out of a next page too', async () => {
      const server = fakeServer(30)
      const { result } = mount(server)
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => result.current.remove('n1'))
      server.on('GET', /^\/api\/notes$/, () =>
        json({ notes: [note(1), note(26)], nextCursor: null, hasMore: false })
      )
      await act(() => result.current.loadMore())
      expect(result.current.notes.map(n => n.id)).not.toContain('n1')
      expect(result.current.notes.map(n => n.id)).toContain('n26')
    })
  })

  it('a new user starts over from their own list', async () => {
    const server = fakeServer(2)
    const { result, rerender } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    userId = 'user-2'
    resetNotesCache()
    rerender()
    expect(result.current.notes).toEqual([])
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(getNotesCache()!.userId).toBe('user-2')
  })
})

describe('saveAnswerToNotes', () => {
  it('saves the note, puts it in the list, and remembers its answer', async () => {
    const server = fakeServer(1)
    const { client, result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let saved!: Note
    await act(async () => {
      saved = await saveAnswerToNotes(client, 'user-1', {
        content: 'Answer',
        chatId: 'c1',
        sourceMessageId: 'm1'
      })
    })
    expect(saved).toMatchObject({ content: 'Answer', chatId: 'c1' })
    expect(result.current.notes[0].id).toBe(saved.id)
    expect(isMessageSaved('user-1', 'm1')).toBe(true)
  })

  it('remembers nothing when the cache was reset (sign-out) while it saved', async () => {
    const server = fakeServer(1)
    const { client, result } = mount(server)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const gate = deferred<void>()
    server.on('POST', /^\/api\/notes$/, async () => {
      await gate.promise
      return json({ note: note(99, { sourceMessageId: 'm1' }) }, 201)
    })
    let saving!: Promise<Note>
    act(() => {
      saving = saveAnswerToNotes(client, 'user-1', {
        content: 'Answer',
        sourceMessageId: 'm1'
      })
    })
    act(() => resetNotesCache())
    await act(async () => {
      gate.resolve()
      await saving
    })
    expect(getNotesCache()).toBeNull()
    expect(isMessageSaved('user-1', 'm1')).toBe(false)
  })

  it('rejects, remembering nothing, when the save fails', async () => {
    const server = fakeServer(0)
    server.on('POST', /^\/api\/notes$/, () => json({ error: 'No' }, 500))
    const { client } = mount(server)
    await expect(
      saveAnswerToNotes(client, 'user-1', {
        content: 'Answer',
        sourceMessageId: 'm1'
      })
    ).rejects.toMatchObject({ status: 500 })
    expect(isMessageSaved('user-1', 'm1')).toBe(false)
  })
})
