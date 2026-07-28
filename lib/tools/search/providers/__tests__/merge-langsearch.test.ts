import { describe, expect, it } from 'vitest'

import type { SearXNGResult } from '@/lib/types'
import type { LangSearchResult } from '@/lib/utils/langsearch-client'

import { mergeLangSearchIntoSearxngResults } from '../merge-langsearch'

const sx = (url: string, content = 'sx'): SearXNGResult =>
  ({ title: 't', url, content }) as SearXNGResult
const ls = (url: string, content = 'ls'): LangSearchResult => ({
  title: 'l',
  url,
  content
})

describe('mergeLangSearchIntoSearxngResults', () => {
  it('puts LangSearch first so block-immune sources survive the pool cap', () => {
    const out = mergeLangSearchIntoSearxngResults(
      [sx('https://a.com')],
      [ls('https://b.com')],
      10
    )
    expect(out.map(r => r.url)).toEqual(['https://b.com', 'https://a.com'])
  })

  it('wins the dedup on a URL collision', () => {
    // Its snippet is richer than a SearXNG one, and it is the copy that
    // survived the cap ordering, so it should be the one kept.
    const out = mergeLangSearchIntoSearxngResults(
      [sx('https://a.com', 'searxng snippet')],
      [ls('https://a.com', 'langsearch text')],
      10
    )
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('langsearch text')
  })

  it('dedups on NORMALIZED url, not raw string', () => {
    const out = mergeLangSearchIntoSearxngResults(
      [sx('https://a.com/page/')],
      [ls('https://a.com/page')],
      10
    )
    expect(out).toHaveLength(1)
  })

  it('respects the candidate-pool cap', () => {
    const out = mergeLangSearchIntoSearxngResults(
      [sx('https://a.com'), sx('https://b.com')],
      [ls('https://c.com'), ls('https://d.com')],
      3
    )
    expect(out).toHaveLength(3)
    // The cap must not starve SearXNG entirely — LangSearch leads but the
    // remainder is still filled from the local engines.
    expect(out.map(r => r.url)).toEqual([
      'https://c.com',
      'https://d.com',
      'https://a.com'
    ])
  })

  it('is a no-op shape when LangSearch returned nothing', () => {
    const out = mergeLangSearchIntoSearxngResults([sx('https://a.com')], [], 10)
    expect(out.map(r => r.url)).toEqual(['https://a.com'])
  })

  it('skips entries with an unusable url instead of emitting a dead candidate', () => {
    const out = mergeLangSearchIntoSearxngResults(
      [sx('https://a.com')],
      [ls('')],
      10
    )
    expect(out.map(r => r.url)).toEqual(['https://a.com'])
  })
})
