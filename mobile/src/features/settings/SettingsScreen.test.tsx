import type { Session } from '@supabase/supabase-js'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { createApiClient } from '@/core/api/client'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { THEME_STORAGE_KEY } from '@/core/theme'
import { ThemeProvider } from '@/core/ThemeProvider'
import { SearchSettingsProvider } from '@/features/compose/SearchSettingsProvider'
import { SettingsScreen } from '@/features/settings/SettingsScreen'
import { memoryStorage } from '@/test/memory-storage'

vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))
vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async () => ({ value: null })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
}))
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: async () => {} })) }
}))

const BASE = 'https://ask.test.invalid'

/** A server whose model list is off, so the Answers section needs no data. */
function fakeApi() {
  const client = createApiClient({
    baseUrl: BASE,
    getToken: async () => 'token',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          enabled: false,
          hasAvailableModels: false,
          selectedModelKey: '',
          modelsByProvider: {}
        }),
        { headers: { 'Content-Type': 'application/json' } }
      )
  })
  vi.mocked(useApi).mockReturnValue({
    client,
    baseUrl: BASE,
    getToken: async () => 'token'
  } satisfies Api)
}

// Fake values only.
const session = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  user: { id: 'user-1', email: 'user@example.test' }
} as unknown as Session

function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  const auth: Auth = {
    status: 'signedIn',
    session,
    error: null,
    signIn: vi.fn(async () => true),
    signOut: vi.fn(async () => {}),
    getAccessToken: vi.fn(async () => null),
    ...overrides
  }
  vi.mocked(useAuth).mockReturnValue(auth)
  return auth
}

async function renderSettings(storage = memoryStorage()) {
  fakeApi()
  render(
    <ThemeProvider storage={storage}>
      <SearchSettingsProvider storage={memoryStorage()}>
        <SettingsScreen />
      </SearchSettingsProvider>
    </ThemeProvider>
  )
  await act(async () => {})
  return storage
}

const root = document.documentElement

describe('SettingsScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    root.className = ''
    root.style.colorScheme = ''
  })

  it('shows the sections in order', async () => {
    fakeAuth()
    await renderSettings()
    expect(
      screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)
    ).toEqual([
      'Account',
      'Answers',
      'Personalization',
      'Appearance',
      'Data',
      'About'
    ])
  })

  it('shows the signed-in email', async () => {
    fakeAuth()
    await renderSettings()
    expect(screen.getByText('user@example.test')).toBeInTheDocument()
  })

  it('leaves out the account row when the session has no email', async () => {
    fakeAuth({
      session: { ...session, user: { id: 'user-1' } } as unknown as Session
    })
    await renderSettings()
    expect(screen.queryByText('Signed in as')).not.toBeInTheDocument()
  })

  it('shows the current theme and changes it', async () => {
    fakeAuth()
    const user = userEvent.setup()
    const storage = await renderSettings(memoryStorage({ theme: 'light' }))

    const option = (name: string) => screen.getByRole('radio', { name })
    expect(option('Light')).toHaveAttribute('aria-checked', 'true')
    expect(option('System')).toHaveAttribute('aria-checked', 'false')

    await user.click(option('Dark'))
    expect(option('Dark')).toHaveAttribute('aria-checked', 'true')
    expect(option('Light')).toHaveAttribute('aria-checked', 'false')
    expect(root.classList.contains('dark')).toBe(true)
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe('dark')

    await user.click(option('System'))
    expect(option('System')).toHaveAttribute('aria-checked', 'true')
    expect(root.classList.contains('dark')).toBe(false)
  })

  it('Sign out calls signOut', async () => {
    const auth = fakeAuth()
    const user = userEvent.setup()
    await renderSettings()

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(auth.signOut).toHaveBeenCalledTimes(1)
  })
})
