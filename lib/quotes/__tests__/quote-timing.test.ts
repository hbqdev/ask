import { describe, expect, it } from 'vitest'

import { quoteTiming } from '../quote-timing'

// Each row was tuned with the operator and signed off. Treat these as fixed.
const CASES: Array<{
  text: string
  words: number
  totalMs: number
  governedBy: 'read' | 'reveal' | 'floor'
}> = [
  {
    text: 'We are made of star-stuff.',
    words: 5,
    totalMs: 3000,
    governedBy: 'floor'
  },
  {
    text: 'Somewhere, something incredible is waiting to be known.',
    words: 8,
    totalMs: 5127,
    governedBy: 'read'
  },
  {
    text: 'Any sufficiently advanced technology is indistinguishable from magic.',
    words: 8,
    totalMs: 6160,
    governedBy: 'read'
  },
  {
    text: 'I have no special talent. I am only passionately curious.',
    words: 10,
    totalMs: 4950,
    governedBy: 'reveal'
  },
  {
    text: 'The universe is under no obligation to make sense to you.',
    words: 11,
    totalMs: 5375,
    governedBy: 'reveal'
  },
  {
    text: "The good thing about science is that it's true whether or not you believe in it.",
    words: 16,
    totalMs: 7500,
    governedBy: 'reveal'
  }
]

describe('quoteTiming', () => {
  for (const c of CASES) {
    it(`${c.words}w → ${(c.totalMs / 1000).toFixed(1)}s, governed by ${c.governedBy}`, () => {
      const t = quoteTiming(c.text)
      expect(t.words).toBe(c.words)
      expect(Math.round(t.totalMs)).toBe(c.totalMs)
      expect(t.governedBy).toBe(c.governedBy)
    })
  }

  it('keeps the 300ms cadence for quotes up to 20 words', () => {
    const t = quoteTiming('one two three four five six seven eight nine ten')
    expect(t.perWordMs).toBe(300)
  })

  it('holds the full cadence at exactly 20 words and tightens at 21', () => {
    // 20 words is the last count that fits the ceiling at a flat 300ms/word
    // (20 x 300 = 6000). One more word has to give something up.
    const twenty = Array.from({ length: 20 }, () => 'word').join(' ')
    const twentyOne = Array.from({ length: 21 }, () => 'word').join(' ')
    expect(quoteTiming(twenty).perWordMs).toBe(300)
    expect(quoteTiming(twentyOne).perWordMs).toBeLessThan(300)
  })

  it('tightens the cadence so a long quote still reveals within the ceiling', () => {
    // 40 words at a flat 300ms would be a 12s reveal; the ceiling is 6s.
    const text = Array.from({ length: 40 }, () => 'word').join(' ')
    const t = quoteTiming(text)
    expect(t.perWordMs).toBeLessThan(300)
    expect(t.revealMs).toBeLessThanOrEqual(6000)
  })

  it('never exceeds the reveal ceiling even at the longest quote in the pool', () => {
    const text = Array.from({ length: 80 }, () => 'word').join(' ')
    expect(quoteTiming(text).revealMs).toBeLessThanOrEqual(6000)
  })

  it('caps the tail so it cannot run away on long quotes', () => {
    const text = Array.from({ length: 80 }, () => 'word').join(' ')
    expect(quoteTiming(text).tailMs).toBe(3200)
  })

  it('never returns less than the floor', () => {
    expect(quoteTiming('Hi there.').totalMs).toBe(3000)
  })

  it('returns a zeroed result for empty text rather than dividing by zero', () => {
    const t = quoteTiming('   ')
    expect(t.words).toBe(0)
    expect(t.totalMs).toBe(3000)
  })

  it('returns a zeroed result for the empty string, not just whitespace', () => {
    // ''.split(/\s+/) yields [''], so the word count only reaches zero after
    // the filter — worth pinning, since a regression here divides by zero.
    const t = quoteTiming('')
    expect(t.words).toBe(0)
    expect(t.chars).toBe(0)
    expect(t.readMs).toBe(0)
    expect(t.revealMs).toBe(0)
    expect(t.totalMs).toBe(3000)
    expect(t.governedBy).toBe('floor')
  })

  it('breaks an exact tie in favour of read, then reveal, then floor', () => {
    // Ties are only observable when two demands land on the very same
    // millisecond. A sweep of every (words, chars, pauses) shape with a
    // plausible average word length finds none, so these inputs are synthetic
    // — built to force the collision the priority order exists to resolve.

    // 16 words / 65 chars / 20 pause marks: read is 3900 + 3600 = 7500, which
    // is exactly the 4800 reveal plus the 2700 tail.
    const readVsReveal = `${'a'.repeat(15)}${' a'.repeat(15)}${','.repeat(20)}`
    const tied = quoteTiming(readVsReveal)
    expect(tied.words).toBe(16)
    expect(tied.readMs).toBe(tied.revealMs + tied.tailMs)
    expect(tied.governedBy).toBe('read')

    // 1 word / 18 chars / 8 pause marks: read is 1560 + 1440 = 3000, exactly
    // the floor, while the reveal total stays well below it.
    const readVsFloor = `${'a'.repeat(10)}${','.repeat(8)}`
    const onFloor = quoteTiming(readVsFloor)
    expect(onFloor.readMs).toBe(3000)
    expect(onFloor.revealMs + onFloor.tailMs).toBeLessThan(3000)
    expect(onFloor.governedBy).toBe('read')

    // Reveal can never tie the floor: for quotes at the full cadence the
    // reveal total is 425w + 700, so 3000ms would take 5.4 words. Five words
    // fall short (2825) and six overshoot (3250) — assert either side.
    const five = quoteTiming(Array.from({ length: 5 }, () => 'word').join(' '))
    const six = quoteTiming(Array.from({ length: 6 }, () => 'word').join(' '))
    expect(five.revealMs + five.tailMs).toBe(2825)
    expect(five.governedBy).toBe('floor')
    expect(six.revealMs + six.tailMs).toBe(3250)
    expect(six.governedBy).toBe('reveal')
  })
})
