import { describe, expect, test } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'

import { textFromMessage } from '../sub-agent'

const msg = (parts: unknown[]) => ({ parts }) as unknown as UIMessage

describe('textFromMessage', () => {
  test('concatenates text parts in order and trims', () => {
    expect(
      textFromMessage(
        msg([
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world ' }
        ])
      )
    ).toBe('Hello world')
  })

  test('ignores non-text parts (reasoning, tool outputs)', () => {
    expect(
      textFromMessage(
        msg([
          { type: 'reasoning', text: 'thinking...' },
          { type: 'tool-search', output: { results: [] } },
          { type: 'text', text: 'the answer' }
        ])
      )
    ).toBe('the answer')
  })

  test('returns empty for missing or partless messages', () => {
    expect(textFromMessage(undefined)).toBe('')
    expect(textFromMessage(msg([]))).toBe('')
    expect(textFromMessage({} as unknown as UIMessage)).toBe('')
  })

  test('skips text parts whose text is not a string', () => {
    expect(
      textFromMessage(
        msg([
          { type: 'text', text: 42 },
          { type: 'text', text: 'ok' }
        ])
      )
    ).toBe('ok')
  })
})
