import { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  stripNarrationFromMessage,
  stripNarrationFromMessages
} from '../strip-narration-from-message'

const texts = (msg: UIMessage) =>
  (msg.parts as any[]).filter(p => p.type === 'text').map(p => p.text as string)

describe('stripNarrationFromMessage — fused preamble (final answer part)', () => {
  it('strips a narration preamble fused in front of the answer heading', () => {
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'tool-search', toolCallId: 't1' },
        {
          type: 'text',
          text:
            'I have comprehensive data now. Let me construct the comparison.\n' +
            '## Intel Arc B770 vs RTX 5060\nHere is the comparison.'
        }
      ]
    } as unknown as UIMessage

    const out = stripNarrationFromMessage(msg)
    expect(texts(out)[0].startsWith('## Intel Arc B770')).toBe(true)
    expect(texts(out)[0]).not.toMatch(/comprehensive data now/)
  })

  it('leaves a clean final answer untouched', () => {
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'tool-search', toolCallId: 't1' },
        { type: 'text', text: '## Answer\nNode 24 is the current LTS.' }
      ]
    } as unknown as UIMessage

    expect(stripNarrationFromMessage(msg)).toBe(msg)
  })
})

describe('stripNarrationFromMessage — inter-step narration (mid-turn text part)', () => {
  it('drops a standalone narration text part followed by another tool call', () => {
    // The measured leak: narration TEXT part, THEN another tool call, THEN the
    // real answer. The narration part has no heading, so preamble-stripping
    // cannot touch it — it has to be dropped structurally.
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'tool-search', toolCallId: 't1' },
        {
          type: 'text',
          text: 'I have comprehensive data now. Let me search for the B770 pricing.'
        },
        { type: 'tool-search', toolCallId: 't2' },
        { type: 'text', text: '## GPU Comparison\nThe RTX 5060 wins on value.' }
      ]
    } as unknown as UIMessage

    const out = stripNarrationFromMessage(msg)
    // The inter-step narration part is gone; only the real answer text remains.
    expect(texts(out)).toEqual([
      '## GPU Comparison\nThe RTX 5060 wins on value.'
    ])
    // Tool parts are preserved.
    expect(
      (out.parts as any[]).filter(p => p.type === 'tool-search')
    ).toHaveLength(2)
  })

  it('drops a "let me search for more" inter-step part before the answer', () => {
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'tool-search', toolCallId: 't1' },
        {
          type: 'text',
          text: 'Let me search for more recent sources to confirm this.'
        },
        { type: 'dynamic-tool', toolName: 'search', toolCallId: 't2' },
        { type: 'text', text: '## Node.js LTS\nNode 24 is current LTS.' }
      ]
    } as unknown as UIMessage

    const out = stripNarrationFromMessage(msg)
    expect(texts(out)).toEqual(['## Node.js LTS\nNode 24 is current LTS.'])
  })

  it('drops multiple inter-step narration parts across a chained turn', () => {
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'tool-search', toolCallId: 't1' },
        { type: 'text', text: 'Let me search for the GPU specs.' },
        { type: 'tool-search', toolCallId: 't2' },
        {
          type: 'text',
          text: 'I now have good coverage. Let me verify pricing.'
        },
        { type: 'tool-search', toolCallId: 't3' },
        { type: 'text', text: '## Report\nFinal findings here.' }
      ]
    } as unknown as UIMessage

    const out = stripNarrationFromMessage(msg)
    expect(texts(out)).toEqual(['## Report\nFinal findings here.'])
  })

  it('does NOT drop a genuine interim text part that is not narration-shaped', () => {
    // Conservative: only narration-shaped interim text is dropped. A genuine
    // partial-content interim part is preserved.
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'tool-search', toolCallId: 't1' },
        {
          type: 'text',
          text: 'The RTX 5060 is a mid-range card released in 2026.'
        },
        { type: 'tool-search', toolCallId: 't2' },
        { type: 'text', text: '## Report\nFull findings.' }
      ]
    } as unknown as UIMessage

    const out = stripNarrationFromMessage(msg)
    expect(texts(out)).toEqual([
      'The RTX 5060 is a mid-range card released in 2026.',
      '## Report\nFull findings.'
    ])
  })

  it('does NOT drop the final answer even if it is narration-shaped (no later tool/text)', () => {
    // The last text part is the answer by definition, even if it happens to
    // open with a research-y phrase and has no heading — never drop it.
    const msg = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'tool-search', toolCallId: 't1' },
        {
          type: 'text',
          text: 'Based on my research, the RTX 5060 is the better value pick.'
        }
      ]
    } as unknown as UIMessage

    // No heading to anchor a preamble strip and no later part → returned as-is.
    expect(stripNarrationFromMessage(msg)).toBe(msg)
  })
})

describe('stripNarrationFromMessage — passthrough', () => {
  it('returns non-assistant messages unchanged', () => {
    const msg = {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: 'I have enough info, let me search.' }]
    } as unknown as UIMessage
    expect(stripNarrationFromMessage(msg)).toBe(msg)
  })

  it('does not mutate the original message object', () => {
    const original = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me search for more.' },
        { type: 'tool-search', toolCallId: 't1' },
        { type: 'text', text: '## Answer\nBody.' }
      ]
    } as unknown as UIMessage
    const snapshot = original.parts
    const out = stripNarrationFromMessage(original)
    expect(out).not.toBe(original)
    expect(original.parts).toBe(snapshot)
    expect(texts(original)).toHaveLength(2)
  })

  it('stripNarrationFromMessages maps over a list', () => {
    const list = [
      {
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me search for more.' },
          { type: 'tool-search', toolCallId: 't1' },
          { type: 'text', text: '## Answer\nBody.' }
        ]
      }
    ] as unknown as UIMessage[]
    const out = stripNarrationFromMessages(list)
    expect(texts(out[0])).toEqual(['## Answer\nBody.'])
  })
})
