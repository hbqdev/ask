import { describe, expect, it } from 'vitest'

import { FALLBACK_QUOTES } from '../fallback-quotes'
import { acceptQuote, normalizePool } from '../quote-pool'

/** Deterministic source, so the distribution assertions below can never flake. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Pinned just under 1, which makes Fisher-Yates pick j === i at every step. */
const NEVER_SWAPS = () => 0.999999

describe('acceptQuote', () => {
  it('accepts a well-formed quote', () => {
    expect(
      acceptQuote({ q: 'We are made of star-stuff.', a: 'Carl Sagan' })
    ).toBe(true)
  })

  it('accepts both extremes of length — there is no length cap', () => {
    expect(acceptQuote({ q: 'Be curious.', a: 'Someone' })).toBe(true)
    const long = Array.from({ length: 80 }, () => 'word').join(' ')
    expect(acceptQuote({ q: long, a: 'Someone' })).toBe(true)
  })

  it('rejects rows missing text or attribution', () => {
    expect(acceptQuote({ q: '', a: 'Carl Sagan' })).toBe(false)
    expect(acceptQuote({ q: 'Something', a: '   ' })).toBe(false)
    expect(acceptQuote({ q: 'Something' })).toBe(false)
    expect(acceptQuote(null)).toBe(false)
    expect(acceptQuote({ q: 5, a: 'x' })).toBe(false)
  })

  it('rejects a non-string attribution and non-object rows', () => {
    expect(acceptQuote({ q: 'Something', a: 5 })).toBe(false)
    expect(acceptQuote({ q: '   ', a: 'Carl Sagan' })).toBe(false)
    expect(acceptQuote(undefined)).toBe(false)
    expect(acceptQuote('We are made of star-stuff.')).toBe(false)
    expect(acceptQuote([])).toBe(false)
  })
})

describe('normalizePool', () => {
  // Pinned end-to-end, not just at acceptQuote: a length cap hidden inside
  // normalizePool passed the whole suite, because every other fixture here is
  // short. The pool runs to 80 words and the timing function adapts its cadence
  // for them, so dropping long quotes would silently shrink the library.
  it('passes the longest quotes in the pool through untouched', () => {
    const long = Array.from({ length: 80 }, () => 'word').join(' ')
    const pool = normalizePool([{ q: long, a: 'Someone' }], () => 0)

    expect(pool).toHaveLength(1)
    expect(pool[0].q).toBe(long)
    expect(pool[0].q.split(' ')).toHaveLength(80)
  })

  it('drops invalid rows and keeps the valid ones', () => {
    const pool = normalizePool(
      [{ q: 'One.', a: 'A' }, null, { q: '', a: 'B' }, { q: 'Two.', a: 'C' }],
      () => 0
    )
    // Sorted: the pool comes back shuffled, so only membership is asserted here.
    expect(pool.map(p => p.q).sort()).toEqual(['One.', 'Two.'])
  })

  it('returns an empty pool for no usable rows', () => {
    expect(normalizePool([], () => 0)).toEqual([])
    expect(normalizePool([null, { q: '', a: '' }, 7], () => 0)).toEqual([])
  })

  it('dedupes case-insensitively on the text, keeping the first row', () => {
    const pool = normalizePool(
      [
        { q: 'We are made of star-stuff.', a: 'Carl Sagan' },
        { q: 'we are MADE of star-stuff.', a: 'C. Sagan' }
      ],
      () => 0
    )
    expect(pool).toHaveLength(1)
    expect(pool[0].a).toBe('Carl Sagan')
  })

  it('dedupes on the trimmed text, not the raw text', () => {
    const pool = normalizePool(
      [
        { q: 'We are made of star-stuff.', a: 'Carl Sagan' },
        { q: '  We are made of star-stuff.  ', a: 'C. Sagan' },
        { q: '\tWE ARE MADE OF STAR-STUFF.\n', a: 'Sagan' }
      ],
      () => 0
    )
    expect(pool).toHaveLength(1)
  })

  it('trims surrounding whitespace', () => {
    const pool = normalizePool([{ q: '  Spaced.  ', a: '  Author  ' }], () => 0)
    expect(pool[0]).toEqual({ q: 'Spaced.', a: 'Author' })
  })

  it('shuffles using the injected random source', () => {
    const rows = [
      { q: 'A.', a: 'x' },
      { q: 'B.', a: 'x' },
      { q: 'C.', a: 'x' }
    ]
    // Fisher-Yates ascending: a source stuck at 0 walks each element to the front.
    expect(normalizePool(rows, () => 0).map(p => p.q)).toEqual([
      'C.',
      'A.',
      'B.'
    ])
  })

  it('leaves the order untouched when every draw selects the element itself', () => {
    // Guards the index arithmetic: with `random() * i` instead of `random() * (i + 1)`
    // a source pinned near 1 would select j === i - 1 and cascade the whole array.
    const rows = Array.from({ length: 12 }, (_, i) => ({ q: `Q${i}.`, a: 'x' }))
    expect(normalizePool(rows, NEVER_SWAPS).map(p => p.q)).toEqual(
      rows.map(r => r.q)
    )
  })

  it('shuffles without losing, duplicating or holing the pool', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ q: `Q${i}.`, a: 'x' }))
    const random = seeded(7)
    for (let run = 0; run < 200; run++) {
      const pool = normalizePool(rows, random)
      expect(pool).toHaveLength(rows.length)
      expect(pool.every(p => typeof p?.q === 'string')).toBe(true)
      expect([...pool].map(p => p.q).sort()).toEqual(rows.map(r => r.q).sort())
    }
  })

  it('can produce every permutation, not just a biased subset', () => {
    // A cyclic-only shuffle (Sattolo) or an off-by-one bound would never emit
    // some of these six. Deterministic source, so the counts cannot flake.
    const rows = [
      { q: 'A.', a: 'x' },
      { q: 'B.', a: 'x' },
      { q: 'C.', a: 'x' }
    ]
    const random = seeded(42)
    const counts = new Map<string, number>()
    for (let run = 0; run < 6000; run++) {
      const key = normalizePool(rows, random)
        .map(p => p.q)
        .join('')
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    expect(counts.size).toBe(6)
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(800)
      expect(count).toBeLessThan(1200)
    }
  })

  it('does not mutate the rows it was handed', () => {
    const rows = [
      { q: '  A.  ', a: '  x  ' },
      { q: 'B.', a: 'y' },
      { q: 'C.', a: 'z' }
    ]
    const before = JSON.stringify(rows)
    normalizePool(rows, seeded(3))
    expect(JSON.stringify(rows)).toBe(before)
  })
})

describe('FALLBACK_QUOTES', () => {
  it('ships enough quotes to cover a long wait without repeating', () => {
    expect(FALLBACK_QUOTES.length).toBeGreaterThanOrEqual(20)
  })

  it('every bundled quote survives its own validation', () => {
    for (const q of FALLBACK_QUOTES) expect(acceptQuote(q)).toBe(true)
  })

  it('survives normalisation intact — no duplicates silently shrink the set', () => {
    // The ">= 20" promise is only kept if none of the bundled rows dedupe away.
    expect(normalizePool(FALLBACK_QUOTES, () => 0)).toHaveLength(
      FALLBACK_QUOTES.length
    )
  })
})
