import { describe, expect, it } from 'vitest'

import { dedupeByUrl, isDisplayable, shuffle } from '../discover-mix'

describe('isDisplayable', () => {
  it('accepts an item with a thumbnail and a long-enough title', () => {
    expect(
      isDisplayable({
        title: 'A perfectly reasonable news headline about things',
        url: 'https://example.com/a',
        thumbnail: 'https://example.com/a.jpg'
      })
    ).toBe(true)
  })

  it('rejects items missing a thumbnail', () => {
    expect(
      isDisplayable({
        title: 'A perfectly reasonable news headline about things',
        url: 'https://example.com/a',
        thumbnail: ''
      })
    ).toBe(false)
    expect(
      isDisplayable({
        title: 'A perfectly reasonable news headline about things',
        url: 'https://example.com/a'
      })
    ).toBe(false)
  })

  it('rejects stub titles shorter than 20 characters', () => {
    expect(
      isDisplayable({
        title: 'Short',
        url: 'https://example.com/a',
        thumbnail: 'https://example.com/a.jpg'
      })
    ).toBe(false)
  })
})

describe('dedupeByUrl', () => {
  it('keeps first occurrence and drops later duplicates, case-insensitively', () => {
    const out = dedupeByUrl([
      { url: 'https://example.com/A', category: 'Tech' },
      { url: 'https://example.com/a', category: 'World' },
      { url: 'https://example.com/b', category: 'Sports' }
    ])
    expect(out.map(i => i.category)).toEqual(['Tech', 'Sports'])
  })

  it('drops items without a url', () => {
    const out = dedupeByUrl([{ url: '' }, { url: undefined }, { url: 'x' }])
    expect(out).toEqual([{ url: 'x' }])
  })
})

describe('shuffle', () => {
  it('returns a permutation without mutating the input', () => {
    const input = [1, 2, 3, 4, 5]
    const out = shuffle(input, () => 0)
    expect([...out].sort()).toEqual([1, 2, 3, 4, 5])
    expect(input).toEqual([1, 2, 3, 4, 5])
  })

  it('is deterministic for a fixed rng', () => {
    const rng = () => 0.5
    expect(shuffle([1, 2, 3, 4], rng)).toEqual(shuffle([1, 2, 3, 4], rng))
  })
})

// The mixed feed's core invariant: composing the route's per-category pick with
// dedupeByUrl yields at most one article per category and no duplicate URLs.
describe('mixed feed selection invariant', () => {
  it('produces distinct categories and distinct urls', () => {
    const perCategory = [
      {
        category: 'Tech',
        url: 'https://t.com/1',
        title: 'x'.repeat(30),
        thumbnail: 't'
      },
      {
        category: 'World',
        url: 'https://w.com/1',
        title: 'x'.repeat(30),
        thumbnail: 't'
      },
      // Same wire story surfaced under a second category — must be dropped.
      {
        category: 'Finance',
        url: 'https://w.com/1',
        title: 'x'.repeat(30),
        thumbnail: 't'
      }
    ]

    const result = dedupeByUrl(perCategory)

    expect(new Set(result.map(i => i.category)).size).toBe(result.length)
    expect(new Set(result.map(i => i.url)).size).toBe(result.length)
    expect(result.map(i => i.category)).toEqual(['Tech', 'World'])
  })
})
