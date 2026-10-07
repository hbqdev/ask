import { describe, expect, it } from 'vitest'

import {
  collapseSkippedToolCalls,
  type SkippedToolCalls,
  skippedToolCallsLabel
} from '../skipped-tool-calls'

// Shapes copied from the producers, so a drift there shows up here:
// - round cap: lib/tools/search.ts (searchLimitReached)
// - fetch cap: lib/tools/fetch.ts (fetchLimitReached)
// - answer-now refusal: lib/agents/answer-deadline.ts answerNowResult (answerNow)
// - invented args after `search` was withdrawn: an AI SDK tool-input-error,
//   persisted as state 'output-error' + "Invalid input for tool search: …"
function realSearch(id: string, query = `q-${id}`) {
  return {
    type: 'tool-search',
    toolCallId: id,
    state: 'output-available',
    input: { query },
    output: {
      state: 'complete',
      query,
      images: [],
      results: [{ title: 't', url: `https://example.com/${id}`, content: 'c' }],
      number_of_results: 1
    }
  }
}

function capRefusedSearch(id: string) {
  return {
    type: 'tool-search',
    toolCallId: id,
    state: 'output-available',
    input: { query: `capped-${id}` },
    output: {
      state: 'complete',
      results: [],
      images: [],
      query: `capped-${id}`,
      number_of_results: 0,
      searchLimitReached: true,
      notice:
        'Search limit reached (3 searches this turn). Do not search again.'
    }
  }
}

function answerNowSearch(id: string) {
  return {
    type: 'tool-search',
    toolCallId: id,
    state: 'output-available',
    input: { query: `late-${id}` },
    output: {
      state: 'complete',
      results: [],
      images: [],
      query: `late-${id}`,
      number_of_results: 0,
      answerNow: true,
      notice:
        'Research time for this turn is over, so this tool call was not run.'
    }
  }
}

function answerNowFetch(id: string) {
  return {
    type: 'tool-fetch',
    toolCallId: id,
    state: 'output-available',
    input: { url: 'https://example.com/a' },
    output: {
      state: 'complete',
      results: [],
      images: [],
      query: '',
      answerNow: true,
      notice:
        'Research time for this turn is over, so this tool call was not run.'
    }
  }
}

function capRefusedFetch(id: string) {
  return {
    type: 'tool-fetch',
    toolCallId: id,
    state: 'output-available',
    input: { url: 'https://example.com/b' },
    output: {
      state: 'complete',
      results: [],
      query: '',
      images: [],
      fetchLimitReached: true,
      notice: 'Fetch limit reached.'
    }
  }
}

function realFetch(id: string) {
  return {
    type: 'tool-fetch',
    toolCallId: id,
    state: 'output-available',
    input: { url: 'https://example.com/page' },
    output: {
      state: 'complete',
      query: '',
      images: [],
      results: [
        { title: 'Page', url: 'https://example.com/page', content: 'x' }
      ]
    }
  }
}

function invalidInputSearch(id: string) {
  return {
    type: 'tool-search',
    toolCallId: id,
    state: 'output-error',
    input: { q: 'invented' },
    errorText:
      'Invalid input for tool search: Type validation failed: Value: {"q":"invented"}.'
  }
}

const reasoning = (text: string) => ({ type: 'reasoning', text })

function summaryOf(parts: readonly unknown[]): SkippedToolCalls | undefined {
  return parts.find(
    (p): p is SkippedToolCalls =>
      (p as { type?: string }).type === 'skipped-tool-calls'
  )
}

describe('collapseSkippedToolCalls', () => {
  it('returns the parts untouched when nothing was refused', () => {
    const parts = [
      reasoning('thinking'),
      realSearch('s1'),
      realSearch('s2'),
      realFetch('f1')
    ]

    const out = collapseSkippedToolCalls(parts)

    expect(out).toBe(parts)
    expect(summaryOf(out)).toBeUndefined()
  })

  it('keeps real searches and collapses every round-cap refusal into one entry at the first refusal', () => {
    const parts = [
      realSearch('s1'),
      realSearch('s2'),
      realSearch('s3'),
      capRefusedSearch('x1'),
      reasoning('still want more'),
      capRefusedSearch('x2'),
      capRefusedSearch('x3'),
      reasoning('answering')
    ]

    const out = collapseSkippedToolCalls(parts)

    expect(out.map(p => (p as { type: string }).type)).toEqual([
      'tool-search',
      'tool-search',
      'tool-search',
      'skipped-tool-calls',
      'reasoning',
      'reasoning'
    ])
    // Real searches are passed through as the same objects (render as today).
    expect(out.slice(0, 3)).toEqual(parts.slice(0, 3))
    expect(summaryOf(out)).toEqual({
      type: 'skipped-tool-calls',
      toolCallIds: ['x1', 'x2', 'x3'],
      searches: 3,
      fetches: 0,
      searchLimitReached: true
    })
  })

  it('collapses a turn made only of refusals into the single entry', () => {
    const parts = [capRefusedSearch('x1'), capRefusedSearch('x2')]

    const out = collapseSkippedToolCalls(parts)

    expect(out).toHaveLength(1)
    expect(summaryOf(out)).toMatchObject({
      toolCallIds: ['x1', 'x2'],
      searches: 2,
      fetches: 0,
      searchLimitReached: true
    })
  })

  it('treats answer-now refusals of search and fetch as skipped, without claiming the search cap', () => {
    const parts = [
      realSearch('s1'),
      realFetch('f1'),
      answerNowSearch('a1'),
      answerNowFetch('a2'),
      answerNowSearch('a3')
    ]

    const out = collapseSkippedToolCalls(parts)

    expect(out.map(p => (p as { type: string }).type)).toEqual([
      'tool-search',
      'tool-fetch',
      'skipped-tool-calls'
    ])
    expect(summaryOf(out)).toMatchObject({
      toolCallIds: ['a1', 'a2', 'a3'],
      searches: 2,
      fetches: 1,
      searchLimitReached: false
    })
  })

  it('treats a fetch-cap refusal as a skipped page read', () => {
    const out = collapseSkippedToolCalls([
      realFetch('f1'),
      capRefusedFetch('f2')
    ])

    expect(summaryOf(out)).toMatchObject({
      toolCallIds: ['f2'],
      searches: 0,
      fetches: 1,
      searchLimitReached: false
    })
  })

  it('mixed real + cap + answer-now + invalid-input (the prod pattern): only the real searches survive', () => {
    const parts = [
      realSearch('s1'),
      realSearch('s2'),
      realSearch('s3'),
      capRefusedSearch('x1'),
      capRefusedSearch('x2'),
      invalidInputSearch('e1'),
      invalidInputSearch('e2'),
      answerNowSearch('a1'),
      reasoning('done')
    ]

    const out = collapseSkippedToolCalls(parts)

    expect(out.map(p => (p as { type: string }).type)).toEqual([
      'tool-search',
      'tool-search',
      'tool-search',
      'skipped-tool-calls',
      'reasoning'
    ])
    expect(summaryOf(out)).toMatchObject({
      toolCallIds: ['x1', 'x2', 'e1', 'e2', 'a1'],
      searches: 5,
      fetches: 0,
      searchLimitReached: true
    })
  })

  it('leaves an invalid-input error alone when no refusal came before it (it is not the cap)', () => {
    const parts = [invalidInputSearch('e1'), realSearch('s1')]

    const out = collapseSkippedToolCalls(parts)

    expect(out).toBe(parts)
  })

  it('leaves ordinary search errors and empty-but-real results alone', () => {
    const failed = {
      type: 'tool-search',
      toolCallId: 'err',
      state: 'output-error',
      input: { query: 'x' },
      errorText: 'Search provider timed out'
    }
    const dedupSkip = {
      type: 'tool-search',
      toolCallId: 'dup',
      state: 'output-available',
      input: { query: 'same again' },
      output: {
        state: 'complete',
        results: [],
        images: [],
        query: 'same again',
        number_of_results: 0,
        duplicateQuery: true
      }
    }
    const parts = [capRefusedSearch('x1'), failed, dedupSkip]

    const out = collapseSkippedToolCalls(parts)

    expect(out.map(p => (p as { toolCallId?: string }).toolCallId)).toEqual([
      undefined,
      'err',
      'dup'
    ])
    expect(summaryOf(out)?.toolCallIds).toEqual(['x1'])
  })

  it('never folds a call that has not finished yet (live streaming)', () => {
    const pending = {
      type: 'tool-search',
      toolCallId: 'p1',
      state: 'input-available',
      input: { query: 'in flight' }
    }
    const streamingYield = {
      type: 'tool-search',
      toolCallId: 'p2',
      state: 'output-available',
      input: { query: 'running' },
      output: { state: 'searching', query: 'running' }
    }
    const parts = [capRefusedSearch('x1'), pending, streamingYield]

    const out = collapseSkippedToolCalls(parts)

    expect(out).toHaveLength(3)
    expect(out[1]).toBe(pending)
    expect(out[2]).toBe(streamingYield)
  })

  it('grows the same entry, in place, as more refusals stream in', () => {
    const first = collapseSkippedToolCalls([
      realSearch('s1'),
      capRefusedSearch('x1')
    ])
    const later = collapseSkippedToolCalls([
      realSearch('s1'),
      capRefusedSearch('x1'),
      reasoning('hmm'),
      capRefusedSearch('x2')
    ])

    expect(first.findIndex(p => p === summaryOf(first))).toBe(1)
    expect(later.findIndex(p => p === summaryOf(later))).toBe(1)
    expect(summaryOf(first)?.searches).toBe(1)
    expect(summaryOf(later)?.searches).toBe(2)
  })

  it('ignores refusal flags on tools other than search and fetch', () => {
    const todo = {
      type: 'tool-todoWrite',
      toolCallId: 't1',
      state: 'output-available',
      input: {},
      output: { state: 'complete', results: [], answerNow: true }
    }
    const parts = [todo]

    expect(collapseSkippedToolCalls(parts)).toBe(parts)
  })
})

describe('skippedToolCallsLabel', () => {
  const base: SkippedToolCalls = {
    type: 'skipped-tool-calls',
    toolCallIds: [],
    searches: 0,
    fetches: 0,
    searchLimitReached: false
  }

  it('names the search cap and pluralizes', () => {
    expect(
      skippedToolCallsLabel({ ...base, searches: 12, searchLimitReached: true })
    ).toBe('Search limit reached — 12 extra searches skipped')
    expect(
      skippedToolCallsLabel({ ...base, searches: 1, searchLimitReached: true })
    ).toBe('Search limit reached — 1 extra search skipped')
  })

  it('lists page reads alongside searches', () => {
    expect(
      skippedToolCallsLabel({
        ...base,
        searches: 12,
        fetches: 3,
        searchLimitReached: true
      })
    ).toBe('Search limit reached — 12 extra searches and 3 page reads skipped')
    expect(skippedToolCallsLabel({ ...base, fetches: 1 })).toBe(
      'Research limit reached — 1 page read skipped'
    )
  })

  it('does not claim the search cap for answer-now-only refusals', () => {
    expect(skippedToolCallsLabel({ ...base, searches: 2 })).toBe(
      'Research limit reached — 2 extra searches skipped'
    )
  })
})
