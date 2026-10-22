import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider, useApi } from '@/core/api/ApiProvider'
import { SIGNED_OUT_MESSAGE } from '@/core/api/client'
import {
  SIGNED_OUT_NOTICE,
  useAuth,
  type Auth,
  type AuthStatus,
  type RefreshResult
} from '@/core/auth/AuthProvider'

vi.mock('@/core/auth/AuthProvider', async importOriginal => ({
  ...(await importOriginal<typeof import('@/core/auth/AuthProvider')>()),
  useAuth: vi.fn()
}))

const getAccessToken = vi.fn(async (): Promise<string | null> => 'fake-token')
const refreshAccessToken = vi.fn<() => Promise<RefreshResult>>()
const signOut = vi.fn(async () => {})

function authAs(status: AuthStatus = 'signedIn', userId = 'user-1') {
  vi.mocked(useAuth).mockReturnValue({
    status,
    session: { user: { id: userId } },
    getAccessToken,
    refreshAccessToken,
    signOut
  } as unknown as Auth)
}

/** A refresh that settles when the test says so. */
function pendingRefresh() {
  let settle: (result: RefreshResult) => void = () => {}
  refreshAccessToken.mockImplementation(
    () =>
      new Promise(resolve => {
        settle = resolve
      })
  )
  return (result: RefreshResult) => act(async () => settle(result))
}

const status = (code: number) => new Response(null, { status: code })

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ApiProvider baseUrl="https://ask.test.invalid">{children}</ApiProvider>
  )
}

describe('ApiProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAccessToken.mockResolvedValue('fake-token')
    authAs()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('useApi throws outside the provider', () => {
    // React logs the thrown render error; keep the output clean.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useApi())).toThrow(
      'useApi must be used inside ApiProvider'
    )
    consoleError.mockRestore()
  })

  it('gives a client on the base URL and the auth token getter', async () => {
    const { result } = renderHook(() => useApi(), { wrapper })

    expect(result.current.baseUrl).toBe('https://ask.test.invalid')
    expect(result.current.client.url('/x')).toBe('https://ask.test.invalid/x')
    await expect(result.current.getToken()).resolves.toBe('fake-token')
  })

  it('keeps one client across renders', () => {
    const { result, rerender } = renderHook(() => useApi(), { wrapper })
    const first = result.current.client
    rerender()
    expect(result.current.client).toBe(first)
  })

  it('keeps one handler across renders', () => {
    const { result, rerender } = renderHook(() => useApi(), { wrapper })
    const first = result.current.handleUnauthorized
    rerender()
    expect(result.current.handleUnauthorized).toBe(first)
  })
})

describe('ApiProvider: handleUnauthorized', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAccessToken.mockResolvedValue('fake-token')
    authAs()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parallel 401s refresh once and sign out once', async () => {
    // The resume burst: Library, its count, models and touch together.
    const fetchMock = vi.fn<typeof fetch>(async () => status(401))
    vi.stubGlobal('fetch', fetchMock)
    const settle = pendingRefresh()
    const { result } = renderHook(() => useApi(), { wrapper })
    const { client } = result.current

    const calls = [
      '/api/chats',
      '/api/chats/count',
      '/api/models',
      '/api/chats/c1/touch'
    ].map(path => client.fetch(path))
    await act(async () => {})
    await settle({ status: 'failed' })

    const responses = await Promise.all(calls)
    expect(responses.map(r => r.status)).toEqual([401, 401, 401, 401])
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(signOut).toHaveBeenCalledExactlyOnceWith({
      notice: SIGNED_OUT_NOTICE
    })
    // Nothing was resent: the session is gone.
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('parallel 401s share one refresh, then each resends once', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
      new Headers(init?.headers).get('Authorization') === 'Bearer fake-fresh'
        ? status(200)
        : status(401)
    )
    vi.stubGlobal('fetch', fetchMock)
    const settle = pendingRefresh()
    const { result } = renderHook(() => useApi(), { wrapper })

    const calls = ['/api/chats', '/api/models'].map(path =>
      result.current.client.fetch(path)
    )
    await act(async () => {})
    getAccessToken.mockResolvedValue('fake-fresh')
    await settle({ status: 'refreshed', token: 'fake-fresh' })

    const responses = await Promise.all(calls)
    expect(responses.map(r => r.status)).toEqual([200, 200])
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(signOut).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('a 401 while offline keeps the session', async () => {
    refreshAccessToken.mockResolvedValue({ status: 'offline' })
    const { result } = renderHook(() => useApi(), { wrapper })

    let answer: string | undefined
    await act(async () => {
      answer = await result.current.handleUnauthorized('first')
    })

    expect(answer).toBe('stop')
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('a refreshed session says retry', async () => {
    refreshAccessToken.mockResolvedValue({
      status: 'refreshed',
      token: 'fake-fresh'
    })
    const { result } = renderHook(() => useApi(), { wrapper })
    await expect(result.current.handleUnauthorized('first')).resolves.toBe(
      'retry'
    )
    expect(signOut).not.toHaveBeenCalled()
  })

  it('a 401 again after a successful refresh stops and keeps the session (P6-R14)', async () => {
    const { result } = renderHook(() => useApi(), { wrapper })
    const { handleUnauthorized } = result.current

    let answers: string[] = []
    await act(async () => {
      answers = await Promise.all([
        handleUnauthorized('afterRetry'),
        handleUnauthorized('afterRetry')
      ])
    })

    expect(answers).toEqual(['stop', 'stop'])
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('a refreshed token the server still refuses keeps the session, and the 401 reaches the caller', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => status(401))
    vi.stubGlobal('fetch', fetchMock)
    refreshAccessToken.mockImplementation(async () => {
      getAccessToken.mockResolvedValue('fake-fresh')
      return { status: 'refreshed', token: 'fake-fresh' }
    })
    const { result } = renderHook(() => useApi(), { wrapper })

    let caught: unknown
    await act(async () => {
      caught = await result.current.client.json('/api/chats').catch(e => e)
    })

    expect(caught).toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(signOut).not.toHaveBeenCalled()
  })

  it('after its provider is gone, a 401 does nothing', async () => {
    refreshAccessToken.mockResolvedValue({ status: 'failed' })
    const { result, unmount } = renderHook(() => useApi(), { wrapper })
    const { handleUnauthorized } = result.current
    unmount()

    await expect(handleUnauthorized('first')).resolves.toBe('stop')
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('a refresh that lands after its provider is gone never resends', async () => {
    const settle = pendingRefresh()
    const { result, unmount } = renderHook(() => useApi(), { wrapper })
    let answer: Promise<string> | undefined
    act(() => {
      answer = result.current.handleUnauthorized('first')
    })
    unmount()
    await settle({ status: 'refreshed', token: 'fake-fresh' })

    await expect(answer).resolves.toBe('stop')
  })

  it('a refused refresh that lands after the provider is gone still signs out', async () => {
    // supabase-js's own SIGNED_OUT may unmount the provider mid-refresh.
    const settle = pendingRefresh()
    const { result, unmount } = renderHook(() => useApi(), { wrapper })
    let answer: Promise<string> | undefined
    act(() => {
      answer = result.current.handleUnauthorized('first')
    })
    unmount()
    await settle({ status: 'failed' })

    await expect(answer).resolves.toBe('stop')
    expect(signOut).toHaveBeenCalledExactlyOnceWith({
      notice: SIGNED_OUT_NOTICE
    })
  })

  it('another account in the same provider: no refresh, no resend', async () => {
    const { result, rerender } = renderHook(() => useApi(), { wrapper })
    const { handleUnauthorized } = result.current
    authAs('signedIn', 'user-2')
    rerender()

    await expect(handleUnauthorized('first')).resolves.toBe('stop')
    expect(refreshAccessToken).not.toHaveBeenCalled()
  })

  it('the account changing during the refresh: no resend', async () => {
    const settle = pendingRefresh()
    const { result, rerender } = renderHook(() => useApi(), { wrapper })
    let answer: Promise<string> | undefined
    act(() => {
      answer = result.current.handleUnauthorized('first')
    })
    authAs('signedIn', 'user-2')
    rerender()
    await settle({ status: 'refreshed', token: 'fake-b' })

    await expect(answer).resolves.toBe('stop')
  })

  it('once signed out, a late 401 neither refreshes nor signs out again', async () => {
    refreshAccessToken.mockResolvedValue({ status: 'failed' })
    const { result } = renderHook(() => useApi(), { wrapper })

    await act(async () => {
      await result.current.handleUnauthorized('first')
    })
    let late: string | undefined
    await act(async () => {
      late = await result.current.handleUnauthorized('first')
    })

    expect(late).toBe('stop')
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('the next sign-in allows another sign-out', async () => {
    refreshAccessToken.mockResolvedValue({ status: 'failed' })
    const { result, rerender } = renderHook(() => useApi(), { wrapper })
    await act(async () => {
      await result.current.handleUnauthorized('first')
    })

    authAs('signedOut')
    rerender()
    authAs('signedIn')
    rerender()
    await act(async () => {
      await result.current.handleUnauthorized('first')
    })

    expect(refreshAccessToken).toHaveBeenCalledTimes(2)
    expect(signOut).toHaveBeenCalledTimes(2)
  })

  it('a failed sign-out still stops', async () => {
    refreshAccessToken.mockResolvedValue({ status: 'failed' })
    signOut.mockRejectedValueOnce(new Error('storage failed'))
    const { result } = renderHook(() => useApi(), { wrapper })
    let answer: string | undefined
    await act(async () => {
      answer = await result.current.handleUnauthorized('first')
    })
    expect(answer).toBe('stop')
  })

  it('a refresh that throws keeps the session', async () => {
    refreshAccessToken.mockRejectedValue(new Error('unexpected'))
    const { result } = renderHook(() => useApi(), { wrapper })
    let answer: string | undefined
    await act(async () => {
      answer = await result.current.handleUnauthorized('first')
    })
    expect(answer).toBe('stop')
    expect(signOut).not.toHaveBeenCalled()
  })

  it('the client’s own 401 (no token, nothing sent) is not the server’s', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    getAccessToken.mockResolvedValue(null)
    const { result } = renderHook(() => useApi(), { wrapper })

    await expect(result.current.client.fetch('/api/chats')).rejects.toThrow(
      SIGNED_OUT_MESSAGE
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
  })
})
