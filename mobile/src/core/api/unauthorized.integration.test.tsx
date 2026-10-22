// The whole path of a dead session: a request the server answers 401, a
// refresh Supabase refuses, and the sign-in screen saying why.

import {
  AuthApiError,
  type Session,
  type SupabaseClient
} from '@supabase/supabase-js'
import { render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider, useApi } from '@/core/api/ApiProvider'
import { AuthProvider, useAuth } from '@/core/auth/AuthProvider'
import { AUTH_STORAGE_KEY } from '@/core/auth/supabase'
import { SignInScreen } from '@/features/auth/SignInScreen'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })) }
}))

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    addListener: vi.fn(async () => ({ remove: async () => {} }))
  }
}))

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(),
    remove: vi.fn()
  }
}))

vi.mock('@/core/shared-inbox', () => ({
  takeSharedItem: vi.fn(async () => null)
}))

const BASE = 'https://ask.test.invalid'

// Fake values only: no real tokens or accounts.
const session = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  expires_at: 4102444800,
  user: { id: 'user-1', email: 'user@example.test' }
} as unknown as Session

function fakeSupabase() {
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange: vi.fn(() => ({
      data: { subscription: { unsubscribe: vi.fn() } }
    })),
    refreshSession: vi.fn().mockResolvedValue({
      data: { session: null, user: null },
      error: new AuthApiError(
        'Invalid Refresh Token: Refresh Token Not Found',
        400,
        'refresh_token_not_found'
      )
    }),
    signOut: vi.fn().mockResolvedValue({ error: null })
  }
  return { auth, client: { auth } as unknown as SupabaseClient }
}

/** A signed-in screen that loads the chat list as it opens. */
function Library() {
  const { client } = useApi()
  useEffect(() => {
    void client.fetch('/api/chats')
  }, [client])
  return <p>Library</p>
}

function Shell() {
  const { status } = useAuth()
  if (status === 'loading') return null
  if (status === 'signedOut') return <SignInScreen apiBaseUrl={BASE} />
  return (
    <ApiProvider baseUrl={BASE}>
      <Library />
    </ApiProvider>
  )
}

describe('a session the server refuses', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the sign-in screen says “You’ve been signed out.”', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('Authentication required', { status: 401 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const { auth, client } = fakeSupabase()
    const storage = memoryStorage({
      [AUTH_STORAGE_KEY]: JSON.stringify(session)
    })

    render(
      <AuthProvider client={client} storage={storage}>
        <Shell />
      </AuthProvider>
    )

    expect(await screen.findByText('You’ve been signed out.')).toBeVisible()
    expect(screen.queryByText('Library')).not.toBeInTheDocument()
    expect(auth.refreshSession).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(auth.signOut).toHaveBeenCalledTimes(1))
    // Never resent: the refresh was refused.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
