import { describe, expect, it } from 'vitest'

import { chooseRecall } from '../choose-recall'

describe('chooseRecall', () => {
  it('gates recall on skipSearch turns regardless of query', () => {
    expect(
      chooseRecall({
        skipSearch: true,
        standaloneQuery: 'anything',
        latestMessageText: 'anything'
      })
    ).toBe('gated')
    expect(
      chooseRecall({
        skipSearch: true,
        standaloneQuery: 'rewritten differently',
        latestMessageText: 'hi'
      })
    ).toBe('gated')
  })

  it('uses the speculative result when the standalone query equals the raw message', () => {
    expect(
      chooseRecall({
        skipSearch: false,
        standaloneQuery: 'best vector db 2026',
        latestMessageText: 'best vector db 2026'
      })
    ).toBe('speculative')
  })

  it('treats an empty standalone query as speculative (falls back to the raw message)', () => {
    expect(
      chooseRecall({
        skipSearch: false,
        standaloneQuery: '',
        latestMessageText: 'best vector db 2026'
      })
    ).toBe('speculative')
  })

  it('refetches when the standalone query differs from the raw message', () => {
    expect(
      chooseRecall({
        skipSearch: false,
        standaloneQuery: 'what is the pricing of Pinecone',
        latestMessageText: 'what about its pricing?'
      })
    ).toBe('refetch')
  })
})
