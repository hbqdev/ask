import { describe, expect, it } from 'vitest'

import { extractCitedSourceUrls } from '../citation'

// Minimal UIMessage-shaped fixtures for the resolver.
const msg = (parts: unknown[]) =>
  ({ id: 'm1', role: 'assistant', parts }) as never

const toolPart = {
  type: 'tool-search',
  state: 'output-available',
  toolCallId: 'tc1',
  output: {
    results: [
      { title: 'A', url: 'https://a.com', content: '' },
      { title: 'B', url: 'https://b.com', content: '' },
      { title: 'C', url: 'https://c.com', content: '' }
    ]
  }
}

describe('extractCitedSourceUrls', () => {
  it('returns the distinct URLs the answer cited (in-turn anchors only)', () => {
    const m = msg([
      toolPart,
      { type: 'text', text: 'X. [1](#tc1) Y. [3](#tc1) Z. [2](#ghost)' }
    ])
    // [1]->a, [3]->c resolve; [2](#ghost) names no tool call and is dropped.
    expect(extractCitedSourceUrls(m).sort()).toEqual([
      'https://a.com',
      'https://c.com'
    ])
  })

  it('dedupes repeated citations of the same source', () => {
    const m = msg([
      toolPart,
      { type: 'text', text: '[1](#tc1) again [1](#tc1)' }
    ])
    expect(extractCitedSourceUrls(m)).toEqual(['https://a.com'])
  })

  it('returns [] when nothing resolves', () => {
    expect(
      extractCitedSourceUrls(
        msg([toolPart, { type: 'text', text: 'no cites' }])
      )
    ).toEqual([])
    expect(extractCitedSourceUrls(msg([]))).toEqual([])
  })
})
