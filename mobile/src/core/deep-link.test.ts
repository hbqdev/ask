import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { App } from '@capacitor/app'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseAskUrl, useAskDeepLink } from '@/core/deep-link'

type UrlOpenListener = (event: { url: string }) => void

const app = vi.hoisted(() => ({
  listeners: [] as Array<(event: { url: string }) => void>,
  remove: vi.fn(async () => {})
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, listener: UrlOpenListener) => {
      app.listeners.push(listener)
      return { remove: app.remove }
    })
  }
}))

const open = (url: string) => app.listeners.forEach(l => l({ url }))

describe('parseAskUrl', () => {
  it('reads the question from ask://ask?q=', () => {
    expect(parseAskUrl('ask://ask?q=hello%20world')).toEqual({
      question: 'hello world'
    })
  })

  it('accepts a trailing slash before the query', () => {
    expect(parseAskUrl('ask://ask/?q=hi')).toEqual({ question: 'hi' })
  })

  it('trims the question', () => {
    expect(parseAskUrl('ask://ask?q=%20%20why%3F%20')).toEqual({
      question: 'why?'
    })
  })

  it('trims a long question to 2000 characters', () => {
    const q = 'a'.repeat(3000)
    expect(parseAskUrl(`ask://ask?q=${q}`)?.question).toHaveLength(2000)
  })

  it.each([
    ['another scheme', 'https://ask?q=hello'],
    ['another host', 'ask://search?q=hello'],
    ['a path', 'ask://ask/other?q=hello'],
    ['no q', 'ask://ask'],
    ['a blank q', 'ask://ask?q=%20%20'],
    ['an empty q', 'ask://ask?q='],
    ['not a URL', 'not a url']
  ])('rejects %s', (_label, url) => {
    expect(parseAskUrl(url)).toBeNull()
  })
})

describe('useAskDeepLink', () => {
  beforeEach(() => {
    app.listeners.length = 0
    vi.clearAllMocks()
  })

  it('calls onQuestion for an ask:// URL the app is opened with', async () => {
    const onQuestion = vi.fn()
    renderHook(() => useAskDeepLink(onQuestion))
    await act(async () => {})

    expect(App.addListener).toHaveBeenCalledWith(
      'appUrlOpen',
      expect.any(Function)
    )
    open('ask://ask?q=deep%20link')
    expect(onQuestion).toHaveBeenCalledExactlyOnceWith('deep link')
  })

  it('ignores a URL that is not a question', async () => {
    const onQuestion = vi.fn()
    renderHook(() => useAskDeepLink(onQuestion))
    await act(async () => {})

    open('ask://settings')
    expect(onQuestion).not.toHaveBeenCalled()
  })

  it('calls the latest onQuestion without adding a second listener', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ cb }) => useAskDeepLink(cb), {
      initialProps: { cb: first }
    })
    rerender({ cb: second })
    await act(async () => {})

    open('ask://ask?q=x')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('x')
    expect(App.addListener).toHaveBeenCalledTimes(1)
  })

  it('removes the listener on unmount', async () => {
    const { unmount } = renderHook(() => useAskDeepLink(vi.fn()))
    await act(async () => {})

    unmount()
    await act(async () => {})
    expect(app.remove).toHaveBeenCalledTimes(1)
  })
})

describe('the iOS app', () => {
  it('registers the ask:// URL scheme', () => {
    const plist = readFileSync(
      resolve(__dirname, '../../ios/App/App/Info.plist'),
      'utf8'
    )
    expect(plist).toMatch(
      /<key>CFBundleURLTypes<\/key>\s*<array>\s*<dict>\s*<key>CFBundleURLName<\/key>\s*<string>win\.hbqnexus\.ask<\/string>\s*<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>ask<\/string>\s*<\/array>\s*<\/dict>\s*<\/array>/
    )
  })
})
