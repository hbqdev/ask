import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { E2E_ASK_KEY, useE2eAsk } from '@/features/ask/e2e-ask'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
}))

const settle = () => act(async () => {})

describe('useE2eAsk', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the Preferences key "e2e-ask"', () => {
    expect(E2E_ASK_KEY).toBe('e2e-ask')
  })

  it('asks the seeded question once, removing the key before asking', async () => {
    const storage = memoryStorage({ [E2E_ASK_KEY]: '  What is new?  ' })
    let keyWhenAsked: string | undefined | null = 'unset'
    const onQuestion = vi.fn(() => {
      keyWhenAsked = storage.data.get(E2E_ASK_KEY) ?? null
    })
    const { rerender } = renderHook(() =>
      useE2eAsk(onQuestion, { enabled: true, ready: true, storage })
    )
    await settle()
    rerender()
    await settle()

    expect(onQuestion).toHaveBeenCalledExactlyOnceWith('What is new?')
    expect(storage.removeItem).toHaveBeenCalledExactlyOnceWith(E2E_ASK_KEY)
    expect(keyWhenAsked).toBeNull()
  })

  it('waits until ready (signed in, settings loaded)', async () => {
    const storage = memoryStorage({ [E2E_ASK_KEY]: 'Q' })
    const onQuestion = vi.fn()
    const { rerender } = renderHook(
      ({ ready }) => useE2eAsk(onQuestion, { enabled: true, ready, storage }),
      { initialProps: { ready: false } }
    )
    await settle()
    expect(storage.getItem).not.toHaveBeenCalled()

    rerender({ ready: true })
    await settle()
    expect(onQuestion).toHaveBeenCalledExactlyOnceWith('Q')
  })

  it('ignores the key entirely when the build is not an E2E build', async () => {
    const storage = memoryStorage({ [E2E_ASK_KEY]: 'Planted?' })
    const onQuestion = vi.fn()
    renderHook(() => useE2eAsk(onQuestion, { ready: true, storage }))
    await settle()

    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(storage.data.get(E2E_ASK_KEY)).toBe('Planted?')
    expect(onQuestion).not.toHaveBeenCalled()
  })

  it('is on in a VITE_E2E_AUTOSEND build', async () => {
    vi.stubEnv('VITE_E2E_AUTOSEND', 'true')
    const storage = memoryStorage({ [E2E_ASK_KEY]: 'Q' })
    const onQuestion = vi.fn()
    renderHook(() => useE2eAsk(onQuestion, { ready: true, storage }))
    await settle()
    expect(onQuestion).toHaveBeenCalledExactlyOnceWith('Q')
  })

  it.each([
    ['missing', undefined],
    ['blank', '   ']
  ])('does nothing when the key is %s', async (_label, value) => {
    const storage = memoryStorage(
      value === undefined ? {} : { [E2E_ASK_KEY]: value }
    )
    const onQuestion = vi.fn()
    renderHook(() =>
      useE2eAsk(onQuestion, { enabled: true, ready: true, storage })
    )
    await settle()

    expect(storage.getItem).toHaveBeenCalledWith(E2E_ASK_KEY)
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(onQuestion).not.toHaveBeenCalled()
  })

  it('logs a storage failure instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage()
    storage.getItem.mockRejectedValue(new Error('unreadable'))
    const onQuestion = vi.fn()
    renderHook(() =>
      useE2eAsk(onQuestion, { enabled: true, ready: true, storage })
    )
    await settle()

    expect(warn).toHaveBeenCalledWith(
      '[e2e] could not read the seeded question',
      expect.any(Error)
    )
    expect(onQuestion).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reads Capacitor Preferences by default', async () => {
    const { Preferences } = await import('@capacitor/preferences')
    renderHook(() => useE2eAsk(vi.fn(), { enabled: true, ready: true }))
    await settle()
    expect(Preferences.get).toHaveBeenCalledWith({ key: E2E_ASK_KEY })
  })
})
