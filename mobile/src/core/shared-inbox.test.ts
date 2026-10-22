import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SHARED_ITEM_MAX_AGE_MS,
  takeSharedItem,
  useSharedItem
} from '@/core/shared-inbox'

type AppListener = (state: { isActive: boolean }) => void

const native = vi.hoisted(() => ({
  take: vi.fn(async (): Promise<{ text?: string; createdAt?: number }> => ({})),
  registered: [] as Array<{ name: string; options: unknown }>
}))

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn((name: string, options: unknown) => {
    native.registered.push({ name, options })
    return { take: native.take }
  })
}))

const app = vi.hoisted(() => ({
  listeners: [] as Array<{ event: string; listener: AppListener }>,
  remove: vi.fn(async () => {})
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: AppListener) => {
      app.listeners.push({ event, listener })
      return { remove: app.remove }
    })
  }
}))

const NOW = 1_800_000_000_000

const appState = (isActive: boolean) =>
  app.listeners
    .filter(l => l.event === 'appStateChange')
    .forEach(l => l.listener({ isActive }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  app.listeners.length = 0
  native.take.mockResolvedValue({})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the SharedInbox plugin', () => {
  it('is the native SharedInbox, with a web stand-in that holds nothing', async () => {
    expect(native.registered).toHaveLength(1)
    const [{ name, options }] = native.registered
    expect(name).toBe('SharedInbox')
    const web = (options as { web: { take: () => Promise<unknown> } }).web
    await expect(web.take()).resolves.toEqual({})
  })
})

describe('takeSharedItem', () => {
  it('returns the shared text', async () => {
    native.take.mockResolvedValue({
      text: 'Look at this\nhttps://example.com',
      createdAt: NOW - 1000
    })
    await expect(takeSharedItem()).resolves.toBe(
      'Look at this\nhttps://example.com'
    )
    expect(native.take).toHaveBeenCalledOnce()
  })

  it('returns null when the inbox is empty', async () => {
    await expect(takeSharedItem()).resolves.toBeNull()
  })

  it('ignores an item older than 24 hours', async () => {
    native.take.mockResolvedValue({
      text: 'old news',
      createdAt: NOW - SHARED_ITEM_MAX_AGE_MS - 1
    })
    await expect(takeSharedItem()).resolves.toBeNull()
  })

  it('keeps an item exactly 24 hours old', async () => {
    native.take.mockResolvedValue({
      text: 'just in time',
      createdAt: NOW - SHARED_ITEM_MAX_AGE_MS
    })
    await expect(takeSharedItem()).resolves.toBe('just in time')
  })

  it('ignores an item with no time or blank text', async () => {
    native.take.mockResolvedValue({ text: 'no time' })
    await expect(takeSharedItem()).resolves.toBeNull()
    native.take.mockResolvedValue({ text: '   ', createdAt: NOW })
    await expect(takeSharedItem()).resolves.toBeNull()
  })

  it('trims the text to 2000 characters', async () => {
    native.take.mockResolvedValue({
      text: `  ${'a'.repeat(3000)}`,
      createdAt: NOW
    })
    await expect(takeSharedItem()).resolves.toBe('a'.repeat(2000))
  })

  // The Share extension counts characters as Swift does (grapheme clusters);
  // the app must count the same way, or it re-cuts what the extension kept.
  it('counts characters as the Share extension does, so it never re-cuts its text', async () => {
    // 2000 characters, 4000 UTF-16 units: all kept.
    const emoji = '😀'.repeat(2000)
    native.take.mockResolvedValue({ text: emoji, createdAt: NOW })
    await expect(takeSharedItem()).resolves.toBe(emoji)

    // A family emoji is one character of 8 UTF-16 units.
    const families = '👨‍👩‍👧'.repeat(2000)
    native.take.mockResolvedValue({ text: families, createdAt: NOW })
    await expect(takeSharedItem()).resolves.toBe(families)
  })

  it('cuts by characters, never through one', async () => {
    native.take.mockResolvedValue({
      text: '👨‍👩‍👧'.repeat(2001),
      createdAt: NOW
    })
    await expect(takeSharedItem()).resolves.toBe('👨‍👩‍👧'.repeat(2000))
  })

  it('keeps a trailing link whole when it has to cut', async () => {
    const link = 'https://example.com/article?id=1'
    native.take.mockResolvedValue({
      text: `${'a'.repeat(3000)}\n${link}`,
      createdAt: NOW
    })
    const text = await takeSharedItem()
    expect(text).toBe(`${'a'.repeat(2000 - link.length - 1)}\n${link}`)
    expect(text).toHaveLength(2000)
  })

  it('cuts a too-long trailing link like any text', async () => {
    const link = `https://example.com/${'p'.repeat(2500)}`
    native.take.mockResolvedValue({ text: `hi\n${link}`, createdAt: NOW })
    await expect(takeSharedItem()).resolves.toBe(`hi\n${link}`.slice(0, 2000))
  })

  it('keeps the link alone when nothing else fits', async () => {
    const link = `https://example.com/${'p'.repeat(1979)}`
    expect(link).toHaveLength(1999)
    native.take.mockResolvedValue({ text: `intro\n${link}`, createdAt: NOW })
    await expect(takeSharedItem()).resolves.toBe(link)
  })

  it('counts code points where the WebView has no Intl.Segmenter', async () => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined })
    try {
      native.take.mockResolvedValue({
        text: '😀'.repeat(2001),
        createdAt: NOW
      })
      await expect(takeSharedItem()).resolves.toBe('😀'.repeat(2000))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns null when the native side fails (an app without the plugin)', async () => {
    native.take.mockRejectedValue(new Error('UNIMPLEMENTED'))
    await expect(takeSharedItem()).resolves.toBeNull()
  })
})

describe('useSharedItem', () => {
  it('takes the inbox once on mount and hands over its text', async () => {
    native.take.mockResolvedValueOnce({ text: 'shared', createdAt: NOW })
    const onText = vi.fn()
    renderHook(() => useSharedItem(onText))
    await act(async () => {})

    expect(onText).toHaveBeenCalledExactlyOnceWith('shared')
    expect(native.take).toHaveBeenCalledOnce()
  })

  it('takes it again each time the app becomes active, not when it leaves', async () => {
    const onText = vi.fn()
    renderHook(() => useSharedItem(onText))
    await act(async () => {})
    expect(onText).not.toHaveBeenCalled()

    native.take.mockResolvedValueOnce({ text: 'later', createdAt: NOW })
    await act(async () => appState(false))
    expect(native.take).toHaveBeenCalledOnce()
    await act(async () => appState(true))

    expect(native.take).toHaveBeenCalledTimes(2)
    expect(onText).toHaveBeenCalledExactlyOnceWith('later')
  })

  it('hands nothing over for an empty or stale inbox', async () => {
    native.take.mockResolvedValueOnce({ text: 'stale', createdAt: 0 })
    const onText = vi.fn()
    renderHook(() => useSharedItem(onText))
    await act(async () => {})
    await act(async () => appState(true))

    expect(native.take).toHaveBeenCalledTimes(2)
    expect(onText).not.toHaveBeenCalled()
  })

  it('calls the latest callback', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ cb }) => useSharedItem(cb), {
      initialProps: { cb: first }
    })
    await act(async () => {})
    rerender({ cb: second })

    native.take.mockResolvedValueOnce({ text: 'new', createdAt: NOW })
    await act(async () => appState(true))

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith('new')
  })

  it('stops listening when unmounted', async () => {
    const { unmount } = renderHook(() => useSharedItem(vi.fn()))
    await act(async () => {})
    unmount()
    await act(async () => {})
    expect(app.remove).toHaveBeenCalledOnce()
  })
})
