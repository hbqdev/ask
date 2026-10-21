import { act, renderHook, waitFor } from '@testing-library/react'
import {
  AuthApiError,
  AuthRetryableFetchError,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient
} from '@supabase/supabase-js'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from '@/core/auth/AuthProvider'

// Fake values only: no real tokens or accounts.
const session = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  user: { id: 'user-1', email: 'user@example.test' }
} as unknown as Session

type Listener = (event: AuthChangeEvent, session: Session | null) => void

function fakeClient(initial: Session | null = null) {
  let listener: Listener = () => {}
  const unsubscribe = vi.fn()
  const auth = {
    getSession: vi
      .fn()
      .mockResolvedValue({ data: { session: initial }, error: null }),
    onAuthStateChange: vi.fn((cb: Listener) => {
      listener = cb
      return { data: { subscription: { unsubscribe } } }
    }),
    signInWithPassword: vi.fn(),
    signOut: vi.fn().mockResolvedValue({ error: null })
  }
  return {
    auth,
    unsubscribe,
    client: { auth } as unknown as SupabaseClient,
    emit: (event: AuthChangeEvent, next: Session | null) =>
      act(() => listener(event, next))
  }
}

function renderAuth(client: SupabaseClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider client={client}>{children}</AuthProvider>
  )
  return renderHook(() => useAuth(), { wrapper })
}

async function signedOutAuth() {
  const fake = fakeClient(null)
  const hook = renderAuth(fake.client)
  await waitFor(() => expect(hook.result.current.status).toBe('signedOut'))
  return { ...fake, ...hook }
}

describe('AuthProvider', () => {
  it('restores a persisted session on start', async () => {
    let resolve: (value: unknown) => void = () => {}
    const fake = fakeClient()
    fake.auth.getSession.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const { result } = renderAuth(fake.client)
    expect(result.current.status).toBe('loading')
    expect(result.current.session).toBeNull()

    await act(async () => {
      resolve({ data: { session }, error: null })
    })
    expect(result.current.status).toBe('signedIn')
    expect(result.current.session).toBe(session)
    expect(result.current.error).toBeNull()
  })

  it('starts signed out when nothing is persisted', async () => {
    const { result } = await signedOutAuth()
    expect(result.current.session).toBeNull()
  })

  it('starts signed out when the persisted session cannot be read', async () => {
    const fake = fakeClient()
    fake.auth.getSession.mockRejectedValue(new Error('storage unavailable'))
    const { result } = renderAuth(fake.client)
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    expect(result.current.session).toBeNull()
  })

  it('signIn success → signedIn', async () => {
    const { auth, result } = await signedOutAuth()
    auth.signInWithPassword.mockResolvedValue({
      data: { session, user: session.user },
      error: null
    })
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.signIn('user@example.test', 'fake-password')
    })
    expect(ok).toBe(true)
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.test',
      password: 'fake-password'
    })
    expect(result.current.status).toBe('signedIn')
    expect(result.current.session).toBe(session)
    expect(result.current.error).toBeNull()
  })

  it('signIn invalid credentials → false + "Invalid email or password"', async () => {
    const { auth, result } = await signedOutAuth()
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError(
        'Invalid login credentials',
        400,
        'invalid_credentials'
      )
    })
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.signIn('user@example.test', 'wrong-password')
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe('Invalid email or password')
    expect(result.current.status).toBe('signedOut')
  })

  it('signIn network error → "Network error. Check your connection."', async () => {
    const { auth, result } = await signedOutAuth()
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0)
    })
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.signIn('user@example.test', 'fake-password')
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe('Network error. Check your connection.')
  })

  it('signIn maps a thrown fetch failure to the network message', async () => {
    const { auth, result } = await signedOutAuth()
    auth.signInWithPassword.mockRejectedValue(new TypeError('Load failed'))
    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.signIn('user@example.test', 'fake-password')
    })
    expect(ok).toBe(false)
    expect(result.current.error).toBe('Network error. Check your connection.')
  })

  it('signIn shows any other Supabase message as is', async () => {
    const { auth, result } = await signedOutAuth()
    auth.signInWithPassword.mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError('Email not confirmed', 400, 'email_not_confirmed')
    })
    await act(async () => {
      await result.current.signIn('user@example.test', 'fake-password')
    })
    expect(result.current.error).toBe('Email not confirmed')
  })

  it('signIn shows a generic message for a non-Error failure', async () => {
    const { auth, result } = await signedOutAuth()
    auth.signInWithPassword.mockRejectedValue('boom')
    await act(async () => {
      await result.current.signIn('user@example.test', 'fake-password')
    })
    expect(result.current.error).toBe('Sign-in failed')
  })

  it('a new signIn clears the previous error', async () => {
    const { auth, result } = await signedOutAuth()
    auth.signInWithPassword.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials')
    })
    await act(async () => {
      await result.current.signIn('user@example.test', 'wrong-password')
    })
    expect(result.current.error).toBe('Invalid email or password')
    auth.signInWithPassword.mockResolvedValueOnce({
      data: { session, user: session.user },
      error: null
    })
    await act(async () => {
      await result.current.signIn('user@example.test', 'fake-password')
    })
    expect(result.current.error).toBeNull()
  })

  it('signOut → signedOut', async () => {
    const fake = fakeClient(session)
    const { result } = renderAuth(fake.client)
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    await act(async () => {
      await result.current.signOut()
    })
    expect(fake.auth.signOut).toHaveBeenCalled()
    expect(result.current.status).toBe('signedOut')
    expect(result.current.session).toBeNull()
  })

  it('getAccessToken returns the session token or null', async () => {
    const fake = fakeClient(session)
    const { result } = renderAuth(fake.client)
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    await expect(result.current.getAccessToken()).resolves.toBe(
      'fake-access-token'
    )
    fake.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null
    })
    await expect(result.current.getAccessToken()).resolves.toBeNull()
  })

  it('auth state change to SIGNED_OUT updates status', async () => {
    const fake = fakeClient(session)
    const { result } = renderAuth(fake.client)
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    fake.emit('SIGNED_OUT', null)
    expect(result.current.status).toBe('signedOut')
    expect(result.current.session).toBeNull()
  })

  it('auth state change with a refreshed session keeps it signed in', async () => {
    const { emit, result } = await signedOutAuth()
    const refreshed = { ...session, access_token: 'fake-refreshed-token' }
    emit('TOKEN_REFRESHED', refreshed)
    expect(result.current.status).toBe('signedIn')
    expect(result.current.session).toBe(refreshed)
  })

  it('unsubscribes from auth changes on unmount', async () => {
    const { unsubscribe, unmount } = await signedOutAuth()
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe('useAuth', () => {
  it('throws outside an AuthProvider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useAuth())).toThrow(
      'useAuth must be used inside AuthProvider'
    )
    vi.mocked(console.error).mockRestore()
  })
})
