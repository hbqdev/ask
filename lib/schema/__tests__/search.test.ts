import { describe, expect, it } from 'vitest'

import { searchSchema, strictSearchSchema } from '../search'

describe('searchSchema', () => {
  it('passes through a well-formed call unchanged', () => {
    const result = searchSchema.parse({
      query: 'latest ai news',
      type: 'general',
      content_types: ['news']
    })

    expect(result.type).toBe('general')
    expect(result.content_types).toEqual(['news'])
  })

  it('recovers when a model puts a content_types value into type', () => {
    // Mirrors a real failure from nemotron-3-ultra:cloud:
    // {"query":"...", "type":"news", "recency_days":"30"}
    const result = searchSchema.parse({
      query: 'SpaceX acquires xAI July 2026 Musk',
      type: 'news',
      recency_days: '30'
    })

    expect(result.type).toBe('general')
    expect(result.content_types).toEqual(['news'])
  })

  it('merges the misplaced value into existing content_types without duplicating', () => {
    const result = searchSchema.parse({
      query: 'test',
      type: 'news',
      content_types: ['web', 'news']
    })

    expect(result.type).toBe('general')
    expect(result.content_types).toEqual(['web', 'news'])
  })

  it('appends the misplaced value alongside other requested content_types', () => {
    const result = searchSchema.parse({
      query: 'test',
      type: 'it',
      content_types: ['web']
    })

    expect(result.type).toBe('general')
    expect(result.content_types).toEqual(['web', 'it'])
  })

  it('drops unrecognized extra fields instead of failing validation', () => {
    expect(() =>
      searchSchema.parse({
        query: 'test',
        type: 'general',
        recency_days: '30'
      })
    ).not.toThrow()
  })

  it('still rejects a genuinely invalid type value', () => {
    expect(() =>
      searchSchema.parse({
        query: 'test',
        type: 'bogus'
      })
    ).toThrow()
  })

  it('defaults type/content_types when omitted entirely', () => {
    const result = searchSchema.parse({ query: 'test' })

    expect(result.type).toBe('optimized')
    expect(result.content_types).toEqual(['web'])
  })
})

describe('strictSearchSchema', () => {
  const requiredFields = {
    query: 'test',
    search_mode: 'web' as const,
    max_results: 20,
    search_depth: 'basic' as const,
    include_domains: [],
    exclude_domains: []
  }

  it('recovers the same way as searchSchema for the required-fields variant', () => {
    const result = strictSearchSchema.parse({
      ...requiredFields,
      type: 'news',
      content_types: []
    })

    expect(result.type).toBe('general')
    expect(result.content_types).toEqual(['news'])
  })
})
