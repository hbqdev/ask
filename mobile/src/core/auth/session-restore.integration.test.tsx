// The real supabase-js client, offline: a stored, unexpired session must
// restore and hand out its token with no successful network call.

import type { SupabaseClient } from '@supabase/supabase-js'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from '@/core/auth/AuthProvider'
import { AUTH_STORAGE_KEY, createSupabase } from '@/core/auth/supabase'
import type { AppConfig } from '@/core/config'
import { memoryStorage } from '@/test/memory-storage'

// Fake values only: these never reach a real Supabase project.
const config: AppConfig = {
  apiBaseUrl: 'https://ask.test.invalid',
  supabaseUrl: 'https://supabase.test.invalid',
  supabaseKey: 'sb_publishable_fake'
}

function storedSession() {
  const now = Math.floor(Date.now() / 1000)
  return JSON.stringify({
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: 'user-1', email: 'user@example.test', aud: 'authenticated' }
  })
}

describe('session restore with the real Supabase client', () => {
  let client: SupabaseClient | undefined

  afterEach(async () => {
    await client?.auth.stopAutoRefresh()
    vi.unstubAllGlobals()
  })

  it('restores a stored session offline and returns its token', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    vi.stubGlobal('fetch', fetchMock)
    const storage = memoryStorage({ [AUTH_STORAGE_KEY]: storedSession() })
    client = createSupabase(config, storage)
    const real = client
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider client={real} storage={storage}>
        {children}
      </AuthProvider>
    )
    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.status).toBe('signedIn'))
    let token: string | null = null
    await act(async () => {
      token = await result.current.getAccessToken()
    })
    expect(token).toBe('fake-access-token')
    expect(result.current.status).toBe('signedIn')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
