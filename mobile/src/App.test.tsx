import type { SupabaseClient } from '@supabase/supabase-js'
import { act, render, screen, waitFor } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

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
  Capacitor: { isNativePlatform: () => true },
  // The Share to Ask inbox (core/shared-inbox): always empty here.
  registerPlugin: () => ({ take: async () => ({}) })
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

/** The first import of the app's module graph transforms it all: seconds. */
const COLD_IMPORT_TIMEOUT_MS = 60_000

describe('App', () => {
  // Pay the one-off transform here, with its own budget, so no test's time
  // (5 s) depends on how loaded the machine is; loadApp then only re-runs the
  // already transformed modules.
  beforeAll(async () => {
    await import('@/App')
  }, COLD_IMPORT_TIMEOUT_MS)

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

    // The web view is edge to edge: the root clears the status bar and the
    // sides (styles.css .app-root).
    expect(screen.getByTestId('app-root')).toHaveClass('app-root')
    expect(
      await screen.findByRole('button', { name: 'Sign in' })
    ).toBeInTheDocument()
    // Sign-in can show before the stored theme is read; the splash hides once
    // both are known, so wait for it rather than assume the same tick.
    await waitFor(() => expect(mocks.hideSplash).toHaveBeenCalledTimes(1))
  })

  it('points Forgot password? at the configured server', async () => {
    const App = await loadApp()
    render(<App />)

    expect(
      await screen.findByRole('link', { name: 'Forgot password?' })
    ).toHaveAttribute('href', 'https://ask.test.invalid/auth/forgot-password')
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

  it('catches a crash anywhere in the app, even in ThemeProvider', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.resetModules()
    vi.doMock('@/core/ThemeProvider', () => ({
      ThemeProvider: () => {
        throw new Error('theme exploded')
      },
      useTheme: vi.fn()
    }))
    try {
      const App = (await import('@/App')).default
      render(<App />)

      expect(
        screen.getByRole('heading', { name: 'Something went wrong' })
      ).toBeInTheDocument()
      expect(screen.getByText('theme exploded')).toBeInTheDocument()
      expect(mocks.hideSplash).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('@/core/ThemeProvider')
      vi.mocked(console.error).mockRestore()
    }
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
