import { describe, expect, test } from 'vitest'

import { normalizeUrl } from '@/lib/tools/search/providers/merge-degoog'

/**
 * The expansion merge in lib/tools/search.ts deduped variant results on the RAW
 * href while every other merge in the pipeline keys on normalizeUrl. This pins
 * the property that made the difference matter: the forms a differently-phrased
 * search variant realistically returns for the same page must collapse to one
 * key, or the page is appended twice — a duplicate source, a duplicate citation
 * index (extractCitationMaps derives them positionally), and the page's text
 * sent to the model twice.
 */
describe('variant merge dedup key', () => {
  test('collapses www, trailing slash and tracking params to one key', () => {
    const canonical = 'https://example.com/article'
    const variants = [
      'https://www.example.com/article',
      'https://example.com/article/',
      'https://example.com/article?utm_source=newsletter',
      'https://EXAMPLE.com/article'
    ]

    for (const v of variants) {
      expect(normalizeUrl(v)).toBe(normalizeUrl(canonical))
      // and raw equality — what the old code used — does NOT collapse them
      expect(v).not.toBe(canonical)
    }
  })

  test('keeps genuinely different pages distinct', () => {
    expect(normalizeUrl('https://example.com/a')).not.toBe(
      normalizeUrl('https://example.com/b')
    )
    expect(normalizeUrl('https://example.com/a?page=2')).not.toBe(
      normalizeUrl('https://example.com/a?page=3')
    )
  })
})
