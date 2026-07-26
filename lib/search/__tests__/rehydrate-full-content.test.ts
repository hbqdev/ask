import { describe, expect, it } from 'vitest'

import { rehydrateFullContent } from '../rehydrate-full-content'

// A tool result serves two roles: what the model reads on the turn that
// produced it, and what is replayed as history afterwards. pruneMessages keeps
// tool results for the immediately-following turn, and that is exactly the turn
// that regressed when per-source content shrank — balanced answered a follow-up
// from context with 0 tools in 9.2s, while thin-content arms searched again
// (3 tools / 61.1s, 5 tools / 107.3s).
//
// This swaps the excerpted output for full text just before persistence, so
// history carries the depth follow-ups need while the live prompt stays small.
const full = [{ title: 't', url: 'https://a.test', content: 'FULL TEXT' }]

function msg(parts: unknown[]) {
  return { id: 'm1', role: 'assistant', parts } as never
}

describe('rehydrateFullContent', () => {
  it('replaces an excerpted tool-search output with the full results', () => {
    const out = rehydrateFullContent(
      msg([
        {
          type: 'tool-search',
          toolCallId: 'call-1',
          output: {
            state: 'complete',
            results: [{ title: 't', url: 'https://a.test', content: 'excerpt' }]
          }
        }
      ]),
      new Map([['call-1', full]])
    )
    const part = (out.parts as never[])[0] as {
      output: { results: { content: string }[] }
    }
    expect(part.output.results[0].content).toBe('FULL TEXT')
  })

  it('leaves a part alone when nothing was recorded for its call id', () => {
    // Degradation path: a miss must persist today's bytes, not empty them.
    const parts = [
      {
        type: 'tool-search',
        toolCallId: 'unknown',
        output: { state: 'complete', results: [{ content: 'excerpt' }] }
      }
    ]
    const out = rehydrateFullContent(msg(parts), new Map([['other', full]]))
    const part = (out.parts as never[])[0] as {
      output: { results: { content: string }[] }
    }
    expect(part.output.results[0].content).toBe('excerpt')
  })

  it('does not touch non-search parts', () => {
    const out = rehydrateFullContent(
      msg([
        { type: 'text', text: 'hello' },
        { type: 'tool-fetch', toolCallId: 'call-1', output: { x: 1 } }
      ]),
      new Map([['call-1', full]])
    )
    expect((out.parts as never[])[0]).toEqual({ type: 'text', text: 'hello' })
    expect(((out.parts as never[])[1] as { output: unknown }).output).toEqual({
      x: 1
    })
  })

  it('preserves every other field of the output', () => {
    const out = rehydrateFullContent(
      msg([
        {
          type: 'tool-search',
          toolCallId: 'call-1',
          output: {
            state: 'complete',
            query: 'q',
            images: ['i'],
            number_of_results: 9,
            results: [{ content: 'excerpt' }]
          }
        }
      ]),
      new Map([['call-1', full]])
    )
    const o = ((out.parts as never[])[0] as { output: Record<string, unknown> })
      .output
    expect(o.query).toBe('q')
    expect(o.images).toEqual(['i'])
    expect(o.number_of_results).toBe(9)
    expect(o.state).toBe('complete')
  })

  it('rehydrates several search parts independently', () => {
    const other = [{ title: 'b', url: 'https://b.test', content: 'FULL B' }]
    const out = rehydrateFullContent(
      msg([
        {
          type: 'tool-search',
          toolCallId: 'c1',
          output: { results: [{ content: 'e1' }] }
        },
        {
          type: 'tool-search',
          toolCallId: 'c2',
          output: { results: [{ content: 'e2' }] }
        }
      ]),
      new Map([
        ['c1', full],
        ['c2', other]
      ])
    )
    const p = out.parts as { output: { results: { content: string }[] } }[]
    expect(p[0].output.results[0].content).toBe('FULL TEXT')
    expect(p[1].output.results[0].content).toBe('FULL B')
  })

  it('is a no-op for an empty map, so the feature off-state costs nothing', () => {
    const parts = [
      {
        type: 'tool-search',
        toolCallId: 'c1',
        output: { results: [{ content: 'excerpt' }] }
      }
    ]
    const out = rehydrateFullContent(msg(parts), new Map())
    expect(
      (out.parts as { output: { results: { content: string }[] } }[])[0].output
        .results[0].content
    ).toBe('excerpt')
  })

  it('survives a malformed part rather than losing the whole message', () => {
    // Persistence must never be broken by this.
    const out = rehydrateFullContent(
      msg([null, { type: 'tool-search' }, { type: 'text', text: 'ok' }]),
      new Map([['c1', full]])
    )
    expect((out.parts as never[]).length).toBe(3)
  })
})
