import { Capacitor } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  armSplashFailsafe,
  hideSplash,
  resetSplashForTests,
  SPLASH_FALLBACK_MS,
  useHideSplash
} from '@/app/splash'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true) }
}))

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn(async () => {}) }
}))

beforeEach(() => {
  vi.useFakeTimers()
  resetSplashForTests()
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true)
  vi.mocked(SplashScreen.hide).mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('armSplashFailsafe', () => {
  it('hides the splash once at the timeout on native, without React', () => {
    armSplashFailsafe()
    vi.advanceTimersByTime(SPLASH_FALLBACK_MS - 1)
    expect(SplashScreen.hide).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })

  it('takes a custom timeout', () => {
    armSplashFailsafe(100)
    vi.advanceTimersByTime(100)
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })

  it('never fires on the web', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false)
    armSplashFailsafe()
    vi.advanceTimersByTime(SPLASH_FALLBACK_MS)
    expect(SplashScreen.hide).not.toHaveBeenCalled()
  })

  it('does not hide again when the app already hid the splash', () => {
    armSplashFailsafe()
    renderHook(() => useHideSplash(true))
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(SPLASH_FALLBACK_MS)
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })
})

describe('hideSplash', () => {
  it('hides once however often it is called', () => {
    hideSplash()
    hideSplash()
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })

  it('does nothing on the web', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false)
    hideSplash()
    expect(SplashScreen.hide).not.toHaveBeenCalled()
  })
})

describe('useHideSplash', () => {
  it('keeps the splash up until the app is ready, then hides it once', () => {
    const { rerender } = renderHook(({ ready }) => useHideSplash(ready), {
      initialProps: { ready: false }
    })
    expect(SplashScreen.hide).not.toHaveBeenCalled()

    rerender({ ready: true })
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)

    rerender({ ready: true })
    act(() => vi.advanceTimersByTime(SPLASH_FALLBACK_MS))
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })

  it('hides at once when ready from the start', () => {
    renderHook(() => useHideSplash(true))
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })

  it('hides anyway after the fallback timeout', () => {
    renderHook(() => useHideSplash(false))

    act(() => vi.advanceTimersByTime(SPLASH_FALLBACK_MS - 1))
    expect(SplashScreen.hide).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })

  it('does not hide twice when ready comes after the fallback', () => {
    const { rerender } = renderHook(({ ready }) => useHideSplash(ready), {
      initialProps: { ready: false }
    })
    act(() => vi.advanceTimersByTime(SPLASH_FALLBACK_MS))
    rerender({ ready: true })
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })

  it('cancels the fallback on unmount', () => {
    const { unmount } = renderHook(() => useHideSplash(false))
    unmount()
    act(() => vi.advanceTimersByTime(SPLASH_FALLBACK_MS))
    expect(SplashScreen.hide).not.toHaveBeenCalled()
  })

  it('swallows a failed hide', async () => {
    vi.mocked(SplashScreen.hide).mockRejectedValue(new Error('no splash'))
    renderHook(() => useHideSplash(true))
    await act(async () => {})
    expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
  })

  it('never calls the native splash on the web', () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false)
    const { rerender } = renderHook(({ ready }) => useHideSplash(ready), {
      initialProps: { ready: false }
    })
    act(() => vi.advanceTimersByTime(SPLASH_FALLBACK_MS))
    rerender({ ready: true })
    expect(SplashScreen.hide).not.toHaveBeenCalled()
  })
})
