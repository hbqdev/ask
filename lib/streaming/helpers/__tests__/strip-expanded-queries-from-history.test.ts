import type { UIMessage } from 'ai'
import { convertToModelMessages, pruneMessages } from 'ai'
import { describe, expect, it } from 'vitest'

import { stripExpandedQueriesFromHistory } from '../strip-expanded-queries-from-history'

// expandedQueries (the first search's expansion variants) is display-only.
// toModelOutput strips it from the live call, but history is converted
// WITHOUT the tools map, so a prior turn's search output is replayed to the
// model raw. This helper removes the field from that replay and nothing else.

const VARIANTS = ['rtx 5090 msrp usd', 'nvidia 5090 launch price']

const searchOutput = (extra: Record<string, unknown> = {}) => ({
  state: 'complete',
  query: 'rtx 5090 price',
  images: [{ url: 'https://a.test/1.png', description: 'card' }],
  results: [{ title: 'A', url: 'https://a.test/', content: 'alpha' }],
  number_of_results: 1,
  toolCallId: 'call-s1',
  ...extra
})

const searchPart = (output: unknown) => ({
  type: 'tool-search',
  toolCallId: 'call-s1',
  state: 'output-available',
  input: { query: 'rtx 5090 price' },
  output
})

const history = (output: unknown): UIMessage[] =>
  [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'price?' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [searchPart(output), { type: 'text', text: 'About $1999.' }]
    },
    { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'and the 5080?' }] }
  ] as unknown as UIMessage[]

/** The search tool-result the model is sent, via the routes' own pipeline. */
async function replayedSearchOutput(messages: UIMessage[]) {
  const modelMessages = pruneMessages({
    messages: await convertToModelMessages(messages),
    reasoning: 'before-last-message',
    toolCalls: 'before-last-2-messages',
    emptyMessages: 'remove'
  })
  for (const m of modelMessages) {
    if (m.role !== 'tool') continue
    for (const c of m.content) {
      if (c.type === 'tool-result' && c.toolName === 'search') {
        return (c.output as { type: 'json'; value: unknown }).value
      }
    }
  }
  return undefined
}

describe('stripExpandedQueriesFromHistory', () => {
  it('a prior-turn search reaches the model without expandedQueries, all else untouched', async () => {
    const raw = history(searchOutput({ expandedQueries: VARIANTS }))
    // Without the strip, the replay carries the field (why this exists).
    expect(await replayedSearchOutput(raw)).toHaveProperty('expandedQueries')

    const replayed = await replayedSearchOutput(
      stripExpandedQueriesFromHistory(raw)
    )
    expect(replayed).toEqual(searchOutput())
  })

  it('does not mutate the persisted/UI messages', () => {
    const raw = history(searchOutput({ expandedQueries: VARIANTS }))
    stripExpandedQueriesFromHistory(raw)
    const part = raw[1].parts[0] as { output: { expandedQueries?: string[] } }
    expect(part.output.expandedQueries).toEqual(VARIANTS)
  })

  it('also strips a trailing assistant message (a continued turn)', () => {
    const msgs = history(searchOutput({ expandedQueries: VARIANTS })).slice(
      0,
      2
    )
    const out = stripExpandedQueriesFromHistory(msgs)
    const part = out[1].parts[0] as { output: Record<string, unknown> }
    expect(part.output).toEqual(searchOutput())
  })

  it('returns messages without the field by identity', () => {
    const msgs = history(searchOutput())
    const out = stripExpandedQueriesFromHistory(msgs)
    out.forEach((m, i) => expect(m).toBe(msgs[i]))
  })

  it('leaves other tools, non-object outputs and user messages alone', () => {
    const msgs = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'expandedQueries' }]
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-fetch',
            toolCallId: 'f1',
            state: 'output-available',
            input: { url: 'https://a.test/' },
            output: { results: [], expandedQueries: ['not ours'] }
          },
          searchPart(null),
          {
            type: 'tool-search',
            toolCallId: 's2',
            state: 'input-available',
            input: { query: 'q' }
          }
        ]
      }
    ] as unknown as UIMessage[]
    const out = stripExpandedQueriesFromHistory(msgs)
    out.forEach((m, i) => expect(m).toBe(msgs[i]))
  })
})
