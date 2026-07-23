import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { runReplicatePrediction } from '../replicate-client'

const okPrediction = (
  status: string,
  output: unknown = null,
  error: string | null = null
) => ({
  ok: true,
  json: async () => ({ id: 'p1', status, output, error })
})

describe('runReplicatePrediction', () => {
  beforeEach(() => {
    vi.stubEnv('REPLICATE_API_TOKEN', 'r8_test')
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('returns the output URL when Prefer:wait resolves synchronously', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okPrediction('succeeded', [
        'https://replicate.delivery/x/out.webp'
      ]) as any
    )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toEqual({
      ok: true,
      outputUrl: 'https://replicate.delivery/x/out.webp'
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://api.replicate.com/v1/models/a/b/predictions')
    expect((init!.headers as Record<string, string>).Prefer).toBe('wait')
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      'Bearer r8_test'
    )
  })

  it('accepts a single string output', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okPrediction('succeeded', 'https://replicate.delivery/x/one.png') as any
    )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toEqual({
      ok: true,
      outputUrl: 'https://replicate.delivery/x/one.png'
    })
  })

  it('polls until terminal when the sync window elapses', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(okPrediction('processing') as any) // create
      .mockResolvedValueOnce(okPrediction('processing') as any) // poll 1
      .mockResolvedValueOnce(
        okPrediction('succeeded', [
          'https://replicate.delivery/x/late.webp'
        ]) as any
      )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toEqual({
      ok: true,
      outputUrl: 'https://replicate.delivery/x/late.webp'
    })
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
      'https://api.replicate.com/v1/predictions/p1'
    )
  }, 15000)

  it.each([
    [401, 'auth'],
    [402, 'billing'],
    [422, 'model']
  ])('maps HTTP %s to errorClass %s', async (status, errorClass) => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status,
      json: async () => ({ detail: 'nope' })
    } as any)
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass })
  })

  it('maps a failed prediction mentioning sensitive content to "content"', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      okPrediction('failed', null, 'flagged as sensitive content') as any
    )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass: 'content' })
  })

  it('times out via REPLICATE_TIMEOUT_MS', async () => {
    vi.stubEnv('REPLICATE_TIMEOUT_MS', '50')
    vi.mocked(fetch).mockResolvedValue(okPrediction('processing') as any)
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass: 'timeout' })
  })

  it('returns network error when fetch rejects', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass: 'network' })
  })

  it('aborts the initial Prefer:wait request at REPLICATE_TIMEOUT_MS', async () => {
    vi.stubEnv('REPLICATE_TIMEOUT_MS', '50')
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(
              Object.assign(new Error('timed out'), { name: 'TimeoutError' })
            )
          )
        }) as any
    )
    const res = await runReplicatePrediction({
      modelPath: 'a/b',
      input: { prompt: 'x' }
    })
    expect(res).toMatchObject({ ok: false, errorClass: 'timeout' })
  })
})
