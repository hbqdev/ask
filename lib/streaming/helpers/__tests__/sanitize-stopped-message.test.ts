import { convertToModelMessages, type UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  isStoppedSaveStale,
  sanitizeStoppedMessage
} from '../sanitize-stopped-message'

function stoppedMessage(parts: unknown[]): UIMessage {
  return { id: 'a1', role: 'assistant', parts } as UIMessage
}

const doneSearch = {
  type: 'tool-search',
  toolCallId: 'call-1',
  state: 'output-available',
  input: { query: 'q' },
  output: { results: [] }
}

describe('sanitizeStoppedMessage', () => {
  it('drops unfinished tool calls, empty text and running steps; keeps settled parts', () => {
    const msg = stoppedMessage([
      {
        type: 'data-classifier',
        id: 'classifier',
        data: { state: 'done', skipSearch: false }
      },
      { type: 'step-start' },
      doneSearch,
      { type: 'step-start' },
      { type: 'reasoning', text: '   ', state: 'streaming' },
      { type: 'text', text: 'Partial answer so far', state: 'streaming' },
      {
        type: 'tool-fetch',
        toolCallId: 'call-2',
        state: 'input-available',
        input: { url: 'https://example.com' }
      },
      { type: 'tool-search', toolCallId: 'call-3', state: 'input-streaming' },
      {
        type: 'data-attachments',
        id: 'att',
        data: { state: 'running', count: 1 }
      },
      { type: 'text', text: '  \n ' },
      { type: 'step-start' }
    ])

    const out = sanitizeStoppedMessage(msg)!
    expect(out).not.toBeNull()
    expect(out.parts.map(p => p.type)).toEqual([
      'data-classifier',
      'step-start',
      'tool-search',
      'step-start',
      'text'
    ])
    const text = out.parts.find(p => p.type === 'text') as { state?: string }
    expect(text.state).toBe('done')
    expect(out.metadata).toMatchObject({ stopped: true })
  })

  it('keeps output-error tool parts (a valid call+result pair)', () => {
    const out = sanitizeStoppedMessage(
      stoppedMessage([
        {
          type: 'tool-fetch',
          toolCallId: 'c',
          state: 'output-error',
          input: { url: 'x' },
          errorText: 'boom'
        }
      ])
    )
    expect(out?.parts).toHaveLength(1)
  })

  it('returns null when nothing meaningful remains', () => {
    expect(
      sanitizeStoppedMessage(
        stoppedMessage([
          {
            type: 'data-classifier',
            id: 'classifier',
            data: { state: 'running' }
          },
          { type: 'step-start' },
          {
            type: 'tool-search',
            toolCallId: 'c',
            state: 'input-available',
            input: {}
          },
          { type: 'text', text: '' }
        ])
      )
    ).toBeNull()
  })

  it('keeps existing metadata alongside the stopped flag', () => {
    const msg = {
      ...stoppedMessage([{ type: 'text', text: 'hi' }]),
      metadata: { traceId: 't', searchMode: 'balanced' }
    } as UIMessage
    expect(sanitizeStoppedMessage(msg)?.metadata).toEqual({
      traceId: 't',
      searchMode: 'balanced',
      stopped: true
    })
  })

  it('yields a model history with no orphan tool calls on the next turn', async () => {
    const stopped = sanitizeStoppedMessage(
      stoppedMessage([
        { type: 'step-start' },
        doneSearch,
        { type: 'step-start' },
        { type: 'text', text: 'Partial', state: 'streaming' },
        {
          type: 'tool-fetch',
          toolCallId: 'call-2',
          state: 'input-available',
          input: { url: 'u' }
        }
      ])
    )!
    const history: UIMessage[] = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'first question' }]
      },
      stopped,
      {
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: 'new question' }]
      }
    ]
    const model = await convertToModelMessages(history)

    const calls = new Set<string>()
    const results = new Set<string>()
    for (const m of model) {
      if (!Array.isArray(m.content)) continue
      for (const c of m.content as Array<{
        type: string
        toolCallId?: string
      }>) {
        if (c.type === 'tool-call') calls.add(c.toolCallId!)
        if (c.type === 'tool-result') results.add(c.toolCallId!)
      }
    }
    expect([...calls]).toEqual(['call-1'])
    expect([...results]).toEqual(['call-1'])
    // Roles alternate: the stopped answer sits between the two user turns.
    expect(model[0].role).toBe('user')
    expect(model[model.length - 1].role).toBe('user')
    expect(model.some(m => m.role === 'assistant')).toBe(true)
  })
})

describe('isStoppedSaveStale', () => {
  it('is fresh while the newest row is still this turn’s user message', () => {
    expect(isStoppedSaveStale('u1', 'u1', 'a1')).toBe(false)
  })
  it('is fresh when the newest row is this assistant message (retried save)', () => {
    expect(isStoppedSaveStale('a1', 'u1', 'a1')).toBe(false)
  })
  it('is stale once a newer turn wrote its user message', () => {
    expect(isStoppedSaveStale('u2', 'u1', 'a1')).toBe(true)
  })
  it('fails closed when the latest id or turn id is unknown', () => {
    expect(isStoppedSaveStale(null, 'u1', 'a1')).toBe(true)
    expect(isStoppedSaveStale('u1', undefined, 'a1')).toBe(true)
  })
})
