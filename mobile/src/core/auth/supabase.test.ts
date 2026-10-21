import { createClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { preferencesStorage } from '@/core/auth/preferences-storage'
import { createSupabase } from '@/core/auth/supabase'
import type { AppConfig } from '@/core/config'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ fake: 'client' }))
}))

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
}))

// Fake values only: these never reach a real Supabase project.
const config: AppConfig = {
  apiBaseUrl: 'https://ask.test.invalid',
  supabaseUrl: 'https://supabase.test.invalid',
  supabaseKey: 'sb_publishable_fake'
}

const authOptions = {
  persistSession: true,
  autoRefreshToken: true,
  detectSessionInUrl: false,
  flowType: 'pkce'
}

describe('createSupabase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates the client with the Preferences storage and persisted, auto-refreshed sessions', () => {
    const client = createSupabase(config)
    expect(client).toEqual({ fake: 'client' })
    expect(createClient).toHaveBeenCalledWith(
      'https://supabase.test.invalid',
      'sb_publishable_fake',
      { auth: { storage: preferencesStorage, ...authOptions } }
    )
  })

  it('uses the storage it is given', () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn()
    }
    createSupabase(config, storage)
    expect(createClient).toHaveBeenCalledWith(
      'https://supabase.test.invalid',
      'sb_publishable_fake',
      { auth: { storage, ...authOptions } }
    )
  })
})
