import { Preferences } from '@capacitor/preferences'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthStorage } from '@/core/auth/preferences-storage'
import { DARK_QUERY, THEME_STORAGE_KEY } from '@/core/theme'
import { ThemeProvider, useTheme } from '@/core/ThemeProvider'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: 'dark' })),
    set: vi.fn(async () => {}),
    remove: vi.fn()
  }
}))

type ChangeListener = (event: MediaQueryListEvent) => void

/** A stand-in for the device's dark setting, as matchMedia reports it. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<ChangeListener>()
  const state = { dark }
  const matchMedia = vi.fn((query: string) => ({
    media: query,
    get matches() {
      return state.dark
    },
    addEventListener: (_type: string, l: ChangeListener) => listeners.add(l),
    removeEventListener: (_type: string, l: ChangeListener) =>
      listeners.delete(l)
  }))
  vi.stubGlobal('matchMedia', matchMedia)
  return {
    matchMedia,
    listeners,
    /** Flips the device setting without telling anyone. */
    setQuietly(next: boolean) {
      state.dark = next
    },
    /** Flips the device setting and fires the change event. */
    set(next: boolean) {
      state.dark = next
      act(() => {
        for (const l of listeners) l({ matches: next } as MediaQueryListEvent)
      })
    }
  }
}

const never = () => new Promise<never>(() => {})

function setup(storage: AuthStorage) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider storage={storage}>{children}</ThemeProvider>
  )
  return renderHook(() => useTheme(), { wrapper })
}

const root = document.documentElement

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    root.className = ''
    root.style.colorScheme = ''
  })

  it('follows the system theme at once, before the stored choice loads', () => {
    fakeSystem(true)
    const storage = { ...memoryStorage(), getItem: vi.fn(never) }
    const { result } = setup(storage)

    expect(result.current.pref).toBe('system')
    expect(result.current.resolved).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
    expect(storage.getItem).toHaveBeenCalledWith(THEME_STORAGE_KEY)
  })

  it('restores the stored choice on mount', async () => {
    fakeSystem(false)
    const { result } = setup(memoryStorage({ theme: 'dark' }))

    await waitFor(() => expect(result.current.pref).toBe('dark'))
    expect(result.current.resolved).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
  })

  it('restores an explicit Light over a dark system', async () => {
    fakeSystem(true)
    const { result } = setup(memoryStorage({ theme: 'light' }))

    await waitFor(() => expect(result.current.pref).toBe('light'))
    expect(result.current.resolved).toBe('light')
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.colorScheme).toBe('light')
  })

  it.each([
    ['an unknown', { theme: 'sepia' }],
    ['a missing', {}]
  ])('treats %s stored value as System', async (_label, seed) => {
    fakeSystem(true)
    const storage = memoryStorage(seed)
    const { result } = setup(storage)

    await waitFor(() => expect(storage.getItem).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.pref).toBe('system')
    expect(result.current.resolved).toBe('dark')
  })

  it('stays on System when the stored choice cannot be read', async () => {
    fakeSystem(false)
    const storage = {
      ...memoryStorage(),
      getItem: vi.fn(async () => {
        throw new Error('storage unavailable')
      })
    }
    const { result } = setup(storage)

    await act(async () => {})
    expect(result.current.pref).toBe('system')
    expect(result.current.resolved).toBe('light')
  })

  it('reads Capacitor Preferences by default', async () => {
    fakeSystem(false)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider>{children}</ThemeProvider>
    )
    const { result } = renderHook(() => useTheme(), { wrapper })

    await waitFor(() => expect(result.current.pref).toBe('dark'))
    expect(Preferences.get).toHaveBeenCalledWith({ key: THEME_STORAGE_KEY })

    act(() => result.current.setPref('light'))
    expect(Preferences.set).toHaveBeenCalledWith({
      key: THEME_STORAGE_KEY,
      value: 'light'
    })
  })

  it('setPref applies the choice and persists it', async () => {
    fakeSystem(false)
    const storage = memoryStorage()
    const { result } = setup(storage)
    await act(async () => {})

    act(() => result.current.setPref('dark'))
    expect(result.current.pref).toBe('dark')
    expect(result.current.resolved).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark')

    act(() => result.current.setPref('light'))
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.colorScheme).toBe('light')
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe('light')
  })

  it('a choice made before the stored one loads wins', async () => {
    fakeSystem(false)
    let release: (value: string | null) => void = () => {}
    const storage = {
      ...memoryStorage(),
      getItem: vi.fn(
        () =>
          new Promise<string | null>(resolve => {
            release = resolve
          })
      )
    }
    const { result } = setup(storage)

    act(() => result.current.setPref('dark'))
    await act(async () => release('light'))
    expect(result.current.pref).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
  })

  it('keeps the choice in place when saving it fails', async () => {
    fakeSystem(false)
    const storage = {
      ...memoryStorage(),
      setItem: vi.fn(async () => {
        throw new Error('disk full')
      })
    }
    const { result } = setup(storage)
    await act(async () => {})

    await act(async () => result.current.setPref('dark'))
    expect(result.current.pref).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
  })

  it('in System mode follows the device setting as it changes', async () => {
    const system = fakeSystem(false)
    const { result } = setup(memoryStorage())
    await act(async () => {})
    expect(system.matchMedia).toHaveBeenCalledWith(DARK_QUERY)

    system.set(true)
    expect(result.current.resolved).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)

    system.set(false)
    expect(result.current.resolved).toBe('light')
    expect(root.classList.contains('dark')).toBe(false)
  })

  it('stops listening to the device on an explicit choice, and resumes on System', async () => {
    const system = fakeSystem(false)
    const { result } = setup(memoryStorage())
    await act(async () => {})
    expect(system.listeners.size).toBe(1)

    act(() => result.current.setPref('light'))
    expect(system.listeners.size).toBe(0)

    // The device turns dark while Light is chosen: nothing changes...
    system.setQuietly(true)
    expect(root.classList.contains('dark')).toBe(false)

    // ...until System is chosen again, which picks up the current setting.
    act(() => result.current.setPref('system'))
    expect(system.listeners.size).toBe(1)
    expect(result.current.resolved).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
  })

  it('is not loaded until the stored choice has been read', async () => {
    fakeSystem(false)
    let release: (value: string | null) => void = () => {}
    const storage = {
      ...memoryStorage(),
      getItem: vi.fn(
        () =>
          new Promise<string | null>(resolve => {
            release = resolve
          })
      )
    }
    const { result } = setup(storage)
    expect(result.current.loaded).toBe(false)

    await act(async () => release('dark'))
    expect(result.current.loaded).toBe(true)
    expect(result.current.pref).toBe('dark')
  })

  it('is loaded when the stored choice cannot be read', async () => {
    fakeSystem(false)
    const storage = {
      ...memoryStorage(),
      getItem: vi.fn(async () => {
        throw new Error('storage unavailable')
      })
    }
    const { result } = setup(storage)

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.pref).toBe('system')
  })

  it('stops listening to the device on unmount', async () => {
    const system = fakeSystem(false)
    const { unmount } = setup(memoryStorage())
    await act(async () => {})
    expect(system.listeners.size).toBe(1)

    unmount()
    expect(system.listeners.size).toBe(0)
  })
})

describe('useTheme', () => {
  it('throws outside ThemeProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useTheme())).toThrow(
      'useTheme must be used inside ThemeProvider'
    )
    vi.mocked(console.error).mockRestore()
  })
})
