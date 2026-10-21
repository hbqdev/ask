import { Preferences } from '@capacitor/preferences'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatRow } from '@/features/library/library-api'
import {
  clearLibraryCache,
  LIBRARY_CACHE_KEY,
  loadLibraryCache,
  saveLibraryCache
} from '@/features/library/library-cache'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

const prefs = vi.mocked(Preferences)

const row = (n: number): ChatRow => ({
  id: `c${n}`,
  title: `Chat ${n}`,
  createdAt: '2026-10-20T10:00:00.000Z',
  lastViewedAt: null,
  fileCount: 0
})

const ROWS = [row(1), { ...row(2), searchMode: 'quality', fileCount: 1 }]

beforeEach(() => {
  vi.clearAllMocks()
})

it('uses the Preferences key "ask-library-cache"', () => {
  expect(LIBRARY_CACHE_KEY).toBe('ask-library-cache')
})

describe('loadLibraryCache / saveLibraryCache', () => {
  it('round-trips the sort, rows and total for the same user', async () => {
    const storage = memoryStorage()
    await saveLibraryCache(
      'user-1',
      { sort: 'title', chats: ROWS, total: 2 },
      storage
    )
    await expect(loadLibraryCache('user-1', storage)).resolves.toEqual({
      sort: 'title',
      chats: ROWS,
      total: 2
    })
  })

  it('stores the user id, sort, rows, total and when it was saved', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-21T09:00:00.000Z') })
    const storage = memoryStorage()
    await saveLibraryCache('user-1', { sort: 'recent', chats: ROWS }, storage)
    vi.useRealTimers()
    expect(JSON.parse(storage.data.get(LIBRARY_CACHE_KEY)!)).toEqual({
      userId: 'user-1',
      sort: 'recent',
      chats: ROWS,
      savedAt: '2026-10-21T09:00:00.000Z'
    })
  })

  it('round-trips without a total', async () => {
    const storage = memoryStorage()
    await saveLibraryCache('user-1', { sort: 'recent', chats: ROWS }, storage)
    const cache = await loadLibraryCache('user-1', storage)
    expect(cache).toEqual({ sort: 'recent', chats: ROWS })
    expect(cache && 'total' in cache).toBe(false)
  })

  it('cache from another user id is ignored', async () => {
    const storage = memoryStorage()
    await saveLibraryCache('user-1', { sort: 'recent', chats: ROWS }, storage)
    await expect(loadLibraryCache('user-2', storage)).resolves.toBeNull()
  })

  it('keeps only the first 60 rows', async () => {
    const storage = memoryStorage()
    const many = Array.from({ length: 75 }, (_, i) => row(i))
    await saveLibraryCache('user-1', { sort: 'recent', chats: many }, storage)
    const cache = await loadLibraryCache('user-1', storage)
    expect(cache?.chats).toEqual(many.slice(0, 60))
  })

  it('gives null when nothing is stored', async () => {
    await expect(
      loadLibraryCache('user-1', memoryStorage())
    ).resolves.toBeNull()
  })

  it.each([
    ['bad JSON', '{not json'],
    ['JSON null', 'null'],
    ['a JSON non-object', '42'],
    [
      'an unknown sort',
      JSON.stringify({ userId: 'user-1', sort: 'size', chats: [] })
    ],
    [
      'rows that are not an array',
      JSON.stringify({ userId: 'user-1', sort: 'recent', chats: {} })
    ]
  ])('gives null for %s', async (_name, stored) => {
    const storage = memoryStorage({ [LIBRARY_CACHE_KEY]: stored })
    await expect(loadLibraryCache('user-1', storage)).resolves.toBeNull()
  })

  it('drops malformed rows and a non-numeric total', async () => {
    const storage = memoryStorage({
      [LIBRARY_CACHE_KEY]: JSON.stringify({
        userId: 'user-1',
        sort: 'recent',
        chats: [row(1), null, { id: 7 }, { id: 'x' }],
        total: 'many'
      })
    })
    await expect(loadLibraryCache('user-1', storage)).resolves.toEqual({
      sort: 'recent',
      chats: [row(1)]
    })
  })

  it('gives null when storage cannot be read', async () => {
    const storage = memoryStorage()
    storage.getItem.mockRejectedValue(new Error('unreadable'))
    await expect(loadLibraryCache('user-1', storage)).resolves.toBeNull()
  })

  it('never rejects when saving fails (the cache is best-effort)', async () => {
    const storage = memoryStorage()
    storage.setItem.mockRejectedValue(new Error('disk full'))
    await expect(
      saveLibraryCache('user-1', { sort: 'recent', chats: ROWS }, storage)
    ).resolves.toBeUndefined()
  })

  it('uses Capacitor Preferences by default', async () => {
    prefs.set.mockResolvedValue(undefined)
    await saveLibraryCache('user-1', { sort: 'recent', chats: ROWS })
    const stored = prefs.set.mock.calls[0][0]
    expect(stored.key).toBe(LIBRARY_CACHE_KEY)
    prefs.get.mockResolvedValue({ value: stored.value })
    await expect(loadLibraryCache('user-1')).resolves.toEqual({
      sort: 'recent',
      chats: ROWS
    })
    expect(prefs.get).toHaveBeenCalledWith({ key: LIBRARY_CACHE_KEY })
    prefs.remove.mockResolvedValue(undefined)
    await clearLibraryCache()
    expect(prefs.remove).toHaveBeenCalledWith({ key: LIBRARY_CACHE_KEY })
  })
})

describe('clearLibraryCache', () => {
  it('sign-out clears the library cache', async () => {
    const storage = memoryStorage()
    await saveLibraryCache('user-1', { sort: 'recent', chats: ROWS }, storage)
    await clearLibraryCache(storage)
    expect(storage.data.has(LIBRARY_CACHE_KEY)).toBe(false)
    await expect(loadLibraryCache('user-1', storage)).resolves.toBeNull()
  })
})
