import { describe, expect, test } from 'vitest'

import type { SearchResultItem } from '../../../types'
import {
  anchorSynthesizedCitations,
  mergeCitations,
  SYNTHESIS_TOOL_CALL_ID
} from '../citations'
import type { SubAgentResult } from '../sub-agent'

const src = (url: string, title = url): SearchResultItem =>
  ({ url, title, content: '' }) as SearchResultItem

const sub = (
  title: string,
  report: string,
  citationMaps: SubAgentResult['citationMaps']
): SubAgentResult => ({
  subtask: { title, query: 'q', rationale: 'r' },
  report,
  citationMaps
})

describe('mergeCitations', () => {
  test('dedupes sources by URL across sub-agents into one numbered space', () => {
    const a = sub('A', 'Alpha [1](#tcA) and beta [2](#tcA).', {
      tcA: { 1: src('u1'), 2: src('u2') }
    })
    const b = sub('B', 'Gamma [1](#tcB) delta [2](#tcB).', {
      tcB: { 1: src('u2'), 2: src('u3') } // u2 is shared with A
    })

    const merged = mergeCitations([a, b])

    expect(merged.sources.map(s => s.url)).toEqual(['u1', 'u2', 'u3'])
    expect(merged.citationMaps[SYNTHESIS_TOOL_CALL_ID][1].url).toBe('u1')
    expect(merged.citationMaps[SYNTHESIS_TOOL_CALL_ID][2].url).toBe('u2')
    expect(merged.citationMaps[SYNTHESIS_TOOL_CALL_ID][3].url).toBe('u3')
  })

  test('rewrites each sub-report anchor to its bare unified number', () => {
    const a = sub('A', 'Alpha [1](#tcA) and beta [2](#tcA).', {
      tcA: { 1: src('u1'), 2: src('u2') }
    })
    const b = sub('B', 'Gamma [1](#tcB) delta [2](#tcB).', {
      tcB: { 1: src('u2'), 2: src('u3') }
    })

    const merged = mergeCitations([a, b])

    // A: u1->1, u2->2 ; B: u2->2, u3->3
    expect(merged.rewrittenReports[0].report).toBe('Alpha [1] and beta [2].')
    expect(merged.rewrittenReports[1].report).toBe('Gamma [2] delta [3].')
  })

  test('drops anchors that do not resolve in the sub-agent map', () => {
    const a = sub('A', 'Known [1](#tcA) unknown [5](#tcA) end.', {
      tcA: { 1: src('u1') } // no #5
    })

    const merged = mergeCitations([a])

    expect(merged.rewrittenReports[0].report).toBe('Known [1] unknown  end.')
    expect(merged.sources).toHaveLength(1)
  })

  test('resolves anchors whose id carries a model prefix', () => {
    const a = sub('A', 'Fact [1](#toolu_tcA).', {
      tcA: { 1: src('u1') } // map keyed by raw id; anchor has toolu_ prefix
    })

    const merged = mergeCitations([a])

    expect(merged.rewrittenReports[0].report).toBe('Fact [1].')
  })

  test('emits no citation map when there are no sources', () => {
    const a = sub('A', 'Plain text, no citations.', {})
    const merged = mergeCitations([a])
    expect(merged.sources).toHaveLength(0)
    expect(merged.citationMaps).toEqual({})
  })
})

describe('anchorSynthesizedCitations', () => {
  test('anchors in-range bare citations to the synthesis id', () => {
    expect(anchorSynthesizedCitations('Foo [1] bar [3].', 3)).toBe(
      `Foo [1](#${SYNTHESIS_TOOL_CALL_ID}) bar [3](#${SYNTHESIS_TOOL_CALL_ID}).`
    )
  })

  test('drops out-of-range / hallucinated citations', () => {
    expect(anchorSynthesizedCitations('Real [2] fake [9].', 3)).toBe(
      `Real [2](#${SYNTHESIS_TOOL_CALL_ID}) fake .`
    )
  })

  test('leaves markdown links and already-anchored citations untouched', () => {
    expect(anchorSynthesizedCitations('See [docs](http://x).', 3)).toBe(
      'See [docs](http://x).'
    )
    expect(anchorSynthesizedCitations('[2](#other)', 3)).toBe('[2](#other)')
  })
})
