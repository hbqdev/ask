import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { crossEncoderScore, isCrossEncoderConfigured } from '../cross-encoder'

describe('cross-encoder client', () => {
  const origUrl = process.env.RERANKER_URL
  const origToken = process.env.RERANKER_API_TOKEN

  beforeEach(() => {
    process.env.RERANKER_URL = 'http://reranker.test:8787'
    process.env.RERANKER_API_TOKEN = 'tok'
  })
  afterEach(() => {
    process.env.RERANKER_URL = origUrl
    process.env.RERANKER_API_TOKEN = origToken
    vi.restoreAllMocks()
  })

  it('isCrossEncoderConfigured requires both env vars', () => {
    expect(isCrossEncoderConfigured()).toBe(true)
    delete process.env.RERANKER_API_TOKEN
    expect(isCrossEncoderConfigured()).toBe(false)
  })

  it('returns [] for empty passages without calling the service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const scores = await crossEncoderScore('q', [])
    expect(scores).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts pairs and returns the scores array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ scores: [0.9, 0.1] }), { status: 200 })
    )
    const scores = await crossEncoderScore('q', ['a', 'b'])
    expect(scores).toEqual([0.9, 0.1])
  })

  it('throws on non-ok HTTP so callers can fall back', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 401 })
    )
    await expect(crossEncoderScore('q', ['a'])).rejects.toThrow()
  })
})
