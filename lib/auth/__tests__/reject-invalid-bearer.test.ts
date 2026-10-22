import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Real isBearerAuthorization; only the user resolution is stubbed.
vi.mock('@/lib/auth/get-current-user', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/auth/get-current-user')>()),
  getCurrentUser: vi.fn()
}))

import type { User } from '@supabase/supabase-js'

import { getCurrentUser } from '@/lib/auth/get-current-user'

import { rejectInvalidBearer } from '../reject-invalid-bearer'

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/chats', { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ENABLE_AUTH', 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('rejectInvalidBearer', () => {
  it('leaves a request without a bearer to the cookie path', async () => {
    expect(await rejectInvalidBearer(request())).toBeNull()
    expect(
      await rejectInvalidBearer(request({ authorization: 'Basic abc' }))
    ).toBeNull()
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('ignores the bearer in anonymous mode', async () => {
    vi.stubEnv('ENABLE_AUTH', 'false')

    const res = await rejectInvalidBearer(
      request({ authorization: 'Bearer bad' })
    )

    expect(res).toBeNull()
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('answers 401 JSON for a bearer that resolves to no user', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const res = await rejectInvalidBearer(
      request({ authorization: 'Bearer bad' })
    )

    expect(getCurrentUser).toHaveBeenCalledTimes(1)
    expect(res?.status).toBe(401)
    expect(await res?.json()).toEqual({ error: 'Unauthorized' })
  })

  it('answers 401 for a token-less "Bearer" header', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const res = await rejectInvalidBearer(request({ authorization: 'Bearer' }))

    expect(res?.status).toBe(401)
  })

  it('returns null for a valid bearer', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user-1' } as User)

    const res = await rejectInvalidBearer(
      request({ authorization: 'Bearer good' })
    )

    expect(res).toBeNull()
    expect(getCurrentUser).toHaveBeenCalledTimes(1)
  })
})
