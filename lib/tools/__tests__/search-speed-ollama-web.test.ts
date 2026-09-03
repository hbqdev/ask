import { describe, expect, it } from 'vitest'

import type { RerankedDoc } from '@/lib/embeddings/rerank'
import type { OllamaSearchResult } from '@/lib/utils/ollama-search-client'

import {
  applyOllamaWebExcerpts,
  mapOllamaWebResults,
  shouldUseOllamaWebSpeed
} from '../search'

// FAST mode answers from Ollama-web full page bodies in one pass — no SearXNG
// snippet fan-out and no crawl. These pin the two pure pieces of that branch:
// the gate that decides whether the fast path runs, and the mapping that
// carries full `content` into the tool's result shape. The branch that wires
// them together lives inside execute(), which a unit test cannot reach without
// a full tool-call context (embeddings + network), so the decision and the
// mapping are extracted and asserted directly — the same pattern as
// resolveEffectiveDepth.

describe('shouldUseOllamaWebSpeed', () => {
  it('takes the fast path in speed mode when Ollama-web is configured and enabled', () => {
    expect(
      shouldUseOllamaWebSpeed({
        searchMode: 'speed',
        ollamaConfigured: true,
        ollamaEnabledEnv: undefined
      })
    ).toBe(true)
    // An explicit non-'off' value is still enabled.
    expect(
      shouldUseOllamaWebSpeed({
        searchMode: 'speed',
        ollamaConfigured: true,
        ollamaEnabledEnv: 'on'
      })
    ).toBe(true)
  })

  it('falls back (false) in balanced and quality modes — those are untouched', () => {
    for (const mode of ['balanced', 'quality'] as const) {
      expect(
        shouldUseOllamaWebSpeed({
          searchMode: mode,
          ollamaConfigured: true,
          ollamaEnabledEnv: undefined
        })
      ).toBe(false)
    }
  })

  it('falls back (false) when searchMode is unknown to the tool (older callers)', () => {
    expect(
      shouldUseOllamaWebSpeed({
        searchMode: undefined,
        ollamaConfigured: true,
        ollamaEnabledEnv: undefined
      })
    ).toBe(false)
  })

  it('falls back (false) when Ollama-web is unconfigured (empty/absent key)', () => {
    // Mirrors isOllamaSearchConfigured() === false: the branch must degrade to
    // the basic SearXNG path rather than answer from nothing.
    expect(
      shouldUseOllamaWebSpeed({
        searchMode: 'speed',
        ollamaConfigured: false,
        ollamaEnabledEnv: undefined
      })
    ).toBe(false)
  })

  it('falls back (false) when OLLAMA_SEARCH_ENABLED=off, even if configured', () => {
    expect(
      shouldUseOllamaWebSpeed({
        searchMode: 'speed',
        ollamaConfigured: true,
        ollamaEnabledEnv: 'off'
      })
    ).toBe(false)
  })
})

describe('mapOllamaWebResults', () => {
  const results: OllamaSearchResult[] = [
    { title: 'Node LTS', url: 'https://nodejs.org/en', content: 'full body A' },
    { title: 'Release', url: 'https://nodejs.org/rel', content: 'full body B' }
  ]

  it('carries full content per result so the model reads it directly (no crawl)', () => {
    const out = mapOllamaWebResults(results, 'node lts version', 'tc-1')
    expect(out.results).toHaveLength(2)
    // The whole point: `content` is the full page body, not a snippet.
    expect(out.results[0]).toEqual({
      title: 'Node LTS',
      url: 'https://nodejs.org/en',
      content: 'full body A'
    })
    expect(out.results[1].content).toBe('full body B')
    expect(out.number_of_results).toBe(2)
    expect(out.query).toBe('node lts version')
    // No images on this path.
    expect(out.images).toEqual([])
    // toolCallId is what the citation anchors [n](#toolCallId) resolve against.
    expect(out.toolCallId).toBe('tc-1')
  })

  it('omits toolCallId when none is provided', () => {
    const out = mapOllamaWebResults(results, 'q')
    expect(out.toolCallId).toBeUndefined()
    expect(out.number_of_results).toBe(2)
  })

  it('produces an empty, well-formed result for an empty input', () => {
    const out = mapOllamaWebResults([], 'q')
    expect(out.results).toEqual([])
    expect(out.number_of_results).toBe(0)
    expect(out.images).toEqual([])
  })
})

// Passage-level selection on the fast path: the crawl path trims each source to
// its top-ranked passages before the model reads it, and the fast path must do
// the same so Ollama-web's full page bodies don't balloon the prompt. These pin
// the pure mapping — the rerank itself (network) lives in execute(). The key
// contracts: map topPassages back BY IDENTITY, preserve ORIGINAL order (not the
// reranker's score order), keep EVERY source, and fall back to the full body
// for a source that produced no passages.
describe('applyOllamaWebExcerpts', () => {
  const a: OllamaSearchResult = {
    title: 'A',
    url: 'https://a.example',
    content: 'ALPHA one two three four five ALPHA'
  }
  const b: OllamaSearchResult = {
    title: 'B',
    url: 'https://b.example',
    content: 'BETA one two three four five BETA'
  }

  it('replaces each source content with its top passages, keeping all sources in original order', () => {
    // Reranker returns docs sorted by SCORE (b before a); the mapper must still
    // present them in the ORIGINAL [a, b] order so citation anchoring holds.
    const reranked: RerankedDoc<OllamaSearchResult>[] = [
      { doc: b, score: 0.9, topPassages: [{ text: 'BETA passage', index: 0 }] },
      { doc: a, score: 0.5, topPassages: [{ text: 'ALPHA passage', index: 0 }] }
    ]
    const { results, passages } = applyOllamaWebExcerpts([a, b], reranked)
    expect(results).toHaveLength(2)
    expect(results[0].url).toBe('https://a.example')
    expect(results[0].content).toBe('ALPHA passage')
    expect(results[1].url).toBe('https://b.example')
    expect(results[1].content).toBe('BETA passage')
    // Title/url are carried through untouched — only content is trimmed.
    expect(results[0].title).toBe('A')
    expect(passages).toBe(2)
  })

  it('keeps a source that produced no passages, falling back to its full body', () => {
    // Only `a` was reranked; `b` is missing from the reranked set entirely.
    const reranked: RerankedDoc<OllamaSearchResult>[] = [
      { doc: a, score: 0.7, topPassages: [{ text: 'ALPHA passage', index: 0 }] }
    ]
    const { results, passages } = applyOllamaWebExcerpts([a, b], reranked)
    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('ALPHA passage')
    // No passages for b -> keep its original full body (still citable).
    expect(results[1].content).toBe(b.content)
    // Only a's single passage counted.
    expect(passages).toBe(1)
  })

  it('joins multiple in-order passages with an elision marker on a gap', () => {
    const reranked: RerankedDoc<OllamaSearchResult>[] = [
      {
        doc: a,
        score: 0.8,
        topPassages: [
          { text: 'first', index: 0 },
          { text: 'third', index: 2 }
        ]
      }
    ]
    const { results } = applyOllamaWebExcerpts([a], reranked)
    // index 0 then index 2 skips 1 -> elision inserted between them.
    expect(results[0].content).toBe('first\n[…]\nthird')
  })
})
