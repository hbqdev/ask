import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NETWORK_ERROR_MESSAGE } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import {
  audioFilename,
  TOO_LONG_MESSAGE,
  transcribe,
  TRANSCRIBE_TIMEOUT_MS,
  UNAVAILABLE_MESSAGE
} from '@/features/voice/transcribe'

const BASE = 'https://ask.test.invalid'
const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const mp4 = new Blob(['voice'], { type: 'audio/mp4' })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

describe('audioFilename', () => {
  it('names mp4 audio .m4a and webm audio .webm', () => {
    expect(audioFilename('audio/mp4')).toBe('audio.m4a')
    expect(audioFilename('audio/webm;codecs=opus')).toBe('audio.webm')
    expect(audioFilename('')).toBe('audio.m4a')
  })
})

describe('transcribe', () => {
  it('POSTs the audio as the multipart field `file` with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(json({ text: '  why is the sky blue ' }))
    const text = await transcribe({ baseUrl: BASE, token: 'tok', audio: mp4 })

    expect(text).toBe('why is the sky blue')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/voice/transcribe`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' })
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    const file = form.get('file') as File
    expect(file.name).toBe('audio.m4a')
    expect(file.type).toBe('audio/mp4')
    expect(await file.text()).toBe('voice')
  })

  it('names webm audio audio.webm', async () => {
    fetchMock.mockResolvedValueOnce(json({ text: 'hi' }))
    await transcribe({
      baseUrl: BASE,
      token: 'tok',
      audio: new Blob(['v'], { type: 'audio/webm' })
    })
    const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData
    expect((form.get('file') as File).name).toBe('audio.webm')
  })

  it('gives empty text for a 200 without a transcript', async () => {
    fetchMock.mockResolvedValueOnce(json({}))
    expect(await transcribe({ baseUrl: BASE, token: 't', audio: mp4 })).toBe('')
    fetchMock.mockResolvedValueOnce(new Response('not json'))
    expect(await transcribe({ baseUrl: BASE, token: 't', audio: mp4 })).toBe('')
  })

  it('413 says the recording was too long', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Audio too large', { status: 413 })
    )
    const error = await failure(
      transcribe({ baseUrl: BASE, token: 't', audio: mp4 })
    )
    expect(error.status).toBe(413)
    expect(error.message).toBe(TOO_LONG_MESSAGE)
    expect(TOO_LONG_MESSAGE).toBe('Recording too long')
  })

  it('503 (and 404, voice turned off) say voice is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('STT unavailable', { status: 503 })
    )
    const down = await failure(
      transcribe({ baseUrl: BASE, token: 't', audio: mp4 })
    )
    expect(down.status).toBe(503)
    expect(down.message).toBe(UNAVAILABLE_MESSAGE)
    expect(UNAVAILABLE_MESSAGE).toBe('Voice is unavailable right now')

    fetchMock.mockResolvedValueOnce(new Response('Not found', { status: 404 }))
    const off = await failure(
      transcribe({ baseUrl: BASE, token: 't', audio: mp4 })
    )
    expect(off.message).toBe(UNAVAILABLE_MESSAGE)
  })

  it('any other error gives its own message', async () => {
    fetchMock.mockResolvedValueOnce(new Response('No audio', { status: 400 }))
    const error = await failure(
      transcribe({ baseUrl: BASE, token: 't', audio: mp4 })
    )
    expect(error.status).toBe(400)
    expect(error.message).toBe('No audio')
  })

  it('a lost connection is a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'))
    const error = await failure(
      transcribe({ baseUrl: BASE, token: 't', audio: mp4 })
    )
    expect(error.status).toBe(0)
    expect(error.message).toBe(NETWORK_ERROR_MESSAGE)
  })

  it('a cancelled request rejects with the abort, not a network error', async () => {
    const controller = new AbortController()
    const abort = new DOMException('Aborted', 'AbortError')
    fetchMock.mockImplementationOnce(async () => {
      controller.abort()
      throw abort
    })
    await expect(
      transcribe({
        baseUrl: BASE,
        token: 't',
        audio: mp4,
        signal: controller.signal
      })
    ).rejects.toBe(abort)
    // The request follows the caller's signal.
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(
      true
    )
  })

  describe('a request that never answers', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        )
      })

    it('gives up after 45 s: voice is unavailable', async () => {
      fetchMock.mockImplementationOnce(hang)
      const pending = transcribe({ baseUrl: BASE, token: 't', audio: mp4 })
      const settled = vi.fn()
      pending.catch(settled)
      await vi.advanceTimersByTimeAsync(TRANSCRIBE_TIMEOUT_MS - 1)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      const error = await failure(pending)
      expect(error.message).toBe(UNAVAILABLE_MESSAGE)
      expect(TRANSCRIBE_TIMEOUT_MS).toBe(45_000)
    })

    it('also when the answer starts but its body never finishes', async () => {
      fetchMock.mockImplementationOnce(
        async (_url: string, init: RequestInit) => ({
          ok: true,
          status: 200,
          json: () => hang(_url, init)
        })
      )
      const pending = transcribe({ baseUrl: BASE, token: 't', audio: mp4 })
      const settled = vi.fn()
      pending.catch(settled)
      await vi.advanceTimersByTimeAsync(TRANSCRIBE_TIMEOUT_MS - 1)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect((await failure(pending)).message).toBe(UNAVAILABLE_MESSAGE)
    })

    it('an answer in time clears the timer', async () => {
      fetchMock.mockResolvedValueOnce(json({ text: 'hi' }))
      expect(await transcribe({ baseUrl: BASE, token: 't', audio: mp4 })).toBe(
        'hi'
      )
      expect(vi.getTimerCount()).toBe(0)
    })

    it("a caller's abort still rejects with the abort, not unavailable", async () => {
      fetchMock.mockImplementationOnce(hang)
      const controller = new AbortController()
      const pending = transcribe({
        baseUrl: BASE,
        token: 't',
        audio: mp4,
        signal: controller.signal
      })
      controller.abort()
      await expect(pending).rejects.toHaveProperty('name', 'AbortError')
      expect(vi.getTimerCount()).toBe(0)
    })
  })
})
