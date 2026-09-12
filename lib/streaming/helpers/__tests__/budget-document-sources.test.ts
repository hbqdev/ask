import type { ModelMessage } from 'ai'
import { describe, expect, test } from 'vitest'

import { budgetDocumentSources } from '../budget-document-sources'
import type { DocumentRetrievalInput } from '../document-retrieval-part'

// ~4 chars/token in the estimator's fallback; use tiktoken-friendly words so
// the counts are stable. Each 'word ' repetition is roughly one token.
const words = (n: number) => Array(n).fill('word').join(' ')

const source = (
  id: string,
  chunkTokenSizes: number[]
): DocumentRetrievalInput => ({
  sourceId: id,
  title: 'Doc',
  url: `https://example.com/${id}`,
  chunks: chunkTokenSizes.map(n => words(n)),
  query: 'q'
})

const msg = (tokens: number): ModelMessage => ({
  role: 'user',
  content: words(tokens)
})

describe('budgetDocumentSources', () => {
  test('passes everything through when it all fits', () => {
    const sources = [source('a', [50, 50]), source('b', [50])]
    const res = budgetDocumentSources(sources, [msg(100)], 100000, 'kimi')
    expect(res.clipped).toBe(false)
    expect(res.droppedChunks).toBe(0)
    expect(res.droppedSources).toBe(0)
    expect(res.sources).toStrictEqual(sources) // content preserved unchanged
    expect(res.sources[0].chunks).toBe(sources[0].chunks) // survivor untrimmed
  })

  test('never trims when the window is unknown (null)', () => {
    const sources = [source('a', [5000, 5000])]
    const res = budgetDocumentSources(sources, [msg(10)], null, 'kimi')
    expect(res.clipped).toBe(false)
    expect(res.sources).toBe(sources)
  })

  test('hardCap 0 disables the clip entirely (pre-fix behavior)', () => {
    const sources = [source('a', [10000])]
    // Tiny window that would otherwise drop everything, but hardCap 0 = off.
    const res = budgetDocumentSources(sources, [msg(10)], 100, 'kimi', 0)
    expect(res.clipped).toBe(false)
    expect(res.sources).toBe(sources)
  })

  test('drops the lowest-ranked (trailing) chunks of a source first', () => {
    // One source, chunks best-first. Budget fits only the first ~2 chunks.
    const sources = [source('a', [200, 200, 200, 200])]
    // used ~10 tok; window small so only ~2 chunks of ~200 fit.
    const res = budgetDocumentSources(sources, [msg(10)], 500, 'kimi')
    expect(res.clipped).toBe(true)
    expect(res.sources).toHaveLength(1)
    const kept = res.sources[0].chunks
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(4)
    // Survivors are the CONTIGUOUS top slice (anchors stay #chunk-1..#chunk-N).
    expect(kept).toEqual(sources[0].chunks.slice(0, kept.length))
  })

  test('funds the newest source first, dropping older sources entirely', () => {
    // Two large sources; the window only funds one. 'b' (newest, last) wins.
    const sources = [source('a', [300]), source('b', [300])]
    const res = budgetDocumentSources(sources, [msg(10)], 400, 'kimi')
    expect(res.clipped).toBe(true)
    expect(res.droppedSources).toBe(1)
    expect(res.sources).toHaveLength(1)
    expect(res.sources[0].sourceId).toBe('b')
  })

  test('drops all doc content (never 400s) when history fills the window', () => {
    const sources = [source('a', [200])]
    // used (msg) already exceeds maxInputTokens → budget clamps to 0.
    const res = budgetDocumentSources(sources, [msg(1000)], 500, 'kimi')
    expect(res.clipped).toBe(true)
    expect(res.sources).toHaveLength(0)
    expect(res.budgetTokens).toBe(0)
  })

  test('preserves input order among surviving sources', () => {
    const sources = [source('a', [20]), source('b', [20]), source('c', [20])]
    const res = budgetDocumentSources(sources, [msg(10)], 100000, 'kimi')
    expect(res.sources.map(s => s.sourceId)).toEqual(['a', 'b', 'c'])
  })
})
