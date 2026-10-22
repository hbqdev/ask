import { Browser } from '@capacitor/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isHttpUrl, openLink } from '@/features/thread/components/open-link'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

beforeEach(() => {
  vi.mocked(Browser.open).mockReset()
})

describe('openLink', () => {
  it('opens the URL in the in-app browser', () => {
    vi.mocked(Browser.open).mockResolvedValue()
    openLink('https://example.com/a')
    expect(Browser.open).toHaveBeenCalledWith({ url: 'https://example.com/a' })
  })

  it('opens a plain http URL too', () => {
    openLink('http://example.com/a')
    expect(Browser.open).toHaveBeenCalledWith({ url: 'http://example.com/a' })
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///etc/passwd',
    'mailto:a@example.com',
    'ask://ask?q=x',
    '/uploads/a.png',
    '//example.com/a',
    'not a url',
    ''
  ])('refuses %s without opening anything', url => {
    openLink(url)
    expect(Browser.open).not.toHaveBeenCalled()
  })

  it('handles a failure to open instead of leaving it unhandled', async () => {
    // A plain function, not vi.fn: a spy observes the promises its
    // implementation returns, which would mark the rejection handled.
    const mocked = Browser.open
    Browser.open = () => Promise.reject(new Error('no browser'))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      openLink('https://example.com/a')
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      Browser.open = mocked
    }
  })
})

describe('isHttpUrl', () => {
  it.each([
    ['https://example.com', true],
    ['HTTP://example.com/a', true],
    ['ftp://example.com', false],
    ['/uploads/a.png', false]
  ])('%s is %s', (url, expected) => {
    expect(isHttpUrl(url)).toBe(expected)
  })
})
