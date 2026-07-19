import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the ONNX runtime so the local path never downloads real models. The
// mock pipe returns a distinctive vector so tests can tell local output
// from remote output.
const mockPipe = vi.fn(async (texts: string[]) => ({
  tolist: () => texts.map(() => [0.5, 0.5])
}))
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => mockPipe),
  env: {}
}))

import { embedTexts } from '../transformers-embedding'

const REMOTE_VECTORS = [[0.1, 0.2]]

describe('embedTexts remote embedding service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('EMBEDDING_SERVICE_URL', 'http://embedder.test:8788')
    vi.stubEnv('EMBEDDING_SERVICE_TOKEN', 'test-token')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('uses the remote service when configured and healthy', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ embeddings: REMOTE_VECTORS }), {
          status: 200
        })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedTexts(
      ['hello'],
      'mixedbread-ai/mxbai-embed-large-v1'
    )

    expect(result).toEqual(REMOTE_VECTORS)
    expect(mockPipe).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://embedder.test:8788/embed',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token'
        }),
        body: JSON.stringify({
          texts: ['hello'],
          model: 'mixedbread-ai/mxbai-embed-large-v1'
        })
      })
    )
  })

  it('falls back to local inference when the service errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await embedTexts(['hello'])

    expect(result).toEqual([[0.5, 0.5]])
    expect(mockPipe).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to local CPU')
    )
    warn.mockRestore()
  })

  it('falls back to local inference on a malformed response', async () => {
    // Length mismatch: 2 texts in, 1 embedding out.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ embeddings: REMOTE_VECTORS }), {
            status: 200
          })
      )
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await embedTexts(['a', 'b'])

    expect(result).toEqual([
      [0.5, 0.5],
      [0.5, 0.5]
    ])
    expect(mockPipe).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('goes straight to local inference when the service is not configured', async () => {
    vi.stubEnv('EMBEDDING_SERVICE_URL', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedTexts(['hello'])

    expect(result).toEqual([[0.5, 0.5]])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns [] for empty input without calling anything', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await embedTexts([])

    expect(result).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mockPipe).not.toHaveBeenCalled()
  })
})
