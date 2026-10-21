import { Preferences } from '@capacitor/preferences'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SEARCH_SETTINGS,
  loadSearchSettings,
  parseSearchSettings,
  saveSearchSettings,
  SEARCH_SETTINGS_KEY,
  useSearchSettings
} from '@/features/compose/search-settings'
import type { SearchSettings } from '@/features/thread/chat-body'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

const prefs = vi.mocked(Preferences)

const QUALITY: SearchSettings = {
  searchMode: 'quality',
  sources: ['web', 'academic']
}

beforeEach(() => {
  vi.clearAllMocks()
})

it('uses the Preferences key "ask-search-settings" and balanced web defaults', () => {
  expect(SEARCH_SETTINGS_KEY).toBe('ask-search-settings')
  expect(DEFAULT_SEARCH_SETTINGS).toEqual({
    searchMode: 'balanced',
    sources: ['web']
  })
})

describe('parseSearchSettings', () => {
  it('keeps valid settings', () => {
    expect(parseSearchSettings(JSON.stringify(QUALITY))).toEqual(QUALITY)
  })

  it('drops duplicate sources', () => {
    expect(
      parseSearchSettings(
        JSON.stringify({ searchMode: 'speed', sources: ['web', 'web'] })
      )
    ).toEqual({ searchMode: 'speed', sources: ['web'] })
  })

  it.each([
    ['nothing stored', null],
    ['garbage JSON', '{not json'],
    ['a JSON non-object', '42'],
    ['JSON null', 'null'],
    ['an unknown mode', '{"searchMode":"turbo","sources":["web"]}'],
    ['an empty sources array', '{"searchMode":"balanced","sources":[]}'],
    [
      'an unknown source',
      '{"searchMode":"balanced","sources":["web","tiktok"]}'
    ],
    [
      'sources that are not an array',
      '{"searchMode":"balanced","sources":"web"}'
    ]
  ])('gives the defaults for %s', (_name, stored) => {
    expect(parseSearchSettings(stored)).toEqual(DEFAULT_SEARCH_SETTINGS)
  })

  it('falls back field by field', () => {
    expect(
      parseSearchSettings('{"searchMode":"turbo","sources":["social"]}')
    ).toEqual({ searchMode: 'balanced', sources: ['social'] })
    expect(parseSearchSettings('{"searchMode":"speed","sources":[]}')).toEqual({
      searchMode: 'speed',
      sources: ['web']
    })
  })

  it('never hands out the shared defaults object', () => {
    const parsed = parseSearchSettings(null)
    parsed.sources.push('social')
    expect(DEFAULT_SEARCH_SETTINGS.sources).toEqual(['web'])
  })
})

describe('loadSearchSettings / saveSearchSettings', () => {
  it('gives the defaults when nothing is stored', async () => {
    await expect(loadSearchSettings(memoryStorage())).resolves.toEqual(
      DEFAULT_SEARCH_SETTINGS
    )
  })

  it('round-trips settings through storage', async () => {
    const storage = memoryStorage()
    await saveSearchSettings(QUALITY, storage)
    expect(storage.setItem).toHaveBeenCalledWith(
      SEARCH_SETTINGS_KEY,
      JSON.stringify(QUALITY)
    )
    await expect(loadSearchSettings(storage)).resolves.toEqual(QUALITY)
  })

  it('gives the defaults for garbage in storage', async () => {
    const storage = memoryStorage({ [SEARCH_SETTINGS_KEY]: 'garbage' })
    await expect(loadSearchSettings(storage)).resolves.toEqual(
      DEFAULT_SEARCH_SETTINGS
    )
  })

  it('uses Capacitor Preferences by default', async () => {
    prefs.get.mockResolvedValue({ value: JSON.stringify(QUALITY) })
    prefs.set.mockResolvedValue(undefined)
    await expect(loadSearchSettings()).resolves.toEqual(QUALITY)
    expect(prefs.get).toHaveBeenCalledWith({ key: SEARCH_SETTINGS_KEY })
    await saveSearchSettings(DEFAULT_SEARCH_SETTINGS)
    expect(prefs.set).toHaveBeenCalledWith({
      key: SEARCH_SETTINGS_KEY,
      value: JSON.stringify(DEFAULT_SEARCH_SETTINGS)
    })
  })
})

describe('useSearchSettings', () => {
  it('starts on the defaults and moves to the stored settings', async () => {
    const storage = memoryStorage({
      [SEARCH_SETTINGS_KEY]: JSON.stringify(QUALITY)
    })
    const { result } = renderHook(() => useSearchSettings(storage))
    expect(result.current[0]).toEqual(DEFAULT_SEARCH_SETTINGS)
    await waitFor(() => expect(result.current[0]).toEqual(QUALITY))
  })

  it('updates at once and persists', async () => {
    const storage = memoryStorage()
    const { result } = renderHook(() => useSearchSettings(storage))
    await waitFor(() => expect(storage.getItem).toHaveBeenCalled())
    act(() => result.current[1](QUALITY))
    expect(result.current[0]).toEqual(QUALITY)
    await waitFor(() =>
      expect(storage.data.get(SEARCH_SETTINGS_KEY)).toBe(
        JSON.stringify(QUALITY)
      )
    )
  })

  it('keeps a choice made before the stored settings load', async () => {
    let finishLoad: (value: string | null) => void = () => {}
    const storage = memoryStorage()
    storage.getItem.mockImplementation(
      () => new Promise(resolve => (finishLoad = resolve))
    )
    const { result } = renderHook(() => useSearchSettings(storage))
    act(() => result.current[1](QUALITY))
    await act(async () =>
      finishLoad(JSON.stringify({ searchMode: 'speed', sources: ['social'] }))
    )
    expect(result.current[0]).toEqual(QUALITY)
  })

  it('stays on the defaults when storage cannot be read', async () => {
    const storage = memoryStorage()
    storage.getItem.mockRejectedValue(new Error('unreadable'))
    const { result } = renderHook(() => useSearchSettings(storage))
    await waitFor(() => expect(storage.getItem).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current[0]).toEqual(DEFAULT_SEARCH_SETTINGS)
  })

  it('keeps the new settings in memory when saving fails, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage()
    storage.setItem.mockRejectedValue(new Error('disk full'))
    const { result } = renderHook(() => useSearchSettings(storage))
    await waitFor(() => expect(storage.getItem).toHaveBeenCalled())
    act(() => result.current[1](QUALITY))
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current[0]).toEqual(QUALITY)
    warn.mockRestore()
  })
})
