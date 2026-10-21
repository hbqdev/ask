import type { SupabaseClient } from '@supabase/supabase-js'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppConfig } from '@/core/config'

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  createSupabase: vi.fn(),
  hideSplash: vi.fn(async () => {})
}))

vi.mock('@/core/config', () => ({ getConfig: mocks.getConfig }))

vi.mock('@/core/auth/supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('@/core/auth/supabase')>()),
  createSupabase: mocks.createSupabase
}))

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true }
}))

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: mocks.hideSplash }
}))

// Fake values only: these never reach a real Supabase project.
const config: AppConfig = {
  apiBaseUrl: 'https://ask.test.invalid',
  supabaseUrl: 'https://supabase.test.invalid',
  supabaseKey: 'sb_publishable_fake'
}

function fakeClient() {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } }
      }))
    }
  } as unknown as SupabaseClient
}

/** A fresh App module, so each test starts the app from scratch. */
async function loadApp() {
  vi.resetModules()
  return (await import('@/App')).default
}

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getConfig.mockReturnValue(config)
    mocks.createSupabase.mockImplementation(fakeClient)
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.className = ''
  })

  it('renders the app root and lands on sign-in when signed out', async () => {
    const App = await loadApp()
    render(<App />)

    expect(screen.getByTestId('app-root')).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: 'Sign in' })
    ).toBeInTheDocument()
    expect(mocks.hideSplash).toHaveBeenCalledTimes(1)
  })

  it('creates the Supabase client once, from the build config', async () => {
    const App = await loadApp()
    const { rerender, unmount } = render(<App />)
    rerender(<App />)
    unmount()
    render(<App />)
    await screen.findByRole('button', { name: 'Sign in' })

    expect(mocks.createSupabase).toHaveBeenCalledTimes(1)
    expect(mocks.createSupabase).toHaveBeenCalledWith(config)
  })

  it('shows a configuration error instead of a blank screen', async () => {
    mocks.getConfig.mockImplementation(() => {
      throw new Error('Missing Supabase configuration')
    })
    const App = await loadApp()
    render(<App />)
    await act(async () => {})

    expect(screen.getByTestId('app-root')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: "Ask isn't configured" })
    ).toBeInTheDocument()
    expect(
      screen.getByText('Missing Supabase configuration')
    ).toBeInTheDocument()
    expect(mocks.createSupabase).not.toHaveBeenCalled()
    // The splash must not hide the error forever.
    expect(mocks.hideSplash).toHaveBeenCalledTimes(1)
  })

  it('shows a configuration error for a non-Error failure', async () => {
    mocks.getConfig.mockImplementation(() => {
      throw 'config unreadable'
    })
    const App = await loadApp()
    render(<App />)

    expect(screen.getByText('config unreadable')).toBeInTheDocument()
  })
})
