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
})

describe('firstSentences', () => {
  it('returns the first n sentences', () => {
    expect(firstSentences('One. Two. Three.', 2)).toBe('One. Two.')
  })
  it('returns everything if fewer than n', () => {
    expect(firstSentences('Only one.', 2)).toBe('Only one.')
  })
})
