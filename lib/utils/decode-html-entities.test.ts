import { describe, expect, test } from 'vitest'

import { decodeHtmlEntities } from './decode-html-entities'

// The Discover feed renders raw source strings (SearXNG bing-news / degoog)
// directly as React text nodes, which do NOT decode HTML entities. Sources
// return HTML-encoded text (observed on prod: &#x27; and &quot;), so titles
// like "Anthropic&#x27;s models" and bodies with &quot; showed the literal
// entity. This decoder is applied server-side before the data is returned.
describe('decodeHtmlEntities', () => {
  test('decodes the entities actually observed in the feed', () => {
    expect(decodeHtmlEntities('Anthropic&#x27;s and OpenAI&#x27;s models')).toBe(
      "Anthropic's and OpenAI's models"
    )
    expect(decodeHtmlEntities('says &quot;increase trust&quot;')).toBe(
      'says "increase trust"'
    )
  })

  test('decodes the common named entities in news text', () => {
    expect(decodeHtmlEntities('AT&amp;T')).toBe('AT&T')
    expect(decodeHtmlEntities('1 &lt; 2 &gt; 0')).toBe('1 < 2 > 0')
    expect(decodeHtmlEntities('it&apos;s here')).toBe("it's here")
    expect(decodeHtmlEntities('a &mdash; b &ndash; c')).toBe('a — b – c')
    expect(decodeHtmlEntities('wait&hellip;')).toBe('wait…')
    expect(decodeHtmlEntities('they&rsquo;re &ldquo;in&rdquo;')).toBe(
      'they’re “in”'
    )
  })

  test('decodes both decimal and hex numeric entities', () => {
    expect(decodeHtmlEntities('it&#39;s')).toBe("it's")
    expect(decodeHtmlEntities('it&#x27;s')).toBe("it's")
    // multi-byte code point (emoji) via hex
    expect(decodeHtmlEntities('rocket &#x1F680; go')).toBe('rocket 🚀 go')
  })

  test('is a single pass — does not double-decode', () => {
    // &amp;#x27; must become the literal text "&#x27;", NOT an apostrophe.
    expect(decodeHtmlEntities('a&amp;#x27;b')).toBe('a&#x27;b')
  })

  test('leaves unknown or malformed entities untouched', () => {
    expect(decodeHtmlEntities('R&D budget')).toBe('R&D budget')
    expect(decodeHtmlEntities('use &foobar; here')).toBe('use &foobar; here')
    expect(decodeHtmlEntities('a & b')).toBe('a & b')
    expect(decodeHtmlEntities('&#xZZZ;')).toBe('&#xZZZ;')
  })

  test('returns non-entity strings unchanged (fast path)', () => {
    expect(decodeHtmlEntities('plain title with no entities')).toBe(
      'plain title with no entities'
    )
    expect(decodeHtmlEntities('')).toBe('')
  })

  test('tolerates non-string input without throwing', () => {
    // @ts-expect-error runtime guard for undefined source fields
    expect(decodeHtmlEntities(undefined)).toBe('')
    // @ts-expect-error runtime guard for null source fields
    expect(decodeHtmlEntities(null)).toBe('')
  })
})
