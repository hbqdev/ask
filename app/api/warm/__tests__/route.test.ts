import { beforeEach, describe, expect, it, vi } from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/auth/get-current-user')

import { getCurrentUserId } from '@/lib/auth/get-current-user'

import { POST } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getCurrentUserId).mockResolvedValue('u1')
  process.env.CLASSIFIER_OLLAMA_BASE_URL = 'http://classifier:11434'
})

describe('POST /api/warm', () => {
  it('returns 401 without firing any ping when there is no authenticated user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined as any)
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response())

    const res = await POST()

    expect(res.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('fires the warm pings for an authenticated user and waits for them to be issued', async () => {
    // An unawaited fetch in a route handler is torn down when the response
    // returns — the pings silently never reach the GPU. Prove they complete.
    let completed = false
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      completed = true
      return new Response()
    })

    const res = await POST()

    expect(res.status).toBe(204)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://classifier:11434/api/generate',
      expect.objectContaining({ method: 'POST' })
    )
    expect(completed).toBe(true)
    fetchSpy.mockRestore()
  })

  it('throttles a rapid second call so keystrokes cannot spam the GPUs', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response())

    // The previous test already warmed within the throttle window.
    const res = await POST()

    expect(res.status).toBe(204)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
