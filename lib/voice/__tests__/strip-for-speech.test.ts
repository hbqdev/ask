// lib/voice/__tests__/strip-for-speech.test.ts
import { describe, expect, it } from 'vitest'

import { firstSentences, stripForSpeech } from '../strip-for-speech'

describe('stripForSpeech', () => {
  it('removes [n](#id) citation anchors but keeps the sentence', () => {
    expect(stripForSpeech('Nvidia leads the market [1](#call_abc).')).toBe(
      'Nvidia leads the market.'
    )
  })

  it('drops markdown tables entirely', () => {
    const md =
      'Here is a comparison:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nDone.'
    expect(stripForSpeech(md)).toBe('Here is a comparison: Done.')
  })

  it('strips bare URLs and markdown link syntax', () => {
    expect(
      stripForSpeech('See [the docs](https://x.com/y) at https://z.io.')
    ).toBe('See the docs at.')
  })

  it('removes heading/bold/list markup and collapses whitespace', () => {
    expect(stripForSpeech('## Title\n\n- **Key** point\n- Another')).toBe(
      'Title Key point Another'
    )
  })

  it('drops a terminated ```spec related-questions block, keeping the prose', () => {
    const md =
      'The engine keeps its character.\n\n```spec\n' +
      '{"op":"add","path":"/root","value":"main"}\n' +
      '{"op":"add","path":"/elements/main","value":{"type":"Stack"}}\n' +
      '```\n\nThat is all.'
    const out = stripForSpeech(md)
    expect(out).toBe('The engine keeps its character. That is all.')
    expect(out).not.toMatch(/spec|"op"|\/root/)
  })

  it('drops an unterminated trailing ```spec block (stream cut, no closing fence)', () => {
    const md =
      'The engine keeps its character.\n\n```spec\n' +
      '{"op":"add","path":"/root","value":"main"}\n' +
      '{"op":"add","path":"/elements/main"'
    expect(stripForSpeech(md)).toBe('The engine keeps its character.')
  })

  it('removes horizontal-rule lines (---, ***, ___) between paragraphs', () => {
    const md =
      'First part.\n\n---\n\nSecond part.\n\n***\n\nThird.\n\n___\n\nEnd.'
    expect(stripForSpeech(md)).toBe('First part. Second part. Third. End.')
  })
})

describe('firstSentences', () => {
  it('returns the first n sentences', () => {
    expect(firstSentences('One. Two. Three.', 2)).toBe('One. Two.')
  })
  it('returns everything if fewer than n', () => {
    expect(firstSentences('Only one.', 2)).toBe('Only one.')
  })
})

describe('firstSentences — decimals and sentence starts', () => {
  it('does not split on a decimal point and starts at the true beginning', () => {
    const text =
      'Short answer: the 4090 is about 1.6–2× faster at token generation. Both have 24 GB.'
    expect(firstSentences(text, 1)).toBe(
      'Short answer: the 4090 is about 1.6–2× faster at token generation.'
    )
    expect(firstSentences(text, 2)).toBe(text)
  })

  it('keeps a decimal temperature inside its sentence', () => {
    const text =
      'A fever of 39°C (102.2°F) in a child is common. Most fevers pass in a few days. See a doctor if it persists.'
    expect(firstSentences(text, 2)).toBe(
      'A fever of 39°C (102.2°F) in a child is common. Most fevers pass in a few days.'
    )
  })

  it('splits on ! and ?', () => {
    expect(firstSentences('Wow! Really? Yes. No.', 3)).toBe('Wow! Really? Yes.')
  })

  it('returns trimmed text when there is no terminal punctuation', () => {
    expect(firstSentences('  no punctuation here  ', 2)).toBe(
      'no punctuation here'
    )
  })
})
