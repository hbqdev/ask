import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  crossEncoderScore,
  isCrossEncoderConfigured,
  recallRerankerUrl
} from '../cross-encoder'

describe('cross-encoder client', () => {
  const origUrl = process.env.RERANKER_URL
  const origToken = process.env.RERANKER_API_TOKEN
  const origRecallUrl = process.env.RECALL_RERANKER_URL

  beforeEach(() => {
    process.env.RERANKER_URL = 'http://reranker.test:8787'
    process.env.RERANKER_API_TOKEN = 'tok'
    delete process.env.RECALL_RERANKER_URL
  })
  afterEach(() => {
    process.env.RERANKER_URL = origUrl
    process.env.RERANKER_API_TOKEN = origToken
    if (origRecallUrl === undefined) delete process.env.RECALL_RERANKER_URL
    else process.env.RECALL_RERANKER_URL = origRecallUrl
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

  it('posts to RERANKER_URL by default', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ scores: [0.5] }), { status: 200 })
      )
    await crossEncoderScore('q', ['a'])
    expect(fetchSpy.mock.calls[0][0]).toBe('http://reranker.test:8787/rerank')
  })

  it('posts to opts.baseUrl when given, with the same token', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ scores: [0.5] }), { status: 200 })
      )
    await crossEncoderScore('q', ['a'], { baseUrl: 'http://recall.test:8789/' })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('http://recall.test:8789/rerank')
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok'
    )
  })

  it('isCrossEncoderConfigured checks an explicit endpoint + the shared token', () => {
    delete process.env.RERANKER_URL
    expect(isCrossEncoderConfigured()).toBe(false)
    expect(isCrossEncoderConfigured('http://recall.test:8789')).toBe(true)
    delete process.env.RERANKER_API_TOKEN
    expect(isCrossEncoderConfigured('http://recall.test:8789')).toBe(false)
  })

  describe('recallRerankerUrl', () => {
    it('falls back to RERANKER_URL when RECALL_RERANKER_URL is unset', () => {
      expect(recallRerankerUrl()).toBe('http://reranker.test:8787')
    })

    it('falls back to RERANKER_URL when RECALL_RERANKER_URL is blank', () => {
      process.env.RECALL_RERANKER_URL = '  '
      expect(recallRerankerUrl()).toBe('http://reranker.test:8787')
    })

    it('prefers RECALL_RERANKER_URL when set', () => {
      process.env.RECALL_RERANKER_URL = 'http://recall.test:8789'
      expect(recallRerankerUrl()).toBe('http://recall.test:8789')
    })
  })
})
