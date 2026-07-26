import { describe, expect, it } from 'vitest'

import { buildExcerptContent } from '../build-excerpt'

describe('buildExcerptContent', () => {
  it('joins adjacent passages as continuous prose, with no elision marker', () => {
    const out = buildExcerptContent(
      [
        { text: 'first part', index: 0 },
        { text: 'second part', index: 1 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('first part\nsecond part')
    expect(out).not.toContain('[…]')
  })

  it('marks the elision when passages skip document positions', () => {
    const out = buildExcerptContent(
      [
        { text: 'opening', index: 0 },
        { text: 'much later', index: 7 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('opening\n[…]\nmuch later')
  })

  it('marks only the real gaps in a mixed run', () => {
    const out = buildExcerptContent(
      [
        { text: 'a', index: 2 },
        { text: 'b', index: 3 },
        { text: 'c', index: 9 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('a\nb\n[…]\nc')
  })

  it('falls back to the original content when there are no passages', () => {
    // A document that produced no passages, or a rerank tier that scores no
    // passages at all, must keep its full text rather than become empty.
    expect(buildExcerptContent([], 'FALLBACK')).toBe('FALLBACK')
  })

  it('sorts defensively by index rather than trusting call order', () => {
    const out = buildExcerptContent(
      [
        { text: 'later', index: 5 },
        { text: 'earlier', index: 1 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('earlier\n[…]\nlater')
  })

  it('returns a single passage with no marker at all', () => {
    expect(buildExcerptContent([{ text: 'only', index: 4 }], 'FALLBACK')).toBe(
      'only'
    )
  })

  it('drops blank passages instead of emitting stray markers', () => {
    const out = buildExcerptContent(
      [
        { text: 'real', index: 0 },
        { text: '   ', index: 1 }
      ],
      'FALLBACK'
    )
    expect(out).toBe('real')
  })

  it('falls back when every passage is blank', () => {
    expect(buildExcerptContent([{ text: '  ', index: 0 }], 'FALLBACK')).toBe(
      'FALLBACK'
    )
  })

  it('does not mutate or reorder the caller’s array', () => {
    const passages = [
      { text: 'later', index: 5 },
      { text: 'earlier', index: 1 }
    ]
    buildExcerptContent(passages, 'FALLBACK')
    expect(passages.map(p => p.index)).toEqual([5, 1])
  })
})
