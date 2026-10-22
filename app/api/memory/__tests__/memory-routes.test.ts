import { NextRequest } from 'next/server'

import { beforeEach, describe, expect, it, vi } from 'vitest'

// The routes run the real lib/actions/memory + recall over a mocked user and
// DB layer, so the status mapping is checked against the actions' real results.
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/memory-actions')
vi.mock('@/lib/db/recall-actions')
vi.mock('@/lib/memory/recall-backfill')

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import * as memoryDb from '@/lib/db/memory-actions'
import * as recallDb from '@/lib/db/recall-actions'
import { backfillUser } from '@/lib/memory/recall-backfill'

import { DELETE as DELETE_ONE } from '../[memoryId]/route'
import { DELETE as CLEAR_RECALL, POST as REBUILD_RECALL } from '../recall/route'
import { DELETE as CLEAR, GET } from '../route'

// A full stored row, embedding and owner included: the route must whitelist.
const storedMemory = {
  id: 'mem-1',
  userId: 'user-1',
  content: 'Prefers concise answers',
  category: 'preference',
  status: 'confirmed',
  sightings: 3,
  embedding: [0.1, 0.2, 0.3],
  sourceChatId: 'chat-1',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
  lastUsedAt: new Date('2026-10-03T00:00:00Z')
}

const memoryJson = {
  id: 'mem-1',
  content: 'Prefers concise answers',
  category: 'preference',
  status: 'confirmed',
  updatedAt: '2026-10-02T00:00:00.000Z',
  lastUsedAt: '2026-10-03T00:00:00.000Z'
}

const UNAUTHORIZED = { error: 'Unauthorized' }

function request(path: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { method })
}

function context(memoryId: string) {
  return { params: Promise.resolve({ memoryId }) }
}

function silenceConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
  vi.mocked(memoryDb.listMemories).mockResolvedValue([storedMemory] as any)
  vi.mocked(memoryDb.isMemoryEnabled).mockResolvedValue(true)
  vi.mocked(memoryDb.deleteMemory).mockResolvedValue(true)
  vi.mocked(memoryDb.clearMemories).mockResolvedValue()
  vi.mocked(recallDb.isRecallEnabled).mockResolvedValue(false)
  vi.mocked(recallDb.countChunks).mockResolvedValue({ chunks: 42, chats: 7 })
  vi.mocked(recallDb.clearChunks).mockResolvedValue()
  vi.mocked(backfillUser).mockResolvedValue({
    messages: 25,
    chunks: 60,
    ok: true
  } as any)
})

describe('GET /api/memory', () => {
  it('returns the toggles, recall status and memories', async () => {
    const res = await GET()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      enabled: true,
      recallEnabled: false,
      recall: { chunks: 42, chats: 7 },
      memories: [memoryJson]
    })
  })

  it('omits embedding', async () => {
    const body = await (await GET()).json()

    expect(body.memories[0]).not.toHaveProperty('embedding')
    expect(Object.keys(body.memories[0]).sort()).toEqual(
      Object.keys(memoryJson).sort()
    )
  })

  it('returns 401 for guests without reading anything', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await GET()

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual(UNAUTHORIZED)
    expect(memoryDb.listMemories).not.toHaveBeenCalled()
  })

  it('returns a retryable 500 when a read fails', async () => {
    const error = silenceConsoleError()
    vi.mocked(memoryDb.listMemories).mockRejectedValue(new Error('db down'))

    const res = await GET()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to load memory',
      retryable: true
    })
    expect(error).toHaveBeenCalled()
  })
})

describe('DELETE /api/memory (clear)', () => {
  it('clears every memory and returns {ok:true}', async () => {
    const res = await CLEAR()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(memoryDb.clearMemories).toHaveBeenCalledWith('user-1')
  })

  it('returns 401 without a user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await CLEAR()

    expect(res.status).toBe(401)
    expect(memoryDb.clearMemories).not.toHaveBeenCalled()
  })

  it('returns a retryable 500 when clearing fails', async () => {
    silenceConsoleError()
    vi.mocked(memoryDb.clearMemories).mockRejectedValue(new Error('db down'))

    const res = await CLEAR()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to clear memories',
      retryable: true
    })
  })
})

describe('DELETE /api/memory/[memoryId]', () => {
  it('deletes the memory and returns {ok:true}', async () => {
    const res = await DELETE_ONE(
      request('/api/memory/mem-1', 'DELETE'),
      context('mem-1')
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(memoryDb.deleteMemory).toHaveBeenCalledWith('user-1', 'mem-1')
  })

  it('returns 404 for a missing or foreign memory', async () => {
    vi.mocked(memoryDb.deleteMemory).mockResolvedValue(false)

    const res = await DELETE_ONE(
      request('/api/memory/mem-x', 'DELETE'),
      context('mem-x')
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not found' })
  })

  it('returns 401 without a user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await DELETE_ONE(
      request('/api/memory/mem-1', 'DELETE'),
      context('mem-1')
    )

    expect(res.status).toBe(401)
    expect(memoryDb.deleteMemory).not.toHaveBeenCalled()
  })

  it('returns a retryable 500 when deleting fails', async () => {
    silenceConsoleError()
    vi.mocked(memoryDb.deleteMemory).mockRejectedValue(new Error('db down'))

    const res = await DELETE_ONE(
      request('/api/memory/mem-1', 'DELETE'),
      context('mem-1')
    )

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete memory',
      retryable: true
    })
  })
})

describe('POST /api/memory/recall (rebuild one batch)', () => {
  it('passes one bounded batch through as {messages, chunks, done}', async () => {
    const res = await REBUILD_RECALL()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ messages: 25, chunks: 60, done: false })
    expect(backfillUser).toHaveBeenCalledTimes(1)
    expect(backfillUser).toHaveBeenCalledWith('user-1', {
      batchSize: 25,
      maxBatches: 4
    })
  })

  it('reports done once nothing is left to index', async () => {
    vi.mocked(backfillUser).mockResolvedValue({
      messages: 0,
      chunks: 0,
      ok: true
    } as any)

    expect(await (await REBUILD_RECALL()).json()).toEqual({
      messages: 0,
      chunks: 0,
      done: true
    })
  })

  it('returns a retryable 500 with the action error when the batch fails', async () => {
    vi.mocked(backfillUser).mockResolvedValue({
      messages: 0,
      chunks: 0,
      ok: false
    } as any)

    const res = await REBUILD_RECALL()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Rebuild failed — see server logs',
      retryable: true
    })
  })

  it('returns 401 without a user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await REBUILD_RECALL()

    expect(res.status).toBe(401)
    expect(backfillUser).not.toHaveBeenCalled()
  })

  it('returns a retryable 500 when the batch throws', async () => {
    silenceConsoleError()
    vi.mocked(backfillUser).mockRejectedValue(new Error('boom'))

    const res = await REBUILD_RECALL()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to rebuild recall index',
      retryable: true
    })
  })
})

describe('DELETE /api/memory/recall (clear index)', () => {
  it('clears the index and returns {ok:true}', async () => {
    const res = await CLEAR_RECALL()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(recallDb.clearChunks).toHaveBeenCalledWith('user-1')
  })

  it('returns 401 without a user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

    const res = await CLEAR_RECALL()

    expect(res.status).toBe(401)
    expect(recallDb.clearChunks).not.toHaveBeenCalled()
  })

  it('returns a retryable 500 when clearing fails', async () => {
    silenceConsoleError()
    vi.mocked(recallDb.clearChunks).mockRejectedValue(new Error('db down'))

    const res = await CLEAR_RECALL()

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to clear recall index',
      retryable: true
    })
  })
})
