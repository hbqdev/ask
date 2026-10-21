import { Preferences } from '@capacitor/preferences'
import {
  AuthApiError,
  AuthRetryableFetchError,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient
} from '@supabase/supabase-js'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from '@/core/auth/AuthProvider'
import type { AuthStorage } from '@/core/auth/preferences-storage'
import { AUTH_STORAGE_KEY } from '@/core/auth/supabase'
import { SEARCH_SETTINGS_KEY } from '@/features/compose/search-settings'
import { LIBRARY_CACHE_KEY } from '@/features/library/library-cache'
import { LIBRARY_SORT_KEY } from '@/features/library/library-sort'
import { CUSTOM_INSTRUCTIONS_KEY } from '@/features/settings/custom-instructions'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(),
    remove: vi.fn()
  }
}))

// Fake values only: no real tokens or accounts.
const session = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  expires_at: 4102444800,
  user: { id: 'user-1', email: 'user@example.test' }
} as unknown as Session

const storedSession = JSON.stringify(session)
const allKeys = [
  AUTH_STORAGE_KEY,
  `${AUTH_STORAGE_KEY}-code-verifier`,
  `${AUTH_STORAGE_KEY}-user`
]

type Listener = (event: AuthChangeEvent, session: Session | null) => void

const never = () => new Promise<never>(() => {})

function fakeClient(sessionFromServer: Session | null = null) {
  let listener: Listener = () => {}
  const unsubscribe = vi.fn()
  const auth = {
    getSession: vi
      .fn()
      .mockResolvedValue({ data: { session: sessionFromServer }, error: null }),
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

function renderAuth(client: SupabaseClient, storage?: AuthStorage) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthProvider client={client} storage={storage}>
      {children}
    </AuthProvider>
  )
  return renderHook(() => useAuth(), { wrapper })
}

/** Nothing stored, server has no session: settles signed out. */
async function signedOutAuth() {
  const fake = fakeClient(null)
  const storage = memoryStorage()
  const hook = renderAuth(fake.client, storage)
  await waitFor(() => expect(hook.result.current.status).toBe('signedOut'))
  return { ...fake, ...hook, storage }
}

/** A stored session, server confirms it: settles signed in. */
async function signedInAuth() {
  const fake = fakeClient(session)
  const storage = memoryStorage({ [AUTH_STORAGE_KEY]: storedSession })
  const hook = renderAuth(fake.client, storage)
  await waitFor(() => expect(hook.result.current.status).toBe('signedIn'))
  return { ...fake, ...hook, storage }
}

describe('AuthProvider: session restore', () => {
  it('restores a persisted session on start', async () => {
    const fake = fakeClient()
    let resolve: (value: unknown) => void = () => {}
    fake.auth.getSession.mockReturnValue(
      new Promise(r => {
        resolve = r
      })
    )
    const storage = memoryStorage({ [AUTH_STORAGE_KEY]: storedSession })
    const { result } = renderAuth(fake.client, storage)
    expect(result.current.status).toBe('loading')
    expect(result.current.session).toBeNull()

    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    expect(result.current.session).toEqual(session)
    expect(storage.getItem).toHaveBeenCalledWith(AUTH_STORAGE_KEY)

    const refreshed = { ...session, access_token: 'fake-refreshed-token' }
    await act(async () => {
      resolve({ data: { session: refreshed }, error: null })
    })
    expect(result.current.status).toBe('signedIn')
    expect(result.current.session).toBe(refreshed)
    expect(result.current.error).toBeNull()
  })

  it('restores a stored session immediately without waiting for the network', async () => {
    const fake = fakeClient()
    fake.auth.getSession.mockImplementation(never)
    const storage = memoryStorage({ [AUTH_STORAGE_KEY]: storedSession })
    const { result } = renderAuth(fake.client, storage)
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    expect(result.current.session).toEqual(session)
  })

  it('stays signed in when getSession fails with a retryable error and a session is stored', async () => {
    const fake = fakeClient()
    fake.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0)
    })
    const storage = memoryStorage({ [AUTH_STORAGE_KEY]: storedSession })
    const { result } = renderAuth(fake.client, storage)
    await waitFor(() => expect(fake.auth.getSession).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.status).toBe('signedIn')
    expect(result.current.session).toEqual(session)
  })

  it('stays signed in when getSession throws and a session is stored', async () => {
    const fake = fakeClient()
    fake.auth.getSession.mockRejectedValue(new TypeError('Failed to fetch'))
    const storage = memoryStorage({ [AUTH_STORAGE_KEY]: storedSession })
    const { result } = renderAuth(fake.client, storage)
    await waitFor(() => expect(fake.auth.getSession).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.status).toBe('signedIn')
  })

  it('a null INITIAL_SESSION does not undo a stored session', async () => {
    const fake = fakeClient()
    fake.auth.getSession.mockImplementation(never)
    const storage = memoryStorage({ [AUTH_STORAGE_KEY]: storedSession })
    const { result } = renderAuth(fake.client, storage)
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    fake.emit('INITIAL_SESSION', null)
    expect(result.current.status).toBe('signedIn')
  })

  it('goes to signedOut on SIGNED_OUT', async () => {
    const { emit, result } = await signedInAuth()
    emit('SIGNED_OUT', null)
    expect(result.current.status).toBe('signedOut')
    expect(result.current.session).toBeNull()
  })

  it('a SIGNED_OUT that arrives before the stored read is not undone by it', async () => {
    const fake = fakeClient()
    fake.auth.getSession.mockImplementation(never)
    let release: (value: string) => void = () => {}
    const storage = memoryStorage()
    storage.getItem.mockReturnValue(
      new Promise<string>(r => {
        release = r
      })
    )
    const { result } = renderAuth(fake.client, storage)
    fake.emit('SIGNED_OUT', null)
    await act(async () => {
      release(storedSession)
    })
    expect(result.current.status).toBe('signedOut')
  })

  it('goes to signedOut when nothing is stored and getSession returns no session', async () => {
    const { result } = await signedOutAuth()
    expect(result.current.session).toBeNull()
  })

  it('goes to signedOut when nothing is stored and getSession throws', async () => {
    const fake = fakeClient()
    fake.auth.getSession.mockRejectedValue(new Error('storage unavailable'))
    const { result } = renderAuth(fake.client, memoryStorage())
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
  })

  it('a corrupt stored value falls back to getSession', async () => {
    const fake = fakeClient(null)
    fake.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: new AuthRetryableFetchError('Failed to fetch', 0)
    })
    const storage = memoryStorage({ [AUTH_STORAGE_KEY]: '{not json' })
    const { result } = renderAuth(fake.client, storage)
    await waitFor(() => expect(result.current.status).toBe('signedOut'))

    const recovered = fakeClient(session)
    const second = renderAuth(
      recovered.client,
      memoryStorage({ [AUTH_STORAGE_KEY]: '{not json' })
    )
    await waitFor(() => expect(second.result.current.status).toBe('signedIn'))
    expect(second.result.current.session).toBe(session)
  })

  it('treats a stored value without a refresh token as nothing stored', async () => {
    for (const value of [
      'null',
      JSON.stringify({ access_token: 'fake-access-token' }),
      JSON.stringify({ ...session, refresh_token: '' })
    ]) {
      const fake = fakeClient(null)
      const storage = memoryStorage({ [AUTH_STORAGE_KEY]: value })
      const { result, unmount } = renderAuth(fake.client, storage)
      await waitFor(() => expect(result.current.status).toBe('signedOut'))
      unmount()
    }
  })

  it('treats an unreadable storage as nothing stored', async () => {
    const fake = fakeClient(session)
    const storage = memoryStorage()
    storage.getItem.mockRejectedValue(new Error('storage unavailable'))
    const { result } = renderAuth(fake.client, storage)
    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    expect(result.current.session).toBe(session)
  })

  it('reads the session from Preferences by default', async () => {
    const fake = fakeClient(null)
    const { result } = renderAuth(fake.client)
    await waitFor(() => expect(result.current.status).toBe('signedOut'))
    expect(Preferences.get).toHaveBeenCalledWith({ key: AUTH_STORAGE_KEY })
  })
})

describe('AuthProvider: auth state changes', () => {
  it('a refreshed session updates the session', async () => {
    const { emit, result } = await signedOutAuth()
    const refreshed = { ...session, access_token: 'fake-refreshed-token' }
    emit('TOKEN_REFRESHED', refreshed)
    expect(result.current.status).toBe('signedIn')
    expect(result.current.session).toBe(refreshed)
  })

  it('SIGNED_IN updates the session', async () => {
    const { emit, result } = await signedOutAuth()
    emit('SIGNED_IN', session)
    expect(result.current.status).toBe('signedIn')
    expect(result.current.session).toBe(session)
  })

  it('unsubscribes from auth changes on unmount', async () => {
    const { unsubscribe, unmount } = await signedOutAuth()
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})

describe('AuthProvider: signIn', () => {
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

  it('signIn maps thrown fetch failures to the network message', async () => {
    const { auth, result } = await signedOutAuth()
    for (const message of [
      'Failed to fetch',
      'Load failed',
      'NetworkError when attempting to fetch resource.'
    ]) {
      auth.signInWithPassword.mockRejectedValueOnce(new TypeError(message))
      await act(async () => {
        await result.current.signIn('user@example.test', 'fake-password')
      })
      expect(result.current.error).toBe('Network error. Check your connection.')
    }
  })

  it('signIn shows a non-network TypeError as its own message', async () => {
    const { auth, result } = await signedOutAuth()
    auth.signInWithPassword.mockRejectedValue(
      new TypeError('Cannot read properties of undefined')
    )
    await act(async () => {
      await result.current.signIn('user@example.test', 'fake-password')
    })
    expect(result.current.error).toBe('Cannot read properties of undefined')
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
      error: new AuthApiError(
        'Invalid login credentials',
        400,
        'invalid_credentials'
      )
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
})

describe('AuthProvider: signOut', () => {
  it('signOut → signedOut', async () => {
    const { auth, result, storage } = await signedInAuth()
    await act(async () => {
      await result.current.signOut()
    })
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(result.current.status).toBe('signedOut')
    expect(result.current.session).toBeNull()
    // supabase-js removed the session itself; only the app's caches remain.
    expect(storage.removeItem.mock.calls).toEqual([[LIBRARY_CACHE_KEY]])
  })

  it('signOut clears the library cache and keeps the device preferences', async () => {
    const { result, storage } = await signedInAuth()
    const prefs = {
      [LIBRARY_SORT_KEY]: 'title',
      [SEARCH_SETTINGS_KEY]: '{"searchMode":"speed","sources":["web"]}',
      [CUSTOM_INSTRUCTIONS_KEY]: 'Be brief.'
    }
    for (const [key, value] of Object.entries(prefs))
      storage.data.set(key, value)
    storage.data.set(LIBRARY_CACHE_KEY, '{"userId":"user-1"}')
    await act(async () => {
      await result.current.signOut()
    })
    expect(storage.data.has(LIBRARY_CACHE_KEY)).toBe(false)
    for (const [key, value] of Object.entries(prefs)) {
      expect(storage.data.get(key)).toBe(value)
    }
  })

  it('signOut clears the library cache when the server can’t be reached too', async () => {
    const { auth, result, storage } = await signedInAuth()
    auth.signOut.mockRejectedValue(new TypeError('Failed to fetch'))
    storage.data.set(LIBRARY_CACHE_KEY, '{"userId":"user-1"}')
    await act(async () => {
      await result.current.signOut()
    })
    expect(storage.data.has(LIBRARY_CACHE_KEY)).toBe(false)
  })

  it('signOut still signs out when clearing the library cache fails', async () => {
    const { result, storage } = await signedInAuth()
    storage.removeItem.mockRejectedValue(new Error('storage unavailable'))
    await act(async () => {
      await result.current.signOut()
    })
    expect(result.current.status).toBe('signedOut')
  })

  it("signOut clears stored keys when the server can't be reached", async () => {
    const { auth, emit, result, storage } = await signedInAuth()
    storage.data.set(`${AUTH_STORAGE_KEY}-code-verifier`, 'fake-verifier')
    storage.data.set(`${AUTH_STORAGE_KEY}-user`, '{"id":"user-1"}')
    auth.signOut.mockResolvedValue({
      error: new AuthRetryableFetchError('Failed to fetch', 0)
    })
    await act(async () => {
      await result.current.signOut()
    })
    for (const key of allKeys) {
      expect(storage.removeItem).toHaveBeenCalledWith(key)
    }
    expect(storage.data.size).toBe(0)
    expect(result.current.status).toBe('signedOut')

    // Nothing is left to refresh; a stray refresh must not sign back in.
    emit('TOKEN_REFRESHED', session)
    expect(result.current.status).toBe('signedOut')
    expect(result.current.session).toBeNull()
  })

  it('signOut clears stored keys when signOut throws', async () => {
    const { auth, result, storage } = await signedInAuth()
    auth.signOut.mockRejectedValue(new TypeError('Failed to fetch'))
    await act(async () => {
      await result.current.signOut()
    })
    for (const key of allKeys) {
      expect(storage.removeItem).toHaveBeenCalledWith(key)
    }
    expect(storage.data.size).toBe(0)
    expect(result.current.status).toBe('signedOut')
  })

  it('signOut still signs out when clearing storage fails', async () => {
    const { auth, result, storage } = await signedInAuth()
    auth.signOut.mockResolvedValue({
      error: new AuthRetryableFetchError('Failed to fetch', 0)
    })
    storage.removeItem.mockRejectedValue(new Error('storage unavailable'))
    await act(async () => {
      await result.current.signOut()
    })
    expect(result.current.status).toBe('signedOut')
  })

  it('signIn after signOut signs in again', async () => {
    const { auth, emit, result } = await signedInAuth()
    await act(async () => {
      await result.current.signOut()
    })
    auth.signInWithPassword.mockResolvedValue({
      data: { session, user: session.user },
      error: null
    })
    await act(async () => {
      await result.current.signIn('user@example.test', 'fake-password')
    })
    expect(result.current.status).toBe('signedIn')
    const refreshed = { ...session, access_token: 'fake-refreshed-token' }
    emit('TOKEN_REFRESHED', refreshed)
    expect(result.current.session).toBe(refreshed)
  })
})

describe('AuthProvider: getAccessToken', () => {
  it('getAccessToken returns the session token or null', async () => {
    const { auth, result } = await signedInAuth()
    await expect(result.current.getAccessToken()).resolves.toBe(
      'fake-access-token'
    )
    auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null
    })
    await expect(result.current.getAccessToken()).resolves.toBeNull()
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
