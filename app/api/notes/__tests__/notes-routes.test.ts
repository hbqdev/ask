import { NextRequest } from 'next/server'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The routes run the real lib/actions/notes over a mocked user + DB layer, so
// the status mapping is checked against the actions' actual error strings.
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/actions')

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import * as dbActions from '@/lib/db/actions'

import { DELETE, GET as GET_ONE } from '../[noteId]/route'
import { GET, POST } from '../route'

const note = {
  id: 'note-1',
  userId: 'user-1',
  chatId: 'chat-1',
  sourceMessageId: 'message-1',
  title: 'Saved answer',
  content: 'Saved answer content',
  createdAt: new Date('2026-06-17T00:00:00Z'),
  updatedAt: new Date('2026-06-18T00:00:00Z')
}

// What the API returns for `note`: no userId, dates as ISO strings.
const noteJson = {
  id: 'note-1',
  title: 'Saved answer',
  content: 'Saved answer content',
  chatId: 'chat-1',
  sourceMessageId: 'message-1',
  createdAt: '2026-06-17T00:00:00.000Z',
  updatedAt: '2026-06-18T00:00:00.000Z'
}

const ANONYMOUS = { error: 'Library is unavailable in anonymous mode.' }

function listRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/notes${query}`)
}

function postRequest(body: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  })
}

function noteRequest(id: string, method: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/notes/${id}`, { method })
}

function context(noteId: string) {
  return { params: Promise.resolve({ noteId }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ENABLE_AUTH', 'true')
  vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
  vi.mocked(dbActions.getNotes).mockResolvedValue({
    notes: [note],
    nextCursor: null,
    hasMore: false
  })
  vi.mocked(dbActions.createNote).mockResolvedValue(note)
  vi.mocked(dbActions.getNote).mockResolvedValue(note)
  vi.mocked(dbActions.deleteNote).mockResolvedValue({ success: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function silenceConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('GET /api/notes', () => {
  it('returns the first page with the default limit', async () => {
    const res = await GET(listRequest())

    expect(dbActions.getNotes).toHaveBeenCalledWith('user-1', {
      limit: 25,
      cursor: undefined
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      notes: [noteJson],
      nextCursor: null,
      hasMore: false
    })
  })

  it('passes the cursor through and returns the next one', async () => {
    const nextCursor = { updatedAt: '2026-06-01T00:00:00.000Z', id: 'note-9' }
    vi.mocked(dbActions.getNotes).mockResolvedValue({
      notes: [note],
      nextCursor,
      hasMore: true
    })

    const res = await GET(
      listRequest(
        '?limit=10&cursorUpdatedAt=2026-06-18T00%3A00%3A00.000Z&cursorId=note-1'
      )
    )

    expect(dbActions.getNotes).toHaveBeenCalledWith('user-1', {
      limit: 10,
      cursor: { updatedAt: '2026-06-18T00:00:00.000Z', id: 'note-1' }
    })
    expect(await res.json()).toEqual({
      notes: [noteJson],
      nextCursor,
      hasMore: true
    })
  })

  it.each([
    ['0', 1],
    ['-5', 1],
    ['51', 50],
    ['1000', 50],
    ['abc', 25],
    ['', 25]
  ])('clamps limit=%s to %d', async (raw, expected) => {
    await GET(listRequest(`?limit=${raw}`))

    expect(dbActions.getNotes).toHaveBeenCalledWith('user-1', {
      limit: expected,
      cursor: undefined
    })
  })

  it.each([
    ['only cursorUpdatedAt', '?cursorUpdatedAt=2026-06-18T00%3A00%3A00.000Z'],
    ['only cursorId', '?cursorId=note-1'],
    ['an unparseable cursorUpdatedAt', '?cursorUpdatedAt=yesterday&cursorId=n']
  ])('returns 400 without listing for %s', async (_label, query) => {
    const res = await GET(listRequest(query))

    expect(dbActions.getNotes).not.toHaveBeenCalled()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid cursor' })
  })

  it('returns 401 when there is no user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await GET(listRequest())

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 in anonymous mode', async () => {
    vi.stubEnv('ENABLE_AUTH', 'false')

    const res = await GET(listRequest())

    expect(dbActions.getNotes).not.toHaveBeenCalled()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(ANONYMOUS)
  })

  it('returns a retryable 500 when listing fails', async () => {
    const consoleError = silenceConsoleError()
    vi.mocked(dbActions.getNotes).mockRejectedValue(new Error('db down'))

    const res = await GET(listRequest())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to load notes.',
      retryable: true
    })
    consoleError.mockRestore()
  })

  it('returns a retryable 500 when resolving the user throws', async () => {
    const consoleError = silenceConsoleError()
    vi.mocked(getCurrentUserId).mockRejectedValue(new Error('auth down'))

    const res = await GET(listRequest())

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to load notes.',
      retryable: true
    })
    consoleError.mockRestore()
  })
})

describe('POST /api/notes', () => {
  it('creates a note and returns 201 {note}', async () => {
    const res = await POST(
      postRequest(
        JSON.stringify({
          content: 'Saved answer content',
          title: 'Saved answer',
          chatId: 'chat-1',
          sourceMessageId: 'message-1'
        })
      )
    )

    expect(dbActions.createNote).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: 'chat-1',
      sourceMessageId: 'message-1',
      title: 'Saved answer',
      content: 'Saved answer content'
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ note: noteJson })
  })

  it('accepts content alone, treating null optionals as absent', async () => {
    const res = await POST(
      postRequest(JSON.stringify({ content: 'Just this', chatId: null }))
    )

    expect(dbActions.createNote).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: null,
      sourceMessageId: null,
      title: 'Just this',
      content: 'Just this'
    })
    expect(res.status).toBe(201)
  })

  it.each([
    ['empty content', JSON.stringify({ content: '' })],
    ['whitespace content', JSON.stringify({ content: '   ' })],
    ['missing content', JSON.stringify({ title: 'x' })],
    ['non-string content', JSON.stringify({ content: 42 })],
    ['over-long content', JSON.stringify({ content: 'x'.repeat(100_001) })],
    ['a non-string title', JSON.stringify({ content: 'x', title: 1 })],
    ['a non-string chatId', JSON.stringify({ content: 'x', chatId: {} })],
    [
      'a non-string sourceMessageId',
      JSON.stringify({ content: 'x', sourceMessageId: true })
    ],
    ['a non-object body', JSON.stringify('x')],
    ['a null body', 'null'],
    ['malformed JSON', '{not json']
  ])('returns 400 without saving for %s', async (_label, body) => {
    const res = await POST(postRequest(body))

    expect(dbActions.createNote).not.toHaveBeenCalled()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid note' })
  })

  it('accepts content of exactly 100,000 characters', async () => {
    const res = await POST(
      postRequest(JSON.stringify({ content: 'x'.repeat(100_000) }))
    )

    expect(res.status).toBe(201)
  })

  it('returns 401 when there is no user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await POST(postRequest(JSON.stringify({ content: 'x' })))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('returns 403 in anonymous mode', async () => {
    vi.stubEnv('ENABLE_AUTH', 'false')

    const res = await POST(postRequest(JSON.stringify({ content: 'x' })))

    expect(dbActions.createNote).not.toHaveBeenCalled()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(ANONYMOUS)
  })

  it('returns a retryable 500 when saving fails', async () => {
    const consoleError = silenceConsoleError()
    vi.mocked(dbActions.createNote).mockRejectedValue(new Error('db down'))

    const res = await POST(postRequest(JSON.stringify({ content: 'x' })))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to save note.',
      retryable: true
    })
    consoleError.mockRestore()
  })

  it('returns a retryable 500 when resolving the user throws', async () => {
    const consoleError = silenceConsoleError()
    vi.mocked(getCurrentUserId).mockRejectedValue(new Error('auth down'))

    const res = await POST(postRequest(JSON.stringify({ content: 'x' })))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to save note.',
      retryable: true
    })
    consoleError.mockRestore()
  })
})

describe('GET /api/notes/[noteId]', () => {
  it('returns {note} for the owner', async () => {
    const res = await GET_ONE(noteRequest('note-1', 'GET'), context('note-1'))

    expect(dbActions.getNote).toHaveBeenCalledWith('note-1', 'user-1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ note: noteJson })
  })

  it('returns 404 for a missing or foreign note', async () => {
    vi.mocked(dbActions.getNote).mockResolvedValue(null)

    const res = await GET_ONE(noteRequest('nope', 'GET'), context('nope'))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('returns 401 when there is no user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await GET_ONE(noteRequest('note-1', 'GET'), context('note-1'))

    expect(res.status).toBe(401)
  })

  it('returns 403 in anonymous mode', async () => {
    vi.stubEnv('ENABLE_AUTH', 'false')

    const res = await GET_ONE(noteRequest('note-1', 'GET'), context('note-1'))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(ANONYMOUS)
  })

  it('returns a retryable 500 when loading fails', async () => {
    const consoleError = silenceConsoleError()
    vi.mocked(dbActions.getNote).mockRejectedValue(new Error('db down'))

    const res = await GET_ONE(noteRequest('note-1', 'GET'), context('note-1'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to load note.',
      retryable: true
    })
    consoleError.mockRestore()
  })

  it('returns a retryable 500 when resolving the user throws', async () => {
    const consoleError = silenceConsoleError()
    vi.mocked(getCurrentUserId).mockRejectedValue(new Error('auth down'))

    const res = await GET_ONE(noteRequest('note-1', 'GET'), context('note-1'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to load note.',
      retryable: true
    })
    consoleError.mockRestore()
  })
})

describe('DELETE /api/notes/[noteId]', () => {
  it('deletes the note and returns {ok:true}', async () => {
    const res = await DELETE(noteRequest('note-1', 'DELETE'), context('note-1'))

    expect(dbActions.deleteNote).toHaveBeenCalledWith('note-1', 'user-1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns 404 for a missing or foreign note', async () => {
    vi.mocked(dbActions.deleteNote).mockResolvedValue({
      success: false,
      error: 'Note not found'
    })

    const res = await DELETE(noteRequest('nope', 'DELETE'), context('nope'))

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('returns 401 when there is no user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await DELETE(noteRequest('note-1', 'DELETE'), context('note-1'))

    expect(dbActions.deleteNote).not.toHaveBeenCalled()
    expect(res.status).toBe(401)
  })

  it('returns 403 in anonymous mode', async () => {
    vi.stubEnv('ENABLE_AUTH', 'false')

    const res = await DELETE(noteRequest('note-1', 'DELETE'), context('note-1'))

    expect(dbActions.deleteNote).not.toHaveBeenCalled()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual(ANONYMOUS)
  })

  it('returns a retryable 500 when the delete fails', async () => {
    vi.mocked(dbActions.deleteNote).mockResolvedValue({
      success: false,
      error: 'Failed to delete note'
    })

    const res = await DELETE(noteRequest('note-1', 'DELETE'), context('note-1'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete note',
      retryable: true
    })
  })

  it('returns a retryable 500 when the delete throws', async () => {
    const consoleError = silenceConsoleError()
    vi.mocked(dbActions.deleteNote).mockRejectedValue(new Error('db down'))

    const res = await DELETE(noteRequest('note-1', 'DELETE'), context('note-1'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete note',
      retryable: true
    })
    consoleError.mockRestore()
  })
})
