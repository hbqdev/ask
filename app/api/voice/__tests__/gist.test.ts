import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/get-current-user', () => ({ getCurrentUserId: vi.fn() }))
vi.mock('@/lib/voice/config', () => ({ isVoiceEnabled: vi.fn() }))
vi.mock('@/lib/voice/spoken-gist', () => ({ condenseForSpeech: vi.fn() }))

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { condenseForSpeech } from '@/lib/voice/spoken-gist'

import { POST } from '../gist/route'

const req = (body: unknown, raw = false) =>
  new Request('http://x/api/voice/gist', {
    method: 'POST',
    body: raw ? (body as string) : JSON.stringify(body)
  })

describe('POST /api/voice/gist', () => {
  beforeEach(() => {
    vi.mocked(isVoiceEnabled).mockReturnValue(true)
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')
    vi.mocked(condenseForSpeech).mockResolvedValue('Short spoken gist.')
  })

  it('404s when voice is disabled', async () => {
    vi.mocked(isVoiceEnabled).mockReturnValue(false)
    expect((await POST(req({ text: 'hi' }))).status).toBe(404)
  })

  it('401s when unauthenticated', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined)
    expect((await POST(req({ text: 'hi' }))).status).toBe(401)
  })

  it('400s on bad JSON, empty, or oversized text', async () => {
    expect((await POST(req('not json', true))).status).toBe(400)
    expect((await POST(req({ text: '' }))).status).toBe(400)
    expect((await POST(req({ text: 'x'.repeat(20001) }))).status).toBe(400)
  })

  it('200s with the condensed gist', async () => {
    const res = await POST(req({ text: 'A long answer to condense.' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ text: 'Short spoken gist.' })
    expect(condenseForSpeech).toHaveBeenCalledWith('A long answer to condense.')
  })
})
