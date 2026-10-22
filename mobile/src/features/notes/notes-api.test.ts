import { describe, expect, it, vi } from 'vitest'

import { createApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import {
  deleteNote,
  fetchNote,
  fetchNotesPage,
  isNotesUnavailable,
  NOTES_PAGE_SIZE,
  saveNote
} from '@/features/notes/notes-api'

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

function request(fetchImpl: ReturnType<typeof client>['fetchImpl'], n = 0) {
  const [url, init] = fetchImpl.mock.calls[n]
  return { url: new URL(String(url)), init: init ?? {} }
}

const SERVER_NOTE = {
  id: 'n1',
  title: 'Tides',
  content: 'The moon pulls the sea.',
  chatId: 'c1',
  sourceMessageId: 'm1',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z'
}

describe('fetchNotesPage', () => {
  it('GETs /api/notes with the page size and no cursor for the first page', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ notes: [], nextCursor: null, hasMore: false })
    )
    await fetchNotesPage(api)
    const { url, init } = request(fetchImpl)
    expect(url.origin + url.pathname).toBe(`${BASE}/api/notes`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: String(NOTES_PAGE_SIZE)
    })
    expect(init.method ?? 'GET').toBe('GET')
  })

  it('sends both halves of the cursor and a given limit', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ notes: [], nextCursor: null, hasMore: false })
    )
    await fetchNotesPage(api, {
      cursor: { updatedAt: '2026-10-21T08:00:00.000Z', id: 'n9' },
      limit: 10
    })
    expect(Object.fromEntries(request(fetchImpl).url.searchParams)).toEqual({
      limit: '10',
      cursorUpdatedAt: '2026-10-21T08:00:00.000Z',
      cursorId: 'n9'
    })
  })

  it('maps the notes and the next cursor while there is more', async () => {
    const next = { updatedAt: '2026-10-21T08:00:00.000Z', id: 'n1' }
    const { client: api } = client(() =>
      json({ notes: [SERVER_NOTE], nextCursor: next, hasMore: true })
    )
    expect(await fetchNotesPage(api)).toEqual({
      notes: [SERVER_NOTE],
      nextCursor: next
    })
  })

  it('has no next cursor on the last page, whatever the server sent', async () => {
    const { client: api } = client(() =>
      json({
        notes: [SERVER_NOTE],
        nextCursor: { updatedAt: '2026-10-21T08:00:00.000Z', id: 'n1' },
        hasMore: false
      })
    )
    expect((await fetchNotesPage(api)).nextCursor).toBeNull()
  })

  it('reads a missing chat or message id as null', async () => {
    const { client: api } = client(() =>
      json({
        notes: [{ ...SERVER_NOTE, chatId: undefined, sourceMessageId: null }],
        nextCursor: null,
        hasMore: false
      })
    )
    const [note] = (await fetchNotesPage(api)).notes
    expect(note.chatId).toBeNull()
    expect(note.sourceMessageId).toBeNull()
  })

  it('rejects with the status for a failure', async () => {
    const { client: api } = client(() =>
      json({ error: 'Library is unavailable in anonymous mode.' }, 403)
    )
    await expect(fetchNotesPage(api)).rejects.toMatchObject({ status: 403 })
  })
})

describe('saveNote', () => {
  it('POSTs the content, chat and message as JSON and resolves with the note', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ note: SERVER_NOTE }, 201)
    )
    const note = await saveNote(api, {
      content: 'The moon pulls the sea.',
      chatId: 'c1',
      sourceMessageId: 'm1'
    })
    const { url, init } = request(fetchImpl)
    expect(url.pathname).toBe('/api/notes')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('Content-Type')).toBe(
      'application/json'
    )
    expect(JSON.parse(String(init.body))).toEqual({
      content: 'The moon pulls the sea.',
      chatId: 'c1',
      sourceMessageId: 'm1'
    })
    expect(note).toEqual(SERVER_NOTE)
  })

  it('sends a title when given', async () => {
    const { client: api, fetchImpl } = client(() =>
      json({ note: SERVER_NOTE }, 201)
    )
    await saveNote(api, { content: 'x', title: 'Mine' })
    expect(JSON.parse(String(request(fetchImpl).init.body))).toEqual({
      content: 'x',
      title: 'Mine'
    })
  })

  it('rejects on a failure', async () => {
    const { client: api } = client(() =>
      json({ error: 'Failed to save note.', retryable: true }, 500)
    )
    await expect(saveNote(api, { content: 'x' })).rejects.toBeInstanceOf(
      ApiError
    )
  })
})

describe('fetchNote', () => {
  it('GETs one note by its encoded id', async () => {
    const { client: api, fetchImpl } = client(() => json({ note: SERVER_NOTE }))
    expect(await fetchNote(api, 'n/1')).toEqual(SERVER_NOTE)
    expect(request(fetchImpl).url.pathname).toBe('/api/notes/n%2F1')
  })

  it('rejects with 404 for a missing note', async () => {
    const { client: api } = client(() => json({ error: 'Not found' }, 404))
    await expect(fetchNote(api, 'n1')).rejects.toMatchObject({ status: 404 })
  })
})

describe('deleteNote', () => {
  it('DELETEs the note', async () => {
    const { client: api, fetchImpl } = client(() => json({ ok: true }))
    await deleteNote(api, 'n1')
    const { url, init } = request(fetchImpl)
    expect(url.pathname).toBe('/api/notes/n1')
    expect(init.method).toBe('DELETE')
  })

  it('rejects with 404 for a note already gone', async () => {
    const { client: api } = client(() => json({ error: 'Not found' }, 404))
    await expect(deleteNote(api, 'n1')).rejects.toMatchObject({ status: 404 })
  })
})

describe('isNotesUnavailable', () => {
  it('is true for a 403 (an anonymous-mode server)', () => {
    expect(isNotesUnavailable(new ApiError(403, 'x'))).toBe(true)
  })

  it('is false for anything else', () => {
    expect(isNotesUnavailable(new ApiError(500, 'x'))).toBe(false)
    expect(isNotesUnavailable(new ApiError(401, 'x'))).toBe(false)
    expect(isNotesUnavailable(new Error('x'))).toBe(false)
  })
})
