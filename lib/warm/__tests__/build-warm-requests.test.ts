import { describe, expect, it } from 'vitest'

import { buildWarmRequests, shouldWarm } from '../build-warm-requests'

describe('buildWarmRequests', () => {
  it('builds a tiny 1-token classifier generate that pins the model resident', () => {
    const reqs = buildWarmRequests({
      CLASSIFIER_OLLAMA_BASE_URL: 'http://classifier:11434',
      CLASSIFIER_MODEL_ID: 'granite4.2:8b'
    })

    expect(reqs).toHaveLength(1)
    expect(reqs[0].url).toBe('http://classifier:11434/api/generate')
    const body = JSON.parse(reqs[0].body)
    expect(body).toMatchObject({
      model: 'granite4.2:8b',
      stream: false,
      keep_alive: -1,
      options: { num_predict: 1 }
    })
  })

  it('strips a trailing slash on the base url', () => {
    const reqs = buildWarmRequests({
      CLASSIFIER_OLLAMA_BASE_URL: 'http://classifier:11434/'
    })
    expect(reqs[0].url).toBe('http://classifier:11434/api/generate')
  })

  it('includes reranker and embedder when both url and token are configured', () => {
    const reqs = buildWarmRequests({
      RERANKER_URL: 'http://reranker:8787',
      RERANKER_API_TOKEN: 'rt',
      EMBEDDING_SERVICE_URL: 'http://embedder:8788',
      EMBEDDING_SERVICE_TOKEN: 'et',
      EMBEDDING_MODEL: 'mixedbread-ai/mxbai-embed-large-v1'
    })

    const urls = reqs.map(r => r.url)
    expect(urls).toEqual([
      'http://reranker:8787/rerank',
      'http://embedder:8788/embed'
    ])
    expect(reqs[0].headers.Authorization).toBe('Bearer rt')
    expect(reqs[1].headers.Authorization).toBe('Bearer et')
  })

  it('skips a service whose token is missing rather than firing an unauthorized ping', () => {
    const reqs = buildWarmRequests({
      RERANKER_URL: 'http://reranker:8787'
    })
    expect(reqs).toEqual([])
  })

  it('returns nothing when no warm targets are configured', () => {
    expect(buildWarmRequests({})).toEqual([])
  })
})

describe('shouldWarm', () => {
  it('warms when nothing has been warmed yet', () => {
    expect(shouldWarm(null, 1_000, 10_000)).toBe(true)
  })

  it('skips a warm inside the throttle window', () => {
    expect(shouldWarm(1_000, 5_000, 10_000)).toBe(false)
  })

  it('warms again once the throttle window has elapsed', () => {
    expect(shouldWarm(1_000, 11_000, 10_000)).toBe(true)
  })
})
