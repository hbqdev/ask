import { describe, expect, it } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'

import { buildFollowupRequest } from '../build-request'

function user(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as UIMessage
}

function assistant(id: string, parts: unknown[]): UIMessage {
  return { id, role: 'assistant', parts } as UIMessage
}

const SPEC = '```spec\n{"op":"add","path":"/root","value":"main"}\n```'

describe('buildFollowupRequest', () => {
  it('builds the request for a normal answer', () => {
    const a1 = assistant('a1', [{ type: 'text', text: '## Old answer' }])
    const a2 = assistant('a2', [{ type: 'text', text: '## Rust is fast' }])
    const messages = [
      user('u1', 'what is go'),
      a1,
      user('u2', 'what is rust'),
      a2
    ]
    expect(buildFollowupRequest(a2, messages, 'chat-1')).toEqual({
      question: 'what is rust',
      answer: '## Rust is fast',
      previousQuestions: ['what is go'],
      chatId: 'chat-1',
      messageId: 'a2'
    })
  })

  it('omits chatId and messageId without a chat id', () => {
    const a = assistant('a', [{ type: 'text', text: '## Answer' }])
    const req = buildFollowupRequest(a, [user('u', 'q'), a], null)
    expect(req).toEqual({
      question: 'q',
      answer: '## Answer',
      previousQuestions: []
    })
  })

  it('uses the user turn before this message, not later ones', () => {
    const a1 = assistant('a1', [{ type: 'text', text: '## First' }])
    const messages = [user('u1', 'first q'), a1, user('u2', 'second q')]
    expect(buildFollowupRequest(a1, messages, 'c')).toMatchObject({
      question: 'first q',
      previousQuestions: []
    })
  })

  it('returns null when the message asks a clarifying question', () => {
    const a = assistant('a', [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool-askQuestion', toolCallId: 't1', state: 'input-available' },
      { type: 'text', text: '## Which one?' }
    ])
    expect(buildFollowupRequest(a, [user('u', 'q'), a], 'c')).toBeNull()
  })

  it('returns null for empty answer text', () => {
    const a = assistant('a', [{ type: 'text', text: '   ' }])
    expect(buildFollowupRequest(a, [user('u', 'q'), a], 'c')).toBeNull()
  })

  it('returns null when the answer is only a spec block', () => {
    const a = assistant('a', [{ type: 'text', text: SPEC }])
    expect(buildFollowupRequest(a, [user('u', 'q'), a], 'c')).toBeNull()
  })

  it('returns null for a user message', () => {
    const u = user('u', 'q')
    expect(buildFollowupRequest(u, [u], 'c')).toBeNull()
  })

  it('returns null when there is no user question', () => {
    const a = assistant('a', [{ type: 'text', text: '## Answer' }])
    expect(buildFollowupRequest(a, [a], 'c')).toBeNull()
  })

  it('excludes pre-tool narration and spec fences from the answer', () => {
    const a = assistant('a', [
      { type: 'text', text: 'Let me search for that.' },
      { type: 'tool-search', toolCallId: 't1', state: 'output-available' },
      { type: 'text', text: '## Final answer\n\nBody.\n\n' + SPEC }
    ])
    const req = buildFollowupRequest(a, [user('u', 'q'), a], 'c')
    expect(req?.answer).toBe('## Final answer\n\nBody.')
  })
})
