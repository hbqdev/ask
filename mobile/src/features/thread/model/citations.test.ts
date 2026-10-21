import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  copyableAnswer,
  listSources,
  renderableAnswer,
  type Source,
  sourceForHref
} from '@/features/thread/model/citations'
import { extractCitationMaps } from '@/lib/utils/citation'

type Result = { title: string; url: string; content: string }

function searchPart(toolCallId: string, results: Result[]) {
  return {
    type: 'tool-search',
    toolCallId,
    state: 'output-available',
    input: { query: 'q' },
    output: { state: 'complete', query: 'q', images: [], results }
  }
}

function message(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as UIMessage
}

const A: Result = {
  title: 'Page A',
  url: 'https://example.com/a',
  content: 'About A'
}
const B: Result = {
  title: 'Page B',
  url: 'https://www.other.org/b',
  content: 'About B'
}

const withA = message([searchPart('call_a', [A])])
const mapsA = extractCitationMaps(withA)

const RELATED_FENCE = [
  '```spec',
  '{"op":"add","path":"/root","value":"main"}',
  '{"op":"add","path":"/elements/main","value":{"type":"Heading","props":{"title":"Related"},"children":[]}}',
  '```'
].join('\n')

describe('renderableAnswer', () => {
  it('renders a resolved anchor as a domain link', () => {
    expect(renderableAnswer('See [1](#call_a).', mapsA)).toContain(
      '](https://example.com/a)'
    )
  })

  it('drops an anchor whose toolCallId is unknown', () => {
    const out = renderableAnswer('X [1](#call_zz).', mapsA)
    expect(out).not.toContain('#call_zz')
    expect(out).not.toContain('[1]')
  })

  it('hides an unfinished anchor at the tail', () => {
    expect(renderableAnswer('X [1](#cal', mapsA).trimEnd()).toBe('X')
  })

  it('strips spec fences from the rendered answer', () => {
    const out = renderableAnswer(`## A\n\nBody.\n\n${RELATED_FENCE}`, mapsA)
    expect(out).not.toContain('```spec')
    expect(out).toContain('Body.')
  })

  it('hides an unfinished spec fence while streaming', () => {
    expect(
      renderableAnswer('## A\n\n```spec\n{"op":"add"', mapsA).trimEnd()
    ).toBe('## A')
  })

  it('keeps the text around a complete spec fence and other code fences', () => {
    const text = `Intro.\n\n${RELATED_FENCE}\n\n\`\`\`ts\nconst x = 1\n\`\`\`\n\nOutro.`
    const out = renderableAnswer(text, mapsA)
    expect(out).toContain('Intro.')
    expect(out).toContain('```ts\nconst x = 1\n```')
    expect(out).toContain('Outro.')
  })

  it('hides only the unfinished fence after a complete one', () => {
    const out = renderableAnswer(
      `One.\n\n${RELATED_FENCE}\n\nTwo.\n\n\`\`\`spec\n{"op"`,
      mapsA
    )
    expect(out).toBe('One.\n\nTwo.')
  })
})

describe('copyableAnswer', () => {
  it('copyableAnswer has no spec fence and no anchors', () => {
    const out = copyableAnswer(
      `See [1](#call_a) and [2](#call_zz).\n\n${RELATED_FENCE}`,
      mapsA
    )
    expect(out).not.toContain('```spec')
    expect(out).not.toMatch(/\[\d+\]\(#/)
    expect(out).toContain('](https://example.com/a)')
  })
})

describe('listSources', () => {
  it('dedupes results that share a URL, keeping the first', () => {
    const msg = message([
      searchPart('call_a', [A, { ...A, title: 'Again' }]),
      searchPart('call_b', [A, B])
    ])
    const sources = listSources(msg)
    expect(sources.map(s => s.url)).toEqual([A.url, B.url])
    expect(sources[0].title).toBe('Page A')
  })

  it('computes host, snippet and favicon', () => {
    const long = 'x'.repeat(300)
    const msg = message([searchPart('call_a', [{ ...B, content: long }])])
    expect(listSources(msg)).toEqual<Source[]>([
      {
        url: B.url,
        title: 'Page B',
        host: 'other.org',
        snippet: 'x'.repeat(240),
        favicon: 'https://www.google.com/s2/favicons?domain=other.org&sz=64',
        cited: false
      }
    ])
  })

  it('has an empty snippet for a result without content', () => {
    const bare = { title: 'Bare', url: 'https://bare.test/' } as Result
    expect(
      listSources(message([searchPart('call_a', [bare])]))[0].snippet
    ).toBe('')
  })

  it('puts cited sources first, keeping their relative order', () => {
    const C: Result = { title: 'C', url: 'https://c.test/', content: '' }
    const msg = message([
      searchPart('call_a', [A, B, C]),
      { type: 'text', text: 'Cites [3](#call_a) then [1](#call_a).' }
    ])
    const sources = listSources(msg)
    expect(sources.map(s => [s.url, s.cited])).toEqual([
      [A.url, true],
      [C.url, true],
      [B.url, false]
    ])
  })

  it('drops failed fetches', () => {
    const failed: Result = {
      title: 'Fetch failed: https://down.test/',
      url: 'https://down.test/',
      content: ''
    }
    const msg = message([searchPart('call_a', [failed, A])])
    expect(listSources(msg).map(s => s.url)).toEqual([A.url])
  })

  it('is empty for a message with no tool output', () => {
    expect(listSources(message([{ type: 'text', text: 'hi' }]))).toEqual([])
  })
})

describe('sourceForHref', () => {
  const spaced: Result = {
    title: 'Spaced',
    url: 'https://example.com/a b',
    content: ''
  }
  const sources = listSources(message([searchPart('call_a', [A, spaced])]))

  it('matches the raw URL', () => {
    expect(sourceForHref('https://example.com/a', sources)?.title).toBe(
      'Page A'
    )
  })

  it('matches the encoded URL', () => {
    expect(sourceForHref('https://example.com/a%20b', sources)?.title).toBe(
      'Spaced'
    )
  })

  it('returns undefined for an unrelated link', () => {
    expect(sourceForHref('https://elsewhere.test/', sources)).toBeUndefined()
  })
})
