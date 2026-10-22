// @vitest-environment node
//
// Runs in the node environment (not the project-default jsdom): building a
// multipart Request/parsing it with req.formData() needs undici's Blob/File
// and FormData in the same realm. Under jsdom, Blob/FormData come from jsdom
// while Request comes from undici, so undici rejects the foreign Blob when it
// serializes the body — the route code is fine, the realm mix is not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/voice/config', () => ({ isVoiceEnabled: vi.fn() }))
vi.mock('@/lib/auth/get-current-user', () => ({ getCurrentUserId: vi.fn() }))
vi.mock('@/lib/voice/stt-client', () => ({ transcribeAudio: vi.fn() }))

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { transcribeAudio } from '@/lib/voice/stt-client'

import { OPTIONS, POST } from '../transcribe/route'

// A browser's fetch(FormData) always declares content-length; a Request built
// from FormData in a test does not, so serialize it and declare the real size.
const multipart = async (
  form: FormData,
  headers: Record<string, string> = {}
) => {
  const encoded = new Response(form)
  const body = await encoded.arrayBuffer()
  return new Request('http://t/api/voice/transcribe', {
    method: 'POST',
    headers: {
      'content-type': encoded.headers.get('content-type')!,
      'content-length': String(body.byteLength),
      ...headers
    },
    body
  })
}

const withFile = () => {
  const form = new FormData()
  form.append('file', new Blob(['x'], { type: 'audio/webm' }), 'a.webm')
  return multipart(form)
}

beforeEach(() => vi.clearAllMocks())

describe('POST /api/voice/transcribe', () => {
  it('404 when voice disabled', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(false)
    expect((await POST(await withFile())).status).toBe(404)
  })

  it('401 when no user', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    expect((await POST(await withFile())).status).toBe(401)
  })

  it('400 when no file', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    expect((await POST(await multipart(new FormData()))).status).toBe(400)
  })

  it('413 when audio too large', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    const form = new FormData()
    // One byte over the 25MB cap enforced by the route.
    const oversized = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], {
      type: 'audio/webm'
    })
    form.append('file', oversized, 'big.webm')
    expect((await POST(await multipart(form))).status).toBe(413)
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('413 before reading the body when the declared length is over the cap', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    const req = new Request('http://t/api/voice/transcribe', {
      method: 'POST',
      headers: {
        Origin: 'capacitor://localhost',
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(25 * 1024 * 1024 + 64 * 1024 + 1)
      },
      body: 'tiny'
    })
    const formData = vi.spyOn(req, 'formData')
    const res = await POST(req)
    expect(res.status).toBe(413)
    expect(formData).not.toHaveBeenCalled()
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'capacitor://localhost'
    )
  })

  // A proxy (or HTTP/2 hop) may forward the body chunked, without a length:
  // it is read with a cap instead of trusted or buffered whole.
  const undeclared = (chunks: Uint8Array[], contentType: string) => {
    let read = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (read < chunks.length) controller.enqueue(chunks[read++])
        else controller.close()
      }
    })
    const req = new Request('http://t/api/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      duplex: 'half'
    } as RequestInit)
    expect(req.headers.get('content-length')).toBeNull()
    return { req, chunksRead: () => read }
  }

  it('413 when a body without a declared length runs over the cap, reading no further', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    const mb = new Uint8Array(1024 * 1024)
    const { req, chunksRead } = undeclared(
      Array.from({ length: 40 }, () => mb),
      'multipart/form-data; boundary=x'
    )
    const formData = vi.spyOn(req, 'formData')
    expect((await POST(req)).status).toBe(413)
    expect(formData).not.toHaveBeenCalled()
    expect(chunksRead()).toBeLessThanOrEqual(27)
    expect(transcribeAudio).not.toHaveBeenCalled()
  })

  it('transcribes a body without a declared length that is within the cap', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    vi.mocked(transcribeAudio).mockResolvedValue('hello')
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'audio/webm' }), 'a.webm')
    const encoded = new Response(form)
    const bytes = new Uint8Array(await encoded.arrayBuffer())
    const { req } = undeclared(
      [bytes.subarray(0, 10), bytes.subarray(10)],
      encoded.headers.get('content-type')!
    )
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'hello' })
  })

  it('400 for a body that is not a form, declared length or not', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    const declared = new Request('http://t/api/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-length': '5' },
      body: 'hello'
    })
    expect((await POST(declared)).status).toBe(400)
    const { req } = undeclared(
      [new TextEncoder().encode('hello')],
      'multipart/form-data; boundary=x'
    )
    expect((await POST(req)).status).toBe(400)
  })

  it('500 (not a thrown error) when the session lookup fails', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'audio/webm' }), 'a.webm')
    const res = await POST(
      await multipart(form, { Origin: 'capacitor://localhost' })
    )
    expect(res.status).toBe(500)
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'capacitor://localhost'
    )
    warn.mockRestore()
  })

  it('200 { text } on success', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    vi.mocked(transcribeAudio).mockResolvedValue('hello there')
    const res = await POST(await withFile())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'hello there' })
  })

  it('503 when STT throws', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    vi.mocked(transcribeAudio).mockRejectedValue(new Error('down'))
    expect((await POST(await withFile())).status).toBe(503)
  })
})

describe('/api/voice/transcribe CORS for the app origin', () => {
  const APP = 'capacitor://localhost'

  beforeEach(() => vi.stubEnv('APP_CORS_ORIGINS', ''))
  afterEach(() => vi.unstubAllEnvs())

  const preflight = (origin: string) =>
    new Request('http://t/api/voice/transcribe', {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' }
    })

  const fromApp = () => {
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'audio/mp4' }), 'a.m4a')
    return multipart(form, { Origin: APP })
  }

  it('answers an allowed-origin preflight with 204 and CORS headers', async () => {
    const res = await OPTIONS(preflight(APP))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
  })

  it('answers a foreign-origin preflight with 204 and no CORS headers', async () => {
    const res = await OPTIONS(preflight('https://evil.example'))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('adds CORS headers to a transcript returned to the app', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('u1')
    vi.mocked(transcribeAudio).mockResolvedValue('hi')
    const res = await POST(await fromApp())
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ text: 'hi' })
  })

  it('adds CORS headers to an error returned to the app', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    const res = await POST(await fromApp())
    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe(APP)
  })
})
