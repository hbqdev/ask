import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useToday } from '@/features/library/useToday'

type AppStateListener = (state: { isActive: boolean }) => void
const app = vi.hoisted(() => ({
  listeners: [] as Array<(state: { isActive: boolean }) => void>
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, listener: AppStateListener) => {
      app.listeners.push(listener)
      return {
        remove: async () => {
          app.listeners.splice(app.listeners.indexOf(listener), 1)
        }
      }
    })
  }
}))

const appState = (isActive: boolean) =>
  act(() => {
    for (const listener of [...app.listeners]) listener({ isActive })
  })

beforeEach(() => {
  app.listeners.length = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 9, 21, 15, 30))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useToday', () => {
  it('is today’s local midnight, the same object between renders', () => {
    const { result, rerender } = renderHook(() => useToday())
    const first = result.current
    expect(first).toEqual(new Date(2026, 9, 21))
    vi.setSystemTime(new Date(2026, 9, 21, 23, 0))
    rerender()
    expect(result.current).toBe(first)
  })

  it('moves to the new day when the app comes back on another day', async () => {
    const { result } = renderHook(() => useToday())
    await act(async () => {})
    vi.setSystemTime(new Date(2026, 9, 22, 8, 0))
    appState(false)
    expect(result.current).toEqual(new Date(2026, 9, 21))
    appState(true)
    expect(result.current).toEqual(new Date(2026, 9, 22))
  })

  it('stops listening when unmounted', async () => {
    const { unmount } = renderHook(() => useToday())
    await act(async () => {})
    expect(app.listeners).toHaveLength(1)
    unmount()
    await act(async () => {})
    expect(app.listeners).toHaveLength(0)
  })
})
