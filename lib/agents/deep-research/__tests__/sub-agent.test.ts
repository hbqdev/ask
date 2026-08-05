import { describe, expect, test } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'

import { finalReportText, textFromMessage } from '../sub-agent'

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

describe('finalReportText', () => {
  test('returns only the text after the last tool call, dropping narration', () => {
    expect(
      finalReportText(
        msg([
          { type: 'text', text: 'Let me search.' },
          { type: 'tool-search', toolCallId: 's1' },
          { type: 'text', text: 'Let me fetch a page.' },
          { type: 'tool-fetch', toolCallId: 'f1' },
          { type: 'text', text: '## Report\nThe answer [1](#s1).' }
        ])
      )
    ).toBe('## Report\nThe answer [1](#s1).')
  })

  test('preserves inline citations (unlike extractIndexableText)', () => {
    expect(
      finalReportText(
        msg([
          { type: 'tool-search', toolCallId: 'a' },
          { type: 'text', text: 'Fact [1](#a) and [2](#a).' }
        ])
      )
    ).toBe('Fact [1](#a) and [2](#a).')
  })

  test('with no tool parts, returns all the text', () => {
    expect(
      finalReportText(msg([{ type: 'text', text: '## Direct answer.' }]))
    ).toBe('## Direct answer.')
  })

  test('recovers a heading-led answer that is trailed by a tool part', () => {
    expect(
      finalReportText(
        msg([
          { type: 'text', text: 'narration' },
          { type: 'tool-search', toolCallId: 's1' },
          { type: 'text', text: '## The answer.' },
          { type: 'tool-dynamic', toolCallId: 'followups' }
        ])
      )
    ).toBe('## The answer.')
  })

  test('strips a same-part narration preamble before the heading', () => {
    expect(
      finalReportText(
        msg([
          { type: 'tool-search', toolCallId: 's1' },
          { type: 'text', text: 'Let me now write the response.\n## Title\nBody.' }
        ])
      )
    ).toBe('## Title\nBody.')
  })
})
