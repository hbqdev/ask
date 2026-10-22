import { NextRequest } from 'next/server'

import type { User } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Auto-mocked; each test configures the resolved values it needs.
vi.mock('@/lib/actions/chat')
// Real isBearerAuthorization; only the user resolution is stubbed.
vi.mock('@/lib/auth/get-current-user', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/auth/get-current-user')>()),
  getCurrentUser: vi.fn()
}))

import { searchChats } from '@/lib/actions/chat'
import { getCurrentUser } from '@/lib/auth/get-current-user'

import { GET } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(searchChats).mockResolvedValue([])
  vi.stubEnv('ENABLE_AUTH', 'true')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

function getRequest(
  query: string,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(`http://localhost:3000/api/chats/search${query}`, {
    headers
  })
}

describe('GET /api/chats/search', () => {
  it('a request without Authorization keeps the guest {results:[]} 200', async () => {
    const res = await GET(getRequest('?q=trip'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
    expect(searchChats).toHaveBeenCalledWith('trip', false)
    expect(getCurrentUser).not.toHaveBeenCalled()
  })

  it('answers {results:[]} without searching for an empty query', async () => {
    const res = await GET(getRequest('?q=%20%20'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
    expect(searchChats).not.toHaveBeenCalled()
  })

  it('passes semantic=1 through as includeSemantic', async () => {
    await GET(getRequest('?q=trip&semantic=1'))

    expect(searchChats).toHaveBeenCalledWith('trip', true)
  })

  it('answers {results:[]} 500 when the search throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(searchChats).mockRejectedValue(new Error('db down'))

    const res = await GET(getRequest('?q=trip'))

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ results: [] })
    consoleError.mockRestore()
  })

  it('401 for an invalid bearer', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const res = await GET(
      getRequest('?q=trip', { authorization: 'Bearer bad' })
    )

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(searchChats).not.toHaveBeenCalled()
  })

  it('401 for an invalid bearer even with an empty query', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)

    const res = await GET(getRequest('', { authorization: 'Bearer bad' }))

    expect(res.status).toBe(401)
  })

  it('a valid bearer gets the search results as before', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue({ id: 'user-1' } as User)
    const results = [{ id: 'c1', title: 'Trip' }]
    vi.mocked(searchChats).mockResolvedValue(
      results as unknown as Awaited<ReturnType<typeof searchChats>>
    )

    const res = await GET(
      getRequest('?q=trip', { authorization: 'Bearer good' })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results })
    expect(searchChats).toHaveBeenCalledWith('trip', false)
  })
})
