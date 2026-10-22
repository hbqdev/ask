import { afterEach, describe, expect, it, vi } from 'vitest'

import { transcribeAudio } from '../stt-client'

const blob = new Blob(['x'], { type: 'audio/webm' })

describe('transcribeAudio', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.WHISPER_SERVICE_URL
  })

  it('throws when the service URL is not configured', async () => {
    await expect(transcribeAudio(blob)).rejects.toThrow(/not configured/)
  })

  it('POSTs multipart to /v1/audio/transcriptions and returns text', async () => {
    process.env.WHISPER_SERVICE_URL = 'http://stt:8000'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: '  hello world  ' }), {
        status: 200
      })
    )
    const text = await transcribeAudio(blob)
    expect(text).toBe('hello world') // trimmed
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://stt:8000/v1/audio/transcriptions')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBeInstanceOf(FormData)
  })

  it('throws on a non-OK response', async () => {
    process.env.WHISPER_SERVICE_URL = 'http://stt:8000'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500 })
    )
    await expect(transcribeAudio(blob)).rejects.toThrow(/500/)
  })

  it('gives up after 60 s when the service never answers', async () => {
    process.env.WHISPER_SERVICE_URL = 'http://stt:8000'
    vi.useFakeTimers()
    try {
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            ;(init as RequestInit).signal!.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            )
          })
      )
      const pending = transcribeAudio(blob)
      const settled = vi.fn()
      pending.catch(settled)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).rejects.toThrow(/timed out/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("still honours the caller's abort signal", async () => {
    process.env.WHISPER_SERVICE_URL = 'http://stt:8000'
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          ;(init as RequestInit).signal!.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        })
    )
    const ctrl = new AbortController()
    const pending = transcribeAudio(blob, { signal: ctrl.signal })
    ctrl.abort()
    await expect(pending).rejects.toThrow(/aborted/)
  })
})
