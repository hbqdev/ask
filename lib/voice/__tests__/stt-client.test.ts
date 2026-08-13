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
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
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
})
