import { describe, expect, it } from 'vitest'

import { extractIndexableText, IndexablePart } from '../extract-indexable-text'

const text = (t: string | null): IndexablePart => ({ type: 'text', text: t })
const tool = (name = 'tool-search'): IndexablePart => ({
  type: name,
  text: null
})

describe('extractIndexableText', () => {
  it('assistant: with narration then tool calls then the answer, returns ONLY the answer', () => {
    const parts: IndexablePart[] = [
      text(
        'I have strong coverage from two searches. Let me fetch a couple of the most authoritative sources.'
      ),
      tool('tool-search'),
      tool('tool-fetch'),
      text('## Good Practices for Backing Up Self-Hosted Services')
    ]
    const result = extractIndexableText('assistant', parts)
    expect(result).toBe('## Good Practices for Backing Up Self-Hosted Services')
    expect(result).not.toContain('I have strong coverage')
  })

  it('assistant: a tool call TRAILING the answer does not drop the answer', () => {
    // Verbatim shape from live prod (message aey8…/"Capital of Japan"): the
    // generative-UI tool-dynamic that renders follow-up questions is emitted
    // AFTER the answer text. Slicing from the last tool call overall left
    // nothing after it, so the whole answer was silently dropped from the
    // index — the message sat unindexed with 2,498 chars of real content.
    const parts: IndexablePart[] = [
      { type: 'step-start', text: null },
      { type: 'reasoning', text: null },
      tool('tool-search'),
      { type: 'step-start', text: null },
      { type: 'reasoning', text: null },
      text('## Capital of Japan\n\nThe capital of Japan is **Tokyo**.'),
      tool('tool-dynamic')
    ]
    expect(extractIndexableText('assistant', parts)).toBe(
      '## Capital of Japan\n\nThe capital of Japan is **Tokyo**.'
    )
  })

  it('assistant: still drops narration when a tool also trails the answer', () => {
    // The trailing-tool fix must not resurrect inter-step narration: the
    // boundary is the last tool BEFORE the final text, not the last overall.
    const parts: IndexablePart[] = [
      text('Let me search for that.'),
      tool('tool-search'),
      text('## The Answer'),
      tool('tool-dynamic')
    ]
    const result = extractIndexableText('assistant', parts)
    expect(result).toBe('## The Answer')
    expect(result).not.toContain('Let me search')
  })

  it('assistant: with no tool parts at all, returns the (only) text', () => {
    const parts: IndexablePart[] = [text('Paris is the capital of France.')]
    expect(extractIndexableText('assistant', parts)).toBe(
      'Paris is the capital of France.'
    )
  })

  it('assistant: narration AFTER the last tool call is included alongside the answer (indistinguishable by position)', () => {
    const parts: IndexablePart[] = [
      tool('tool-search'),
      text("Here's what I found:"),
      text('The actual answer content.')
    ]
    const result = extractIndexableText('assistant', parts)
    expect(result).toContain("Here's what I found:")
    expect(result).toContain('The actual answer content.')
  })

  it('user: joins all text parts', () => {
    const parts: IndexablePart[] = [
      text('What are'),
      text('the best backup practices?')
    ]
    const result = extractIndexableText('user', parts)
    expect(result).toContain('What are')
    expect(result).toContain('the best backup practices?')
  })

  it('strips [N](#anchor) citation markers but preserves ordinary markdown links', () => {
    const parts: IndexablePart[] = [
      text(
        'See [1](#selfhosting.sh) and [2](#c0bd1e3a-4caa-4682-bc1e-6f2cd0c7371c) for more, or read the [docs](https://example.com/docs).'
      )
    ]
    const result = extractIndexableText('assistant', parts)
    expect(result).not.toContain('[1](#selfhosting.sh)')
    expect(result).not.toContain('[2](#c0bd1e3a-4caa-4682-bc1e-6f2cd0c7371c)')
    expect(result).toContain('[docs](https://example.com/docs)')
  })

  it('ignores reasoning/step-start/data-* parts, keeping only text parts', () => {
    const parts: IndexablePart[] = [
      { type: 'reasoning', text: 'internal deliberation' },
      { type: 'step-start', text: null },
      { type: 'data-attachments', text: 'hidden data payload' },
      text('The real answer.')
    ]
    const result = extractIndexableText('assistant', parts)
    expect(result).toBe('The real answer.')
    expect(result).not.toContain('internal deliberation')
    expect(result).not.toContain('hidden data payload')
  })

  it('returns "" for empty parts array', () => {
    expect(extractIndexableText('assistant', [])).toBe('')
    expect(extractIndexableText('user', [])).toBe('')
  })

  it('returns "" for whitespace-only text', () => {
    const parts: IndexablePart[] = [text('   \n\t  ')]
    expect(extractIndexableText('assistant', parts)).toBe('')
    expect(extractIndexableText('user', parts)).toBe('')
  })

  it('returns "" for an assistant message whose only text is narration before the last tool call', () => {
    const parts: IndexablePart[] = [
      text('Let me search for that.'),
      tool('tool-search')
    ]
    expect(extractIndexableText('assistant', parts)).toBe('')
  })
})
