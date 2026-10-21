import { Preferences } from '@capacitor/preferences'
import {
  act,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_SEARCH_SETTINGS,
  SEARCH_SETTINGS_KEY
} from '@/features/compose/search-settings'
import {
  SearchSettingsProvider,
  useSharedSearchSettings
} from '@/features/compose/SearchSettingsProvider'
import type { SearchSettings } from '@/features/thread/chat-body'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
}))

const QUALITY: SearchSettings = { searchMode: 'quality', sources: ['web'] }

beforeEach(() => {
  vi.clearAllMocks()
})

function Probe({ name }: { name: string }) {
  const [settings, setSettings] = useSharedSearchSettings()
  return (
    <button
      type="button"
      data-testid={name}
      onClick={() => setSettings(QUALITY)}
    >
      {settings.searchMode}
    </button>
  )
}

describe('SearchSettingsProvider', () => {
  it('gives every reader the same settings, so a change shows everywhere', async () => {
    const storage = memoryStorage()
    render(
      <SearchSettingsProvider storage={storage}>
        <Probe name="home" />
        <Probe name="thread" />
      </SearchSettingsProvider>
    )
    await waitFor(() => expect(storage.getItem).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('thread')).toHaveTextContent('balanced')

    act(() => screen.getByTestId('home').click())

    expect(screen.getByTestId('home')).toHaveTextContent('quality')
    expect(screen.getByTestId('thread')).toHaveTextContent('quality')
    await waitFor(() =>
      expect(storage.data.get(SEARCH_SETTINGS_KEY)).toBe(
        JSON.stringify(QUALITY)
      )
    )
  })

  it('loads the stored settings once for all readers', async () => {
    const storage = memoryStorage({
      [SEARCH_SETTINGS_KEY]: JSON.stringify(QUALITY)
    })
    render(
      <SearchSettingsProvider storage={storage}>
        <Probe name="a" />
        <Probe name="b" />
      </SearchSettingsProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId('b')).toHaveTextContent('quality')
    )
    expect(storage.getItem).toHaveBeenCalledTimes(1)
  })

  it('keeps the settings in Capacitor Preferences by default', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SearchSettingsProvider>{children}</SearchSettingsProvider>
    )
    const { result } = renderHook(() => useSharedSearchSettings(), { wrapper })
    await waitFor(() =>
      expect(Preferences.get).toHaveBeenCalledWith({ key: SEARCH_SETTINGS_KEY })
    )
    expect(result.current[0]).toEqual(DEFAULT_SEARCH_SETTINGS)
  })

  it('throws when read outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useSharedSearchSettings())).toThrow(
      'useSharedSearchSettings must be used inside a SearchSettingsProvider'
    )
    vi.mocked(console.error).mockRestore()
  })
})
