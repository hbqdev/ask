import { describe, expect, it } from 'vitest'

import { resolveStandaloneQuery } from '../query-classifier'

describe('resolveStandaloneQuery', () => {
  it('returns the raw message when the query is standalone', () => {
    expect(
      resolveStandaloneQuery(
        { queryIsStandalone: true, standaloneQuery: '' },
        'best vector db 2026'
      )
    ).toBe('best vector db 2026')
  })

  it('returns the rewrite when the query is not standalone', () => {
    expect(
      resolveStandaloneQuery(
        { queryIsStandalone: false, standaloneQuery: 'pricing of Pinecone' },
        'what about its pricing?'
      )
    ).toBe('pricing of Pinecone')
  })

  it('falls back to the raw message if a non-standalone rewrite is empty', () => {
    expect(
      resolveStandaloneQuery(
        { queryIsStandalone: false, standaloneQuery: '' },
        'raw message'
      )
    ).toBe('raw message')
  })
})
