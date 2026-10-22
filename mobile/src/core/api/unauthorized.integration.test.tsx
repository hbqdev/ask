// The whole path of a server 401, through the real AuthProvider, ApiProvider
// and screens, on a fake Supabase: a dead session ends on the sign-in screen
// saying why; a late 401 after a sign-out (Settings, a deleted account) or
// after another account signed in changes nothing.

import {
  AuthApiError,
  type AuthChangeEvent,
  type Session,
  type SupabaseClient
} from '@supabase/supabase-js'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider, useApi } from '@/core/api/ApiProvider'
import {
  AuthProvider,
  REFRESH_TIMEOUT_MS,
  useAuth
} from '@/core/auth/AuthProvider'
import { AUTH_STORAGE_KEY } from '@/core/auth/supabase'
import { takeSharedItem } from '@/core/shared-inbox'
import { SignInScreen } from '@/features/auth/SignInScreen'
import {
  DeleteAccountSheet,
  SIGNED_OUT_AFTER_401_NOTICE
} from '@/features/settings/DeleteAccount'
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

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

vi.mock('@/core/shared-inbox', () => ({
  takeSharedItem: vi.fn(async () => null)
}))

const BASE = 'https://ask.test.invalid'
const SIGNED_OUT = 'You’ve been signed out.'

// Fake values only: no real tokens or accounts.
const sessionOf = (user: string): Session =>
  ({
    access_token: `tok-${user}`,
    refresh_token: `refresh-${user}`,
    expires_at: 4102444800,
    user: { id: user, email: `${user}@example.test` }
  }) as unknown as Session

const refused = () => ({
  data: { session: null, user: null },
  error: new AuthApiError(
    'Invalid Refresh Token: Refresh Token Not Found',
    400,
    'refresh_token_not_found'
  )
})

type Listener = (event: AuthChangeEvent, session: Session | null) => void

/** Supabase with one current session, which sign-in and sign-out change. */
function fakeSupabase(initial: Session) {
  let current: Session | null = initial
  let listener: Listener = () => {}
  const auth = {
    getSession: vi.fn(async () => ({
      data: { session: current },
      error: null
    })),
    onAuthStateChange: vi.fn((cb: Listener) => {
      listener = cb
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    }),
    refreshSession: vi.fn(async (): Promise<unknown> => refused()),
    signInWithPassword: vi.fn(async ({ email }: { email: string }) => {
      current = sessionOf(email.split('@')[0]!)
      return { data: { session: current, user: current.user }, error: null }
    }),
    signOut: vi.fn(async () => {
      current = null
      return { error: null }
    })
  }
  return {
    auth,
    client: { auth } as unknown as SupabaseClient,
    /** supabase-js dropping the session itself. */
    drop: () => {
      current = null
      listener('SIGNED_OUT', null)
    },
    /** supabase-js storing a refreshed session. */
    refreshTo: (next: Session) => {
      current = next
      listener('TOKEN_REFRESHED', next)
    }
  }
}

const unauthorized = () =>
  new Response('Authentication required', { status: 401 })

/** A request the test answers later. */
function deferred() {
  let answer: (res: Response) => void = () => {}
  const response = new Promise<Response>(resolve => {
    answer = resolve
  })
  return { response, answer: (res: Response) => act(async () => answer(res)) }
}

/** A signed-in screen that loads the chat list (once per `loads`) as it opens. */
function Library({ loads = 1 }: { loads?: number }) {
  const { client } = useApi()
  const { session } = useAuth()
  const user = session?.user.id
  useEffect(() => {
    for (let i = 0; i < loads; i++) {
      void client.fetch(`/api/chats?for=${user}&n=${i}`).catch(() => {})
    }
  }, [client, user, loads])
  return <p>Library</p>
}

/** The signed-in app's API, for a test to send its own requests. */
let api: ReturnType<typeof useApi> | null = null
function GrabApi() {
  api = useApi()
  return null
}

function Shell({
  loads,
  deleting = false
}: {
  loads?: number
  deleting?: boolean
}) {
  const { status, signOut } = useAuth()
  if (status === 'loading') return null
  if (status === 'signedOut') return <SignInScreen apiBaseUrl={BASE} />
  return (
    <ApiProvider baseUrl={BASE}>
      <GrabApi />
      <Library loads={loads} />
      <button type="button" onClick={() => void signOut()}>
        Sign out here
      </button>
      <DeleteAccountSheet open={deleting} onClose={() => {}} />
    </ApiProvider>
  )
}

const fetchMock = vi.fn<typeof fetch>()

/** Who each request was sent as, in order, for `path` (no query). */
const sentAs = (path: string) =>
  fetchMock.mock.calls
    .filter(([input]) => String(input).startsWith(`${BASE}${path}`))
    .map(([input, init]) => [
      String(input).slice(BASE.length),
      new Headers(init?.headers).get('Authorization')
    ])

function renderApp(
  supabase: ReturnType<typeof fakeSupabase>,
  props: { loads?: number; deleting?: boolean } = {}
) {
  const storage = memoryStorage({
    [AUTH_STORAGE_KEY]: JSON.stringify(sessionOf('a'))
  })
  render(
    <AuthProvider client={supabase.client} storage={storage}>
      <Shell {...props} />
    </AuthProvider>
  )
}

const notice = () => screen.queryByText(/signed out|deleted/i)?.textContent

describe('a server 401', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('the sign-in screen says “You’ve been signed out.”', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    const supabase = fakeSupabase(sessionOf('a'))

    renderApp(supabase)

    expect(await screen.findByText(SIGNED_OUT)).toBeVisible()
    expect(screen.queryByText('Library')).not.toBeInTheDocument()
    expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledTimes(1))
    // Never resent: the refresh was refused.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a burst, with supabase-js dropping the session before the refresh resolves: one refresh, one sign-out, the notice', async () => {
    fetchMock.mockImplementation(async () => unauthorized())
    const supabase = fakeSupabase(sessionOf('a'))
    supabase.auth.refreshSession.mockImplementation(async () => {
      // As auth-js does for an expired access token: SIGNED_OUT first.
      act(() => supabase.drop())
      return refused()
    })

    renderApp(supabase, { loads: 3 })

    expect(await screen.findByText(SIGNED_OUT)).toBeVisible()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(supabase.auth.signOut).toHaveBeenCalledTimes(1))
    expect(screen.getAllByText(SIGNED_OUT)).toHaveLength(1)
  })

  it('Supabase dropping the session by itself (its background refresh refused): the notice, and a waiting share dropped', async () => {
    fetchMock.mockImplementation(async () => new Response('[]'))
    const supabase = fakeSupabase(sessionOf('a'))
    renderApp(supabase)
    await screen.findByText('Library')

    act(() => supabase.drop())

    expect(await screen.findByText(SIGNED_OUT)).toBeVisible()
    expect(screen.getAllByText(SIGNED_OUT)).toHaveLength(1)
    expect(takeSharedItem).toHaveBeenCalledTimes(1)
    // The app started no sign-out of its own.
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
  })

  it('a burst that outlasts the refresh timeout: each ends 401 once, never resent; a later 401 joins the refresh still running and only it is resent', async () => {
    const supabase = fakeSupabase(sessionOf('a'))
    // One refresh at a time, shared by concurrent calls (as auth-js dedupes);
    // it settles when the test says so.
    let pending: Promise<unknown> | null = null
    let succeed: () => void = () => {}
    supabase.auth.refreshSession.mockImplementation(() => {
      pending ??= new Promise(resolve => {
        succeed = () => {
          pending = null
          const next = { ...sessionOf('a'), access_token: 'tok-a-1' } as Session
          supabase.refreshTo(next)
          resolve({ data: { session: next, user: next.user }, error: null })
        }
      })
      return pending
    })
    fetchMock.mockImplementation(async () => new Response('[]'))
    renderApp(supabase, { loads: 0 })
    await screen.findByText('Library')
    fetchMock.mockImplementation(async () => unauthorized())
    const send = (path: string) => api!.client.fetch(path).then(r => r.status)
    const flush = async () => {
      for (let i = 0; i < 10; i++) await act(async () => {})
    }

    vi.useFakeTimers()
    try {
      const burst = ['/api/1', '/api/2', '/api/3'].map(send)
      await flush()
      expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(1)
      let settled = false
      void Promise.all(burst).then(() => (settled = true))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_TIMEOUT_MS - 1)
      })
      expect(settled).toBe(false)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(await Promise.all(burst)).toEqual([401, 401, 401])
      expect(vi.getTimerCount()).toBe(0)

      // A 4th 401 while supabase-js is still refreshing joins that refresh.
      const late = send('/api/4')
      await flush()
      expect(supabase.auth.refreshSession).toHaveBeenCalledTimes(2)
      fetchMock.mockImplementation(async () => new Response('ok'))
      await act(async () => succeed())
      expect(await late).toBe(200)
      await flush()
    } finally {
      vi.useRealTimers()
    }

    expect(sentAs('/api/')).toEqual([
      ['/api/1', 'Bearer tok-a'],
      ['/api/2', 'Bearer tok-a'],
      ['/api/3', 'Bearer tok-a'],
      ['/api/4', 'Bearer tok-a'],
      ['/api/4', 'Bearer tok-a-1']
    ])
    expect(supabase.auth.signOut).not.toHaveBeenCalled()
    expect(screen.getByText('Library')).toBeVisible()
  })

  it('a late 401 after a deliberate sign-out: no second sign-out, no notice', async () => {
    const late = deferred()
    fetchMock.mockReturnValue(late.response)
    const supabase = fakeSupabase(sessionOf('a'))
    renderApp(supabase)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Sign out here' }))
    await screen.findByRole('button', { name: 'Sign in' })
    await late.answer(unauthorized())
    await act(async () => {})

    expect(supabase.auth.refreshSession).not.toHaveBeenCalled()
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1)
    expect(notice()).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a late 401 after the account deletion’s own 401: its notice and the kept shared item stay', async () => {
    const late = deferred()
    fetchMock.mockImplementation(async (input, init) =>
      init?.method === 'DELETE' && String(input) === `${BASE}/api/account`
        ? unauthorized()
        : late.response
    )
    const supabase = fakeSupabase(sessionOf('a'))
    renderApp(supabase, { deleting: true })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByLabelText('Type DELETE to confirm'), {
      target: { value: 'DELETE' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }))
    expect(await screen.findByText(SIGNED_OUT_AFTER_401_NOTICE)).toBeVisible()
    await late.answer(unauthorized())
    await act(async () => {})

    expect(notice()).toBe(SIGNED_OUT_AFTER_401_NOTICE)
    expect(takeSharedItem).not.toHaveBeenCalled()
    expect(supabase.auth.refreshSession).not.toHaveBeenCalled()
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1)
  })

  it('account B signs in, then A’s late 401: B is not refreshed and A’s request is not resent with B’s token', async () => {
    const late = deferred()
    fetchMock.mockImplementation(async input =>
      String(input).includes('for=a') ? late.response : new Response('[]')
    )
    const supabase = fakeSupabase(sessionOf('a'))
    renderApp(supabase)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Sign out here' }))
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'b@example.test' }
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'fake-password' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('Library')
    await waitFor(() => expect(sentAs('/api/chats?for=b')).toHaveLength(1))

    await late.answer(unauthorized())
    await act(async () => {})

    expect(supabase.auth.refreshSession).not.toHaveBeenCalled()
    expect(sentAs('/api/chats')).toEqual([
      ['/api/chats?for=a&n=0', 'Bearer tok-a'],
      ['/api/chats?for=b&n=0', 'Bearer tok-b']
    ])
    expect(screen.getByText('Library')).toBeVisible()
  })
})
