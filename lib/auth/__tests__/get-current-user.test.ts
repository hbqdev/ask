import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  cookieGetUser,
  bearerGetUser,
  ssrCreateClient,
  jsCreateClient,
  headersMock
} = vi.hoisted(() => {
  const cookieGetUser = vi.fn()
  const bearerGetUser = vi.fn()
  return {
    cookieGetUser,
    bearerGetUser,
    ssrCreateClient: vi.fn(async () => ({ auth: { getUser: cookieGetUser } })),
    jsCreateClient: vi.fn(() => ({ auth: { getUser: bearerGetUser } })),
    headersMock: vi.fn()
  }
})

// Cookie-bound SSR client: the cookie-session path only.
vi.mock('@/lib/supabase/server', () => ({
  createClient: ssrCreateClient
}))

// Cookie-less client: the bearer path only.
vi.mock('@supabase/supabase-js', () => ({
  createClient: jsCreateClient
}))

vi.mock('next/headers', () => ({
  headers: headersMock
}))

import {
  bearerToken,
  getCurrentUser,
  isBearerAuthorization
} from '../get-current-user'

const withHeaders = (init: Record<string, string> = {}) =>
  headersMock.mockResolvedValue(new Headers(init))

const expectCookiePath = (userId: string, user: unknown) => {
  expect(ssrCreateClient).toHaveBeenCalledTimes(1)
  expect(cookieGetUser).toHaveBeenCalledTimes(1)
  expect(cookieGetUser).toHaveBeenCalledWith()
  expect(jsCreateClient).not.toHaveBeenCalled()
  expect(bearerGetUser).not.toHaveBeenCalled()
  expect(user).toEqual({ id: userId })
}

const expectNoAuthCall = () => {
  expect(ssrCreateClient).not.toHaveBeenCalled()
  expect(cookieGetUser).not.toHaveBeenCalled()
  expect(jsCreateClient).not.toHaveBeenCalled()
  expect(bearerGetUser).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.clearAllMocks()
  headersMock.mockReset()
  cookieGetUser.mockReset()
  bearerGetUser.mockReset()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://supabase.test')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'test-publishable-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
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

describe('isBearerAuthorization', () => {
  it.each([
    ['Bearer x', true],
    ['bearer', true],
    ['Bearer', true],
    ['Basic x', false],
    ['Bearerx', false],
    [null, false]
  ])('%j uses the Bearer scheme: %s', (header, expected) => {
    expect(isBearerAuthorization(header)).toBe(expected)
  })
})

describe('getCurrentUser', () => {
  it('uses the cookie session when no Authorization header is present', async () => {
    withHeaders()
    cookieGetUser.mockResolvedValue({ data: { user: { id: 'u-cookie' } } })

    expectCookiePath('u-cookie', await getCurrentUser())
  })

  it('validates a bearer token with supabase.auth.getUser(jwt)', async () => {
    withHeaders({ authorization: 'Bearer jwt-1' })
    bearerGetUser.mockResolvedValue({ data: { user: { id: 'u-bearer' } } })

    const user = await getCurrentUser()

    expect(bearerGetUser).toHaveBeenCalledTimes(1)
    expect(bearerGetUser).toHaveBeenCalledWith('jwt-1')
    expect(user).toEqual({ id: 'u-bearer' })
  })

  it('validates the bearer with a cookie-less client, never the SSR cookie client', async () => {
    withHeaders({ authorization: 'Bearer jwt-1' })
    bearerGetUser.mockResolvedValue({ data: { user: { id: 'u-bearer' } } })

    await getCurrentUser()

    expect(jsCreateClient).toHaveBeenCalledTimes(1)
    expect(jsCreateClient).toHaveBeenCalledWith(
      'http://supabase.test',
      'test-publishable-key',
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    )
    expect(ssrCreateClient).not.toHaveBeenCalled()
    expect(cookieGetUser).not.toHaveBeenCalled()
  })

  it('returns null for an invalid bearer token without falling back to cookies', async () => {
    withHeaders({ authorization: 'Bearer bad' })
    bearerGetUser.mockResolvedValue({ data: { user: null }, error: {} })

    const user = await getCurrentUser()

    expect(user).toBeNull()
    expect(bearerGetUser).toHaveBeenCalledTimes(1)
    expect(bearerGetUser).toHaveBeenCalledWith('bad')
    expect(ssrCreateClient).not.toHaveBeenCalled()
    expect(cookieGetUser).not.toHaveBeenCalled()
  })

  it('returns null for a token-less "Bearer " header without calling getUser', async () => {
    withHeaders({ authorization: 'Bearer ' })

    expect(await getCurrentUser()).toBeNull()
    expectNoAuthCall()
  })

  it('returns null for a malformed "Bearer a b" header without calling getUser', async () => {
    withHeaders({ authorization: 'Bearer a b' })

    expect(await getCurrentUser()).toBeNull()
    expectNoAuthCall()
  })

  it('keeps the cookie session for a non-Bearer scheme ("Basic abc")', async () => {
    withHeaders({ authorization: 'Basic abc' })
    cookieGetUser.mockResolvedValue({ data: { user: { id: 'u-cookie' } } })

    expectCookiePath('u-cookie', await getCurrentUser())
  })

  it('returns null when Supabase is not configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '')
    withHeaders({ authorization: 'Bearer jwt-1' })

    expect(await getCurrentUser()).toBeNull()
    expectNoAuthCall()
  })

  it('falls back to the cookie session when headers() is unavailable', async () => {
    headersMock.mockImplementation(() => {
      throw new Error('outside request scope')
    })
    cookieGetUser.mockResolvedValue({ data: { user: { id: 'u-cookie' } } })

    expectCookiePath('u-cookie', await getCurrentUser())
  })

  it('falls back to the cookie session when headers() rejects', async () => {
    headersMock.mockRejectedValue(new Error('outside request scope'))
    cookieGetUser.mockResolvedValue({ data: { user: { id: 'u-cookie' } } })

    expectCookiePath('u-cookie', await getCurrentUser())
  })
})
