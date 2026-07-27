import { describe, expect, it } from 'vitest'

import {
  applyCrawlCap,
  buildRankText,
  rankBySnippetScore
} from '../snippet-rank'

const c = (url: string, title?: string, content?: string) => ({
  url,
  title,
  content
})

describe('buildRankText', () => {
  it('joins title and snippet', () => {
    expect(buildRankText(c('u', 'Title', 'Snippet body'))).toBe(
      'Title\nSnippet body'
    )
  })

  it('tolerates a missing title', () => {
    expect(buildRankText(c('u', undefined, 'Snippet body'))).toBe(
      'Snippet body'
    )
  })

  it('tolerates a missing snippet', () => {
    expect(buildRankText(c('u', 'Title', undefined))).toBe('Title')
  })

  // The cross-encoder rejects empty passages, and a candidate with neither
  // title nor snippet would otherwise send one. Fall back to the URL, which
  // is always present and carries real signal (slug words).
  it('falls back to the url when there is no text at all', () => {
    expect(buildRankText(c('https://example.com/a'))).toBe(
      'https://example.com/a'
    )
  })
})

describe('rankBySnippetScore', () => {
  it('reorders by descending score', () => {
    const { ranked } = rankBySnippetScore(
      [c('a'), c('b'), c('d')],
      [0.1, 0.9, 0.5]
    )
    expect(ranked.map(r => r.url)).toEqual(['b', 'd', 'a'])
  })

  it('reports each url 0-based rank in the new order', () => {
    const { rankByUrl } = rankBySnippetScore(
      [c('a'), c('b'), c('d')],
      [0.1, 0.9, 0.5]
    )
    expect(rankByUrl.get('b')).toBe(0)
    expect(rankByUrl.get('d')).toBe(1)
    expect(rankByUrl.get('a')).toBe(2)
  })

  // A misaligned score array would silently reorder candidates by nonsense.
  // Returning the input untouched is the only safe response.
  it('returns the input order when scores length does not match', () => {
    const { ranked } = rankBySnippetScore([c('a'), c('b')], [0.9])
    expect(ranked.map(r => r.url)).toEqual(['a', 'b'])
  })

  it('preserves merge order for equal scores', () => {
    const { ranked } = rankBySnippetScore(
      [c('a'), c('b'), c('d')],
      [0.5, 0.5, 0.5]
    )
    expect(ranked.map(r => r.url)).toEqual(['a', 'b', 'd'])
  })

  it('returns empty for an empty pool', () => {
    const { ranked, rankByUrl } = rankBySnippetScore([], [])
    expect(ranked).toEqual([])
    expect(rankByUrl.size).toBe(0)
  })
})

describe('applyCrawlCap', () => {
  const pool = [c('a'), c('b'), c('d'), c('e')]

  it('keeps only the first topN', () => {
    expect(applyCrawlCap(pool, 2, new Set()).map(r => r.url)).toEqual([
      'a',
      'b'
    ])
  })

  // Ollama results arrive with full content and are excluded from the crawl
  // anyway, so capping them costs sources for zero time saved.
  it('keeps prefetched urls regardless of rank', () => {
    expect(applyCrawlCap(pool, 2, new Set(['e'])).map(r => r.url)).toEqual([
      'a',
      'b',
      'e'
    ])
  })

  it('does not let prefetched urls consume a cap slot', () => {
    expect(applyCrawlCap(pool, 2, new Set(['a'])).map(r => r.url)).toEqual([
      'a',
      'b',
      'd'
    ])
  })

  it('returns the pool unchanged when topN exceeds its size', () => {
    expect(applyCrawlCap(pool, 99, new Set())).toHaveLength(4)
  })

  it('returns the pool unchanged when topN is zero or negative', () => {
    expect(applyCrawlCap(pool, 0, new Set())).toHaveLength(4)
    expect(applyCrawlCap(pool, -1, new Set())).toHaveLength(4)
  })
})
