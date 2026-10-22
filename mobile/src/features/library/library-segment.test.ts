import { Preferences } from '@capacitor/preferences'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LIBRARY_SEGMENT_KEY,
  parseLibrarySegment,
  useLibrarySegment
} from '@/features/library/library-segment'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

const prefs = vi.mocked(Preferences)

beforeEach(() => {
  vi.clearAllMocks()
})

it('uses the Preferences key "ask-library-segment"', () => {
  expect(LIBRARY_SEGMENT_KEY).toBe('ask-library-segment')
})

describe('parseLibrarySegment', () => {
  it.each(['chats', 'notes'] as const)('keeps %s', segment => {
    expect(parseLibrarySegment(segment)).toBe(segment)
  })

  it.each([
    ['nothing stored', null],
    ['an unknown segment', 'memories'],
    ['an empty string', '']
  ])('falls back to chats for %s', (_, value) => {
    expect(parseLibrarySegment(value)).toBe('chats')
  })
})

describe('useLibrarySegment', () => {
  it('starts on chats, not loaded, then loads the stored segment', async () => {
    const storage = memoryStorage({ [LIBRARY_SEGMENT_KEY]: 'notes' })
    const { result } = renderHook(() => useLibrarySegment(storage))
    expect(result.current[0]).toBe('chats')
    expect(result.current[2]).toBe(false)
    await waitFor(() => expect(result.current[2]).toBe(true))
    expect(result.current[0]).toBe('notes')
  })

  it('saves a change and shows it at once', async () => {
    const storage = memoryStorage()
    const { result } = renderHook(() => useLibrarySegment(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    act(() => result.current[1]('notes'))
    expect(result.current[0]).toBe('notes')
    expect(storage.data.get(LIBRARY_SEGMENT_KEY)).toBe('notes')
  })

  it('keeps a change made before the stored segment loads', async () => {
    let release!: (value: string) => void
    const storage = memoryStorage()
    storage.getItem.mockImplementation(
      () => new Promise<string>(r => (release = r))
    )
    const { result } = renderHook(() => useLibrarySegment(storage))
    act(() => result.current[1]('notes'))
    await act(async () => release('chats'))
    expect(result.current[0]).toBe('notes')
    expect(result.current[2]).toBe(true)
  })

  it('loads as chats when storage cannot be read', async () => {
    const storage = memoryStorage()
    storage.getItem.mockRejectedValue(new Error('unreadable'))
    const { result } = renderHook(() => useLibrarySegment(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    expect(result.current[0]).toBe('chats')
  })

  it('keeps the change when the save fails', async () => {
    const storage = memoryStorage()
    storage.setItem.mockRejectedValue(new Error('full'))
    const { result } = renderHook(() => useLibrarySegment(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    await act(async () => result.current[1]('notes'))
    expect(result.current[0]).toBe('notes')
  })

  it('uses Capacitor Preferences by default', async () => {
    prefs.get.mockResolvedValue({ value: 'notes' })
    prefs.set.mockResolvedValue()
    const { result } = renderHook(() => useLibrarySegment())
    await waitFor(() => expect(result.current[0]).toBe('notes'))
    expect(prefs.get).toHaveBeenCalledWith({ key: LIBRARY_SEGMENT_KEY })
    act(() => result.current[1]('chats'))
    expect(prefs.set).toHaveBeenCalledWith({
      key: LIBRARY_SEGMENT_KEY,
      value: 'chats'
    })
  })
})
