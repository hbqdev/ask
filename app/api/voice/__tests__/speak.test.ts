import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/get-current-user', () => ({
  getCurrentUserId: vi.fn()
}))
vi.mock('@/lib/voice/tts-client', () => ({
  synthesizeSpeech: vi.fn()
}))

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { synthesizeSpeech } from '@/lib/voice/tts-client'

import { POST } from '../speak/route'

const req = (body: unknown) =>
  new Request('http://x/api/voice/speak', {
    method: 'POST',
    body: JSON.stringify(body)
  })

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.VOICE_ENABLED
})

describe('POST /api/voice/speak', () => {
  it('404s when voice is disabled', async () => {
    process.env.VOICE_ENABLED = 'false'
    const res = await POST(req({ text: 'hi' }))
    expect(res.status).toBe(404)
  })

  it('401s when unauthenticated', async () => {
    process.env.VOICE_ENABLED = 'true'
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    const res = await POST(req({ text: 'hi' }))
    expect(res.status).toBe(401)
  })

  it('streams audio for an authed request', async () => {
    process.env.VOICE_ENABLED = 'true'
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    vi.mocked(synthesizeSpeech).mockResolvedValue(new ReadableStream())
    const res = await POST(req({ text: 'hello world' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toMatch(/audio/)
  })

  it('400s on missing/oversized text', async () => {
    process.env.VOICE_ENABLED = 'true'
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    expect((await POST(req({}))).status).toBe(400)
    expect((await POST(req({ text: 'x'.repeat(5001) }))).status).toBe(400)
  })
})
