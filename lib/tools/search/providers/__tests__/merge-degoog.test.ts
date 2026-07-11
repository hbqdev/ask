import { describe, expect, it } from 'vitest'

import type { DegoogResult, SearchResultItem } from '@/lib/types'

import { mergeWithDegoogResults, toSearchResultItem } from '../merge-degoog'

function searxngItem(url: string, title = url): SearchResultItem {
  return { title, url, content: `content for ${title}` }
}

function degoogResult(
  url: string,
  overrides: Partial<DegoogResult> = {}
): DegoogResult {
  return {
    title: overrides.title ?? url,
    url,
    snippet: `snippet for ${url}`,
    ...overrides
  }
}

describe('mergeWithDegoogResults', () => {
  it('dedupes an exact-duplicate URL appearing in both lists', () => {
    const merged = mergeWithDegoogResults(
      [
        searxngItem('https://example.com/a'),
        searxngItem('https://example.com/b')
      ],
      [
        degoogResult('https://example.com/a'),
        degoogResult('https://example.com/c')
      ],
      10
    )

    const urls = merged.map(r => r.url)
    expect(urls.filter(u => u === 'https://example.com/a')).toHaveLength(1)
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://example.com/a',
        'https://example.com/b',
        'https://example.com/c'
      ])
    )
  })

  it('treats http/https and www./no-www as the same URL for dedup', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('http://www.example.com/page/')],
      [degoogResult('https://example.com/page')],
      10
    )

    expect(merged).toHaveLength(1)
  })

  it('does NOT collapse distinct pages that differ only by a real query param', () => {
    // A naive host+path-only normalization would wrongly merge these.
    const merged = mergeWithDegoogResults(
      [searxngItem('https://youtube.com/watch?v=abc')],
      [degoogResult('https://youtube.com/watch?v=xyz')],
      10
    )

    expect(merged).toHaveLength(2)
    expect(merged.map(r => r.url)).toEqual(
      expect.arrayContaining([
        'https://youtube.com/watch?v=abc',
        'https://youtube.com/watch?v=xyz'
      ])
    )
  })

  it('ignores tracking params when deduping', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('https://example.com/article?utm_source=newsletter')],
      [
        degoogResult(
          'https://example.com/article?utm_source=twitter&utm_medium=social'
        )
      ],
      10
    )

    expect(merged).toHaveLength(1)
  })

  it('interleaves rank order, draining the longer list once the shorter is exhausted', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('https://s1.com'), searxngItem('https://s2.com')],
      [
        degoogResult('https://d1.com'),
        degoogResult('https://d2.com'),
        degoogResult('https://d3.com'),
        degoogResult('https://d4.com')
      ],
      10
    )

    expect(merged.map(r => r.url)).toEqual([
      'https://s1.com',
      'https://d1.com',
      'https://s2.com',
      'https://d2.com',
      'https://d3.com',
      'https://d4.com'
    ])
  })

  it('promotes niche-source degoog results ahead of mainstream duplicates so they survive truncation', () => {
    // 4 mainstream SearXNG results fill maxResults before degoog's niche
    // result would ever get an interleaved slot under strict alternation.
    const searxngResults = [
      searxngItem('https://mainstream1.com'),
      searxngItem('https://mainstream2.com'),
      searxngItem('https://mainstream3.com'),
      searxngItem('https://mainstream4.com')
    ]
    const degoogResults = [
      degoogResult('https://reddit.com/r/thread', { source: 'Reddit' }),
      degoogResult('https://mainstream5.com', { source: 'Brave Search' })
    ]

    const merged = mergeWithDegoogResults(searxngResults, degoogResults, 3)

    expect(merged.map(r => r.url)).toContain('https://reddit.com/r/thread')
  })

  it('matches niche sources via the sources[] array too, not just source', () => {
    const merged = mergeWithDegoogResults(
      [
        searxngItem('https://m1.com'),
        searxngItem('https://m2.com'),
        searxngItem('https://m3.com')
      ],
      [
        degoogResult('https://news.ycombinator.com/item?id=1', {
          source: 'Brave Search',
          sources: ['Brave Search', 'Hacker News']
        })
      ],
      2
    )

    expect(merged.map(r => r.url)).toContain(
      'https://news.ycombinator.com/item?id=1'
    )
  })

  it('slices to maxResults after merging', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('https://s1.com'), searxngItem('https://s2.com')],
      [degoogResult('https://d1.com'), degoogResult('https://d2.com')],
      2
    )

    expect(merged).toHaveLength(2)
  })

  it('handles an empty degoog list (falls back to SearXNG order untouched)', () => {
    const merged = mergeWithDegoogResults(
      [searxngItem('https://s1.com'), searxngItem('https://s2.com')],
      [],
      10
    )

    expect(merged.map(r => r.url)).toEqual(['https://s1.com', 'https://s2.com'])
  })
})

describe('toSearchResultItem', () => {
  it('maps a degoog result into the shared SearchResultItem shape', () => {
    const item = toSearchResultItem(
      degoogResult('https://example.com', {
        title: 'Example',
        snippet: 'An example snippet'
      })
    )

    expect(item).toEqual({
      title: 'Example',
      url: 'https://example.com',
      content: 'An example snippet'
    })
  })
})
