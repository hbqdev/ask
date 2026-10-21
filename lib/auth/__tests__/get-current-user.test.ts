import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getUser, headersMock } = vi.hoisted(() => ({
  getUser: vi.fn(),
  headersMock: vi.fn()
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } }))
}))

vi.mock('next/headers', () => ({
  headers: headersMock
}))

import { bearerToken, getCurrentUser } from '../get-current-user'

const withHeaders = (init: Record<string, string> = {}) =>
  headersMock.mockResolvedValue(new Headers(init))

beforeEach(() => {
  getUser.mockReset()
  headersMock.mockReset()
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test'
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'test-publishable-key'
})

afterEach(() => {
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
})

describe('bearerToken', () => {
  it('parses "Bearer abc" and "bearer  abc" to "abc"; returns null for null, "", "Basic abc", "Bearer "', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer  abc')).toBe('abc')
    expect(bearerToken(null)).toBeNull()
    expect(bearerToken('')).toBeNull()
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken('Bearer ')).toBeNull()
  })
})

describe('getCurrentUser', () => {
  it('uses the cookie session when no Authorization header is present', async () => {
    withHeaders()
    getUser.mockResolvedValue({ data: { user: { id: 'u-cookie' } } })

    const user = await getCurrentUser()

    expect(getUser).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledWith()
    expect(user).toEqual({ id: 'u-cookie' })
  })

  it('validates a bearer token with supabase.auth.getUser(jwt)', async () => {
    withHeaders({ authorization: 'Bearer jwt-1' })
    getUser.mockResolvedValue({ data: { user: { id: 'u-bearer' } } })

    const user = await getCurrentUser()

    expect(getUser).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledWith('jwt-1')
    expect(user).toEqual({ id: 'u-bearer' })
  })

  it('returns null for an invalid bearer token without falling back to cookies', async () => {
    withHeaders({ authorization: 'Bearer bad' })
    getUser.mockResolvedValue({ data: { user: null }, error: {} })

    const user = await getCurrentUser()

    expect(user).toBeNull()
    expect(getUser).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledWith('bad')
  })

  it('returns null when Supabase is not configured', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    withHeaders({ authorization: 'Bearer jwt-1' })

    const user = await getCurrentUser()

    expect(user).toBeNull()
    expect(getUser).not.toHaveBeenCalled()
  })

  it('falls back to the cookie session when headers() is unavailable', async () => {
    headersMock.mockImplementation(() => {
      throw new Error('outside request scope')
    })
    getUser.mockResolvedValue({ data: { user: { id: 'u-cookie' } } })

    const user = await getCurrentUser()

    expect(getUser).toHaveBeenCalledTimes(1)
    expect(getUser).toHaveBeenCalledWith()
    expect(user).toEqual({ id: 'u-cookie' })
  })
})
