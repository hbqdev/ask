import { Preferences } from '@capacitor/preferences'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LIBRARY_SORT_KEY,
  LIBRARY_SORTS,
  parseLibrarySort,
  useLibrarySort
} from '@/features/library/library-sort'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

const prefs = vi.mocked(Preferences)

beforeEach(() => {
  vi.clearAllMocks()
})

it('uses the Preferences key "ask-library-sort"', () => {
  expect(LIBRARY_SORT_KEY).toBe('ask-library-sort')
})

it('lists the sorts in menu order with their labels', () => {
  expect(LIBRARY_SORTS).toEqual([
    { value: 'recent', label: 'Recent' },
    { value: 'newest', label: 'Newest' },
    { value: 'oldest', label: 'Oldest' },
    { value: 'title', label: 'Title' }
  ])
})

describe('parseLibrarySort', () => {
  it.each(['recent', 'newest', 'oldest', 'title'] as const)(
    'keeps %s',
    sort => {
      expect(parseLibrarySort(sort)).toBe(sort)
    }
  )

  it.each([
    ['nothing stored', null],
    ['an unknown sort', 'alphabetical'],
    ['an empty string', '']
  ])('falls back to recent for %s', (_, value) => {
    expect(parseLibrarySort(value)).toBe('recent')
  })
})

describe('useLibrarySort', () => {
  it('starts on recent, not loaded, then loads the stored sort', async () => {
    const storage = memoryStorage({ [LIBRARY_SORT_KEY]: 'title' })
    const { result } = renderHook(() => useLibrarySort(storage))
    expect(result.current[0]).toBe('recent')
    expect(result.current[2]).toBe(false)
    await waitFor(() => expect(result.current[2]).toBe(true))
    expect(result.current[0]).toBe('title')
  })

  it('saves a change and shows it at once', async () => {
    const storage = memoryStorage()
    const { result } = renderHook(() => useLibrarySort(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    act(() => result.current[1]('oldest'))
    expect(result.current[0]).toBe('oldest')
    expect(storage.data.get(LIBRARY_SORT_KEY)).toBe('oldest')
  })

  it('keeps a change made before the stored sort loads', async () => {
    let release!: (value: string) => void
    const storage = memoryStorage()
    storage.getItem.mockImplementation(
      () => new Promise<string>(r => (release = r))
    )
    const { result } = renderHook(() => useLibrarySort(storage))
    act(() => result.current[1]('newest'))
    await act(async () => release('title'))
    expect(result.current[0]).toBe('newest')
    expect(result.current[2]).toBe(true)
  })

  it('loads as recent when storage cannot be read', async () => {
    const storage = memoryStorage()
    storage.getItem.mockRejectedValue(new Error('unreadable'))
    const { result } = renderHook(() => useLibrarySort(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    expect(result.current[0]).toBe('recent')
  })

  it('keeps the change when the save fails', async () => {
    const storage = memoryStorage()
    storage.setItem.mockRejectedValue(new Error('full'))
    const { result } = renderHook(() => useLibrarySort(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    await act(async () => result.current[1]('title'))
    expect(result.current[0]).toBe('title')
  })

  it('uses Capacitor Preferences by default', async () => {
    prefs.get.mockResolvedValue({ value: 'newest' })
    prefs.set.mockResolvedValue()
    const { result } = renderHook(() => useLibrarySort())
    await waitFor(() => expect(result.current[0]).toBe('newest'))
    expect(prefs.get).toHaveBeenCalledWith({ key: LIBRARY_SORT_KEY })
    act(() => result.current[1]('title'))
    expect(prefs.set).toHaveBeenCalledWith({
      key: LIBRARY_SORT_KEY,
      value: 'title'
    })
  })
})
