import { describe, expect, it } from 'vitest'

import type { SearXNGResult } from '@/lib/types'
import type { BraveSearchResult } from '@/lib/utils/brave-search-client'

import { mergeBraveIntoSearxngResults } from '../merge-brave'

const sx = (url: string, title = 't'): SearXNGResult =>
  ({ title, url, content: 'sx content' }) as SearXNGResult
const bv = (url: string, title = 'b'): BraveSearchResult => ({
  title,
  url,
  content: 'brave snippet'
})

describe('mergeBraveIntoSearxngResults', () => {
  it('puts Brave first so its block-immune sources survive the pool cap', () => {
    const out = mergeBraveIntoSearxngResults(
      [sx('https://a.test'), sx('https://b.test')],
      [bv('https://z.test')],
      10
    )
    expect(out[0].url).toBe('https://z.test')
  })

  it('lets Brave win a URL collision, since its snippet is the better seed', () => {
    const out = mergeBraveIntoSearxngResults(
      [sx('https://dup.test', 'from searxng')],
      [bv('https://dup.test', 'from brave')],
      10
    )
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('from brave')
  })

  it('dedupes on normalized url, not raw string', () => {
    const out = mergeBraveIntoSearxngResults(
      [sx('https://dup.test/page?utm_source=x')],
      [bv('https://dup.test/page')],
      10
    )
    expect(out).toHaveLength(1)
  })

  it('dedupes within the Brave list itself', () => {
    const out = mergeBraveIntoSearxngResults(
      [],
      [bv('https://a.test'), bv('https://a.test')],
      10
    )
    expect(out).toHaveLength(1)
  })

  it('caps at maxResults', () => {
    const out = mergeBraveIntoSearxngResults(
      [sx('https://a.test'), sx('https://b.test')],
      [bv('https://c.test'), bv('https://d.test')],
      3
    )
    expect(out).toHaveLength(3)
  })

  it('drops entries with an unusable url instead of emitting them', () => {
    const out = mergeBraveIntoSearxngResults([], [bv('')], 10)
    expect(out).toEqual([])
  })

  it('is a no-op passthrough when Brave returned nothing', () => {
    const searxng = [sx('https://a.test'), sx('https://b.test')]
    expect(mergeBraveIntoSearxngResults(searxng, [], 10)).toEqual(searxng)
  })

  it('carries Brave content as-is and adds no per-item marker (route decides prefetch by url)', () => {
    const out = mergeBraveIntoSearxngResults([], [bv('https://a.test')], 10)
    // Prefetch (skip-crawl) is now decided by the advanced route via a URL set,
    // not by a property on the merged item — the merge stays a plain result
    // whose `content` is Brave's own description, used as-is when the route
    // marks the URL prefetched.
    expect('prefetched' in out[0]).toBe(false)
    expect(out[0].content).toBe('brave snippet')
  })
})
