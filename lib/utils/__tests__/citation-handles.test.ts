import { describe, expect, it } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'
import {
  extractCitationMaps,
  MAX_CITATION_NUMBER,
  resolveCitationAnchor
} from '@/lib/utils/citation'
import {
  addCitationHandles,
  formatCitationHandle,
  isCitationHandlesEnabled
} from '@/lib/utils/citation-handles'

const ANCHOR_RE = /^\[(\d+)\]\(#([^)]+)\)$/
const SEARCH_ID = '470411cd-2b1f-4f0e-9a51-5c6f1d2e3a4b'

type Item = { title: string; url: string; content: string; cite?: string }

function resultsOf(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Result ${i + 1}`,
    url: `https://site${i + 1}.example/page`,
    content: `content ${i + 1}`
  }))
}

/**
 * The renderer's view: the stored UI part (WITHOUT cites — they exist only in
 * the model-facing output) → extractCitationMaps → resolveCitationAnchor.
 */
function resolveCite(
  cite: string,
  parts: Array<{ type: string; toolCallId: string; output: unknown }>
) {
  const m = ANCHOR_RE.exec(cite)
  expect(m, `cite "${cite}" is a [N](#id) anchor`).not.toBeNull()
  const maps = extractCitationMaps({
    id: 'm',
    role: 'assistant',
    parts: parts.map(p => ({ ...p, state: 'output-available' }))
  } as unknown as UIMessage)
  return resolveCitationAnchor(parseInt(m![1], 10), m![2], maps)
}

describe('isCitationHandlesEnabled', () => {
  it('is ON when unset or empty — the default', () => {
    expect(isCitationHandlesEnabled({})).toBe(true)
    expect(isCitationHandlesEnabled({ CITATION_HANDLES: '' })).toBe(true)
  })

  it('is ON for any value other than the literal "off"', () => {
    for (const v of ['on', 'true', 'false', '0', 'OFF', ' off']) {
      expect(isCitationHandlesEnabled({ CITATION_HANDLES: v })).toBe(true)
    }
  })

  it('is OFF only for the literal "off" (the ALWAYS_SEARCH convention)', () => {
    expect(isCitationHandlesEnabled({ CITATION_HANDLES: 'off' })).toBe(false)
  })
})

describe('addCitationHandles round-trips through the renderer', () => {
  it('every result of a typical 27-result search resolves to itself', () => {
    const output = {
      query: 'q',
      images: [],
      results: resultsOf(27),
      toolCallId: SEARCH_ID
    }
    const view = addCitationHandles(output, SEARCH_ID)
    view.results.forEach((r: Item, i) => {
      expect(r.cite).toBe(formatCitationHandle(i + 1, SEARCH_ID))
      const res = resolveCite(r.cite!, [
        { type: 'tool-search', toolCallId: SEARCH_ID, output }
      ])
      expect(res.status).toBe('own')
      expect(res.status !== 'unresolved' && res.source).toEqual(
        output.results[i]
      )
    })
  })

  it('keeps positions when a result gets no handle (invalid url, failed fetch)', () => {
    const output = {
      results: [
        { title: 'A', url: 'https://a.example/', content: 'a' },
        { title: 'relative', url: '/uploads/x.pdf', content: 'x' },
        {
          title: 'Fetch failed: https://b.example/',
          url: 'https://b.example/',
          content: ''
        },
        { title: 'C', url: 'https://c.example/', content: 'c' }
      ]
    }
    const view = addCitationHandles(output, 'call_1')
    expect(view.results.map((r: Item) => r.cite)).toEqual([
      '[1](#call_1)',
      undefined,
      undefined,
      '[4](#call_1)'
    ])
    const res = resolveCite('[4](#call_1)', [
      { type: 'tool-fetch', toolCallId: 'call_1', output }
    ])
    expect(res.status !== 'unresolved' && res.source.url).toBe(
      'https://c.example/'
    )
  })

  it('gives no handle past MAX_CITATION_NUMBER (the resolver would drop it)', () => {
    const view = addCitationHandles(
      { results: resultsOf(MAX_CITATION_NUMBER + 2) },
      SEARCH_ID
    )
    expect(view.results[MAX_CITATION_NUMBER - 1].cite).toBe(
      `[${MAX_CITATION_NUMBER}](#${SEARCH_ID})`
    )
    expect(view.results[MAX_CITATION_NUMBER].cite).toBeUndefined()
  })

  it('puts cite first and leaves every other field as it was', () => {
    const output = {
      results: [{ title: 'A', url: 'https://a.example/', content: 'a' }]
    }
    const [r] = addCitationHandles(output, 'id-1').results
    expect(Object.keys(r)).toEqual(['cite', 'title', 'url', 'content'])
    expect(JSON.stringify(r)).toBe(
      '{"cite":"[1](#id-1)","title":"A","url":"https://a.example/","content":"a"}'
    )
  })

  it('never mutates the output the UI part and persistence store', () => {
    const output = { results: resultsOf(3), toolCallId: SEARCH_ID }
    const before = JSON.stringify(output)
    const view = addCitationHandles(output, SEARCH_ID)
    expect(view).not.toBe(output)
    expect(JSON.stringify(output)).toBe(before)
  })

  it('returns the output untouched when there is nothing to hand out', () => {
    const cases: unknown[] = [
      null,
      'text',
      { results: [] },
      { results: 'nope' },
      { notice: 'no results key' },
      { results: [{ title: 'rel', url: '/x', content: '' }] }
    ]
    for (const c of cases) expect(addCitationHandles(c, SEARCH_ID)).toBe(c)
  })

  it('gives no handle when the id would not survive the anchor regexes', () => {
    const output = { results: resultsOf(2) }
    for (const id of [undefined, '', 'has space', 'paren)id', 'a(b']) {
      expect(addCitationHandles(output, id)).toBe(output)
    }
  })

  it('leaves a legacy output with a citationMap alone (it resolves by the map)', () => {
    const output = {
      results: resultsOf(2),
      citationMap: { 1: resultsOf(2)[1] }
    }
    expect(addCitationHandles(output, SEARCH_ID)).toBe(output)
  })
})
