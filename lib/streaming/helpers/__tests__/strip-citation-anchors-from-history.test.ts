import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import { stripCitationAnchorsFromHistory } from '../strip-citation-anchors-from-history'

const user = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }]
})
const assistant = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }]
})
const textOf = (m: UIMessage) =>
  (m.parts[0] as { type: 'text'; text: string }).text

describe('stripCitationAnchorsFromHistory', () => {
  it('removes anchors from earlier assistant turns, keeping the prose', () => {
    const out = stripCitationAnchorsFromHistory([
      user('u1', 'q1 [1](#not-an-answer)'),
      assistant(
        'a1',
        'Caddy runs on Debian. [1](#1a1a11f6-1aa0-4c59-9374-4d678f2fd45e) [3](#1a1a11f6-1aa0-4c59-9374-4d678f2fd45e)\n\n| a | b [2](#x-1) |'
      ),
      user('u2', 'follow-up')
    ])
    expect(textOf(out[1])).toBe('Caddy runs on Debian.\n\n| a | b |')
    // User text is never touched.
    expect(textOf(out[0])).toBe('q1 [1](#not-an-answer)')
  })

  it('leaves a trailing assistant message (a continued turn) alone', () => {
    const msgs = [user('u1', 'q'), assistant('a1', 'Fact. [1](#own-id)')]
    const out = stripCitationAnchorsFromHistory(msgs)
    expect(out[1]).toBe(msgs[1])
  })

  it('keeps ordinary links and returns unchanged messages by identity', () => {
    const a = assistant('a1', 'See [docs](https://example.com) and [1] alone.')
    const out = stripCitationAnchorsFromHistory([a, user('u2', 'next')])
    expect(out[0]).toBe(a)
  })

  it('does not mutate the input', () => {
    const a = assistant('a1', 'X. [1](#id-1)')
    stripCitationAnchorsFromHistory([a, user('u2', 'next')])
    expect(textOf(a)).toBe('X. [1](#id-1)')
  })
})
