import { afterEach, describe, expect, it, vi } from 'vitest'

import { getConfig } from '@/core/config'

// Fake values only: these never reach a real Supabase project.
const supabase = {
  VITE_SUPABASE_URL: 'https://supabase.test.invalid',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake'
}

describe('getConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults the API base to the release server', () => {
    expect(getConfig({ ...supabase })).toEqual({
      apiBaseUrl: 'https://ask.hbqnexus.win',
      supabaseUrl: 'https://supabase.test.invalid',
      supabaseKey: 'sb_publishable_fake'
    })
  })

  it('treats an empty API base as unset', () => {
    expect(getConfig({ ...supabase, VITE_ASK_API_URL: '' }).apiBaseUrl).toBe(
      'https://ask.hbqnexus.win'
    )
  })

  it('uses VITE_ASK_API_URL when set', () => {
    expect(
      getConfig({ ...supabase, VITE_ASK_API_URL: 'http://192.0.2.10:3742' })
        .apiBaseUrl
    ).toBe('http://192.0.2.10:3742')
  })

  it('strips trailing slashes from the API base', () => {
    expect(
      getConfig({ ...supabase, VITE_ASK_API_URL: 'http://192.0.2.10:3742//' })
        .apiBaseUrl
    ).toBe('http://192.0.2.10:3742')
  })

  it('throws when the Supabase URL is missing', () => {
    expect(() =>
      getConfig({ VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake' })
    ).toThrow(new Error('Missing Supabase configuration'))
  })

  it('throws when the Supabase key is missing', () => {
    expect(() =>
      getConfig({ VITE_SUPABASE_URL: 'https://supabase.test.invalid' })
    ).toThrow(new Error('Missing Supabase configuration'))
  })

  it('throws when the Supabase values are empty strings', () => {
    expect(() =>
      getConfig({ VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '' })
    ).toThrow(new Error('Missing Supabase configuration'))
  })

  it('reads import.meta.env by default', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://supabase.test.invalid')
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_fake')
    vi.stubEnv('VITE_ASK_API_URL', 'http://192.0.2.10:3742/')
    expect(getConfig()).toEqual({
      apiBaseUrl: 'http://192.0.2.10:3742',
      supabaseUrl: 'https://supabase.test.invalid',
      supabaseKey: 'sb_publishable_fake'
    })
  })
})
