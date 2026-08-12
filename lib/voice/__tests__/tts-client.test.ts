import { afterEach, describe, expect, it, vi } from 'vitest'

import { synthesizeSpeech } from '../tts-client'

afterEach(() => vi.unstubAllGlobals())

describe('synthesizeSpeech', () => {
  it('POSTs text+voice to the TTS service and returns the audio stream', async () => {
    process.env.TTS_SERVICE_URL = 'http://tts:8080'
    const body = new ReadableStream()
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body })
    vi.stubGlobal('fetch', fetchMock)

    const out = await synthesizeSpeech('hello', { voice: 'af_heart' })
    expect(out).toBe(body)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://tts:8080/speak')
    expect(JSON.parse(init.body)).toEqual({ text: 'hello', voice: 'af_heart' })
  })

  it('throws when TTS_SERVICE_URL is unset', async () => {
    delete process.env.TTS_SERVICE_URL
    await expect(synthesizeSpeech('hi')).rejects.toThrow(/not configured/i)
  })

  it('throws on a non-ok response', async () => {
    process.env.TTS_SERVICE_URL = 'http://tts:8080'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503 })
    )
    await expect(synthesizeSpeech('hi')).rejects.toThrow(/503/)
  })
})
