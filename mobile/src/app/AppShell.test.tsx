import { SplashScreen } from '@capacitor/splash-screen'
import type {
  AuthChangeEvent,
  Session,
  SupabaseClient
} from '@supabase/supabase-js'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppShell } from '@/app/AppShell'
import { resetSplashForTests } from '@/app/splash'
import { ApiProvider } from '@/core/api/ApiProvider'
import { AuthProvider } from '@/core/auth/AuthProvider'
import type { AuthStorage } from '@/core/auth/preferences-storage'
import { ThemeProvider } from '@/core/ThemeProvider'
import { resetModelChoice } from '@/features/compose/model-choice'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => true) }
}))

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn(async () => {}) }
}))

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

vi.mock('@/core/api/ApiProvider', async importOriginal => {
  const actual = await importOriginal<typeof import('@/core/api/ApiProvider')>()
  return { ...actual, ApiProvider: vi.fn(actual.ApiProvider) }
})

// Fake values only: no real tokens or accounts.
const session = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  expires_at: 4102444800,
  user: { id: 'user-1', email: 'user@example.test' }
} as unknown as Session

type Listener = (event: AuthChangeEvent, session: Session | null) => void

const never = () => new Promise<never>(() => {})

function fakeClient(
  getSession: () => Promise<unknown> = async () => ({
    data: { session: null },
    error: null
  })
) {
  let listener: Listener = () => {}
  const auth = {
    getSession: vi.fn(getSession),
    onAuthStateChange: vi.fn((cb: Listener) => {
      listener = cb
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    }),
    signInWithPassword: vi.fn(async () => ({
      data: { session },
      error: null
    })),
    signOut: vi.fn(async () => {
      listener('SIGNED_OUT', null)
      return { error: null }
    })
  }
  return { auth, client: { auth } as unknown as SupabaseClient }
}

function renderShell(
  client: SupabaseClient,
  {
    authStorage = memoryStorage(),
    themeStorage = memoryStorage()
  }: { authStorage?: AuthStorage; themeStorage?: AuthStorage } = {}
) {
  return render(
    <ThemeProvider storage={themeStorage}>
      <AuthProvider client={client} storage={authStorage}>
        <AppShell apiBaseUrl="https://ask.test.invalid" />
      </AuthProvider>
    </ThemeProvider>
  )
}

const signInButton = () => screen.findByRole('button', { name: 'Sign in' })

describe('AppShell', () => {
  beforeEach(() => {
    resetModelChoice()
    vi.clearAllMocks()
    resetSplashForTests()
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

  it('shows the splash with the mark while the session loads', async () => {
    const { client } = fakeClient(never)
    renderShell(client)
    await act(async () => {})

    expect(screen.getByTestId('app-splash')).toBeInTheDocument()
    expect(screen.getByTestId('orbit-mark')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Sign in' })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('shows sign-in when signed out', async () => {
    const { client } = fakeClient()
    renderShell(client)

    expect(await signInButton()).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('shows sign-in when session restore fails', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('refresh failed')
    })
    renderShell(client)

    expect(await signInButton()).toBeInTheDocument()
    expect(screen.queryByTestId('app-splash')).not.toBeInTheDocument()
  })

  it('shows the tabs when signed in, opening on Ask', async () => {
    const { client } = fakeClient(async () => ({
      data: { session },
      error: null
    }))
    renderShell(client)

    const tabs = await screen.findAllByRole('tab')
    expect(tabs.map(t => t.textContent)).toEqual(['Ask', 'Library', 'Settings'])
    expect(screen.getByRole('tab', { name: 'Ask' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(
      screen.getByRole('heading', { name: 'Ask anything' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Ask a question' })
    ).toBeInTheDocument()
  })

  it('gives the signed-in app an API client on the configured server', async () => {
    const { client } = fakeClient(async () => ({
      data: { session },
      error: null
    }))
    renderShell(client)

    await screen.findAllByRole('tab')
    expect(vi.mocked(ApiProvider).mock.calls.at(-1)?.[0]).toMatchObject({
      baseUrl: 'https://ask.test.invalid'
    })
  })

  it('has no API client while signed out', async () => {
    const { client } = fakeClient()
    renderShell(client)

    await signInButton()
    expect(ApiProvider).not.toHaveBeenCalled()
  })

  it('shows the Library and the Settings screen', async () => {
    const { client } = fakeClient(async () => ({
      data: { session },
      error: null
    }))
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({ chats: [], nextOffset: null, badges: {}, total: 0 }),
          { headers: { 'Content-Type': 'application/json' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderShell(client)

    await user.click(await screen.findByRole('tab', { name: 'Library' }))
    expect(
      screen.getByRole('heading', { level: 1, name: 'Library' })
    ).toBeVisible()
    expect(await screen.findByText('No chats yet')).toBeVisible()
    expect(String(fetchMock.mock.calls[0][0])).toMatch(
      /^https:\/\/ask\.test\.invalid\/api\/chats\?/
    )

    // The empty Library leads back to the Ask tab.
    await user.click(screen.getByRole('button', { name: 'Ask a question' }))
    expect(screen.getByRole('tab', { name: 'Ask' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
    await user.click(screen.getByRole('tab', { name: 'Library' }))

    await user.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(screen.getByText('user@example.test')).toBeInTheDocument()
  })

  it('signing in shows the tabs', async () => {
    const { client, auth } = fakeClient()
    const user = userEvent.setup()
    renderShell(client)

    await user.type(await screen.findByLabelText('Email'), 'user@example.test')
    await user.type(screen.getByLabelText('Password'), 'fake-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.test',
      password: 'fake-password'
    })
    expect(
      await screen.findByRole('heading', { name: 'Ask anything' })
    ).toBeInTheDocument()
  })

  it('signing out from Settings returns to sign-in', async () => {
    const { client, auth } = fakeClient(async () => ({
      data: { session },
      error: null
    }))
    const user = userEvent.setup()
    renderShell(client)

    await user.click(await screen.findByRole('tab', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await user.click(
      within(screen.getByRole('dialog', { name: 'Sign out?' })).getByRole(
        'button',
        { name: 'Sign out' }
      )
    )

    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(await signInButton()).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  describe('native splash', () => {
    it('stays up while the theme preference is still loading', async () => {
      let releaseTheme: (value: string | null) => void = () => {}
      const themeStorage = {
        ...memoryStorage(),
        getItem: vi.fn(
          () =>
            new Promise<string | null>(resolve => {
              releaseTheme = resolve
            })
        )
      }
      const { client } = fakeClient()
      renderShell(client, { themeStorage })

      await signInButton()
      expect(SplashScreen.hide).not.toHaveBeenCalled()

      await act(async () => releaseTheme('light'))
      expect(SplashScreen.hide).toHaveBeenCalledTimes(1)
    })

    it('stays up while the session is still loading', async () => {
      const { client } = fakeClient(never)
      renderShell(client)
      await act(async () => {})

      expect(SplashScreen.hide).not.toHaveBeenCalled()
    })

    it('hides once the theme and the session are ready', async () => {
      const { client } = fakeClient(async () => ({
        data: { session },
        error: null
      }))
      renderShell(client)

      await screen.findByRole('heading', { name: 'Ask anything' })
      await waitFor(() => expect(SplashScreen.hide).toHaveBeenCalledTimes(1))
    })
  })
})
