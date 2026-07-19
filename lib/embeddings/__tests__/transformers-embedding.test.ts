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
          model: 'mixedbread-ai/mxbai-embed-large-v1',
          kind: 'document'
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

  it('passes kind through to the service, defaulting to document', async () => {
    const bodies: Array<{ kind?: string }> = []
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ embeddings: REMOTE_VECTORS }), {
        status: 200
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await embedTexts(['q'], 'mixedbread-ai/mxbai-embed-large-v1', {
      kind: 'query'
    })
    await embedTexts(['d'], 'mixedbread-ai/mxbai-embed-large-v1')

    expect(bodies.map(b => b.kind)).toEqual(['query', 'document'])
  })

  it('throws instead of falling back locally for remote-only models', async () => {
    // Qwen3 uses last-token pooling + query instructions, which the local
    // ONNX path cannot replicate — a silent fallback would write
    // wrong-space vectors into the store.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    )

    await expect(
      embedTexts(['hello'], 'Qwen/Qwen3-Embedding-0.6B')
    ).rejects.toThrow('embedder HTTP 500')
    expect(mockPipe).not.toHaveBeenCalled()
  })

  it('throws for remote-only models when the service is not configured', async () => {
    vi.stubEnv('EMBEDDING_SERVICE_URL', '')

    await expect(
      embedTexts(['hello'], 'Qwen/Qwen3-Embedding-0.6B')
    ).rejects.toThrow('requires the remote embedding service')
    expect(mockPipe).not.toHaveBeenCalled()
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
