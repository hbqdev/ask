import { describe, expect, it } from 'vitest'

import { intentToCategory, SEARCH_INTENTS } from '../intent'

describe('intentToCategory', () => {
  it('maps each non-general intent to its additive SearXNG category', () => {
    expect(intentToCategory('code')).toBe('it')
    expect(intentToCategory('discussion')).toBe('social media')
    expect(intentToCategory('news')).toBe('news')
    expect(intentToCategory('academic')).toBe('science')
  })

  it('returns null for general (adds nothing to the baseline)', () => {
    expect(intentToCategory('general')).toBeNull()
  })

  it('exposes exactly the five supported intents', () => {
    expect([...SEARCH_INTENTS]).toEqual([
      'general',
      'code',
      'discussion',
      'news',
      'academic'
    ])
  })
})
