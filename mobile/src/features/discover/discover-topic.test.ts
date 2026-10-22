import { Preferences } from '@capacitor/preferences'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TOPICS } from '@/features/discover/discover-api'
import {
  DISCOVER_TOPIC_KEY,
  parseDiscoverTopic,
  useDiscoverTopic
} from '@/features/discover/discover-topic'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

const prefs = vi.mocked(Preferences)

beforeEach(() => {
  vi.clearAllMocks()
})

it('uses the Preferences key "ask-discover-topic"', () => {
  expect(DISCOVER_TOPIC_KEY).toBe('ask-discover-topic')
})

describe('parseDiscoverTopic', () => {
  it.each(TOPICS.map(t => t.key))('keeps %s', topic => {
    expect(parseDiscoverTopic(topic)).toBe(topic)
  })

  it.each([
    ['nothing stored', null],
    ['an unknown topic', 'politics'],
    ['an empty string', ''],
    ['a label, not a key', 'Tech']
  ])('falls back to tech for %s', (_, value) => {
    expect(parseDiscoverTopic(value)).toBe('tech')
  })
})

describe('useDiscoverTopic', () => {
  it('starts on tech, not loaded, then loads the stored topic', async () => {
    const storage = memoryStorage({ [DISCOVER_TOPIC_KEY]: 'gaming' })
    const { result } = renderHook(() => useDiscoverTopic(storage))
    expect(result.current[0]).toBe('tech')
    expect(result.current[2]).toBe(false)
    await waitFor(() => expect(result.current[2]).toBe(true))
    expect(result.current[0]).toBe('gaming')
  })

  it('loads an invalid stored value as tech', async () => {
    const storage = memoryStorage({ [DISCOVER_TOPIC_KEY]: 'nonsense' })
    const { result } = renderHook(() => useDiscoverTopic(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    expect(result.current[0]).toBe('tech')
  })

  it('saves a change and shows it at once', async () => {
    const storage = memoryStorage()
    const { result } = renderHook(() => useDiscoverTopic(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    act(() => result.current[1]('science'))
    expect(result.current[0]).toBe('science')
    expect(storage.data.get(DISCOVER_TOPIC_KEY)).toBe('science')
  })

  it('keeps a change made before the stored topic loads', async () => {
    let release!: (value: string) => void
    const storage = memoryStorage()
    storage.getItem.mockImplementation(
      () => new Promise<string>(r => (release = r))
    )
    const { result } = renderHook(() => useDiscoverTopic(storage))
    act(() => result.current[1]('world'))
    await act(async () => release('health'))
    expect(result.current[0]).toBe('world')
    expect(result.current[2]).toBe(true)
  })

  it('loads as tech when storage cannot be read', async () => {
    const storage = memoryStorage()
    storage.getItem.mockRejectedValue(new Error('unreadable'))
    const { result } = renderHook(() => useDiscoverTopic(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    expect(result.current[0]).toBe('tech')
  })

  it('keeps the change when the save fails', async () => {
    const storage = memoryStorage()
    storage.setItem.mockRejectedValue(new Error('full'))
    const { result } = renderHook(() => useDiscoverTopic(storage))
    await waitFor(() => expect(result.current[2]).toBe(true))
    await act(async () => result.current[1]('art'))
    expect(result.current[0]).toBe('art')
  })

  it('uses Capacitor Preferences by default', async () => {
    prefs.get.mockResolvedValue({ value: 'finance' })
    prefs.set.mockResolvedValue()
    const { result } = renderHook(() => useDiscoverTopic())
    await waitFor(() => expect(result.current[0]).toBe('finance'))
    expect(prefs.get).toHaveBeenCalledWith({ key: DISCOVER_TOPIC_KEY })
    act(() => result.current[1]('sports'))
    expect(prefs.set).toHaveBeenCalledWith({
      key: DISCOVER_TOPIC_KEY,
      value: 'sports'
    })
  })
})
