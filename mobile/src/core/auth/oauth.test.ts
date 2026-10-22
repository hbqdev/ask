import { Browser } from '@capacitor/browser'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUTH_CALLBACK_URL,
  deliverAuthCallback,
  GOOGLE_SIGN_IN_TIMEOUT_MS,
  googleSignInPending,
  parseAuthCallback,
  runGoogleSignIn
} from '@/core/auth/oauth'
import { AUTH_STORAGE_KEY, createSupabase } from '@/core/auth/supabase'
import { memoryStorage } from '@/test/memory-storage'

const browser = vi.hoisted(() => ({
  finished: [] as Array<() => void>,
  remove: vi.fn(async () => {})
}))

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    addListener: vi.fn(async (_event: string, listener: () => void) => {
      browser.finished.push(listener)
      return { remove: browser.remove }
    })
  }
}))

// Fake values only: no real tokens, accounts or Supabase project.
const GOOGLE_URL = 'https://supabase.test.invalid/auth/v1/authorize?x=1'
const session = {
  access_token: 'fake-access-token',
  refresh_token: 'fake-refresh-token',
  user: { id: 'user-1' }
} as unknown as Session

function fakeClient() {
  const auth = {
    signInWithOAuth: vi.fn(async () => ({
      data: { provider: 'google', url: GOOGLE_URL },
      error: null
    })),
    exchangeCodeForSession: vi.fn(async () => ({
      data: { session, user: session.user },
      error: null
    }))
  }
  return { auth, client: { auth } as unknown as SupabaseClient }
}

/** Lets the sign-in reach the point where it waits for the browser. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/**
 * Starts a sign-in and waits until the browser is open. The sign-in comes
 * back wrapped: an async function returning the promise itself would wait
 * for it.
 */
async function started(client: SupabaseClient) {
  const result = runGoogleSignIn(client)
  await vi.waitFor(() => expect(Browser.open).toHaveBeenCalled())
  return { result }
}

const finishBrowser = () => browser.finished.forEach(l => l())

describe('parseAuthCallback', () => {
  it('reads the code', () => {
    expect(parseAuthCallback('ask://auth-callback?code=abc-123')).toEqual({
      code: 'abc-123'
    })
  })

  it('accepts a trailing slash', () => {
    expect(parseAuthCallback('ask://auth-callback/?code=abc')).toEqual({
      code: 'abc'
    })
  })

  it('reads a URL-decoded, trimmed error_description', () => {
    expect(
      parseAuthCallback(
        'ask://auth-callback?error=access_denied&error_description=%20The+user%20denied%20access%20'
      )
    ).toEqual({ error: 'The user denied access' })
  })

  it('reads an error_description from the fragment', () => {
    expect(
      parseAuthCallback(
        'ask://auth-callback#error=server_error&error_description=Unable+to+exchange'
      )
    ).toEqual({ error: 'Unable to exchange' })
  })

  it('trims a long error_description to 200 characters', () => {
    const long = 'x'.repeat(500)
    expect(
      parseAuthCallback(`ask://auth-callback?error_description=${long}`)
    ).toEqual({ error: 'x'.repeat(200) })
  })

  it.each([
    ['an error without a description', 'ask://auth-callback?error=oops'],
    ['a blank description', 'ask://auth-callback?error_description=%20'],
    ['no code and no error', 'ask://auth-callback'],
    ['an empty code', 'ask://auth-callback?code=']
  ])('says Google sign-in failed for %s', (_label, url) => {
    expect(parseAuthCallback(url)).toEqual({ error: 'Google sign-in failed' })
  })

  it.each([
    ['another host', 'ask://ask?code=abc'],
    ['another scheme', 'https://auth-callback?code=abc'],
    ['a path', 'ask://auth-callback/other?code=abc'],
    ['not a URL', 'not a url']
  ])('ignores %s', (_label, url) => {
    expect(parseAuthCallback(url)).toBeNull()
  })
})

describe('runGoogleSignIn', () => {
  beforeEach(() => {
    browser.finished.length = 0
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // Settle any sign-in a test left waiting, so the next starts clean.
    vi.useRealTimers()
    finishBrowser()
    await settle()
  })

  it('opens Google in the browser and signs in with the returned code', async () => {
    const { auth, client } = fakeClient()
    const { result } = await started(client)

    expect(auth.signInWithOAuth).toHaveBeenCalledExactlyOnceWith({
      provider: 'google',
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true }
    })
    expect(Browser.addListener).toHaveBeenCalledWith(
      'browserFinished',
      expect.any(Function)
    )
    expect(Browser.open).toHaveBeenCalledExactlyOnceWith({ url: GOOGLE_URL })
    expect(googleSignInPending()).toBe(true)

    deliverAuthCallback('ask://auth-callback?code=the-code')
    expect(Browser.close).toHaveBeenCalledTimes(1)

    await expect(result).resolves.toEqual({ outcome: 'signedIn', session })
    expect(auth.exchangeCodeForSession).toHaveBeenCalledExactlyOnceWith(
      'the-code'
    )
    expect(googleSignInPending()).toBe(false)
    expect(browser.remove).toHaveBeenCalledTimes(1)
  })

  it('a closed browser with no callback is a cancel', async () => {
    const { auth, client } = fakeClient()
    const { result } = await started(client)

    finishBrowser()

    await expect(result).resolves.toEqual({ outcome: 'cancelled' })
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(googleSignInPending()).toBe(false)
  })

  it('an error callback fails with its message', async () => {
    const { auth, client } = fakeClient()
    const { result } = await started(client)

    deliverAuthCallback(
      'ask://auth-callback?error=access_denied&error_description=Access+denied'
    )

    await expect(result).resolves.toEqual({
      outcome: 'failed',
      error: 'Access denied'
    })
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(Browser.close).toHaveBeenCalledTimes(1)
  })

  it('the browser closing after the callback does not undo it', async () => {
    const { client } = fakeClient()
    const { result } = await started(client)

    deliverAuthCallback('ask://auth-callback?code=the-code')
    finishBrowser()

    await expect(result).resolves.toMatchObject({ outcome: 'signedIn' })
  })

  it('a rejected Browser.close is swallowed', async () => {
    vi.mocked(Browser.close).mockRejectedValueOnce(new Error('closing'))
    const { client } = fakeClient()
    const { result } = await started(client)

    deliverAuthCallback('ask://auth-callback?code=the-code')

    await expect(result).resolves.toMatchObject({ outcome: 'signedIn' })
  })

  it('times out after three minutes and closes the browser', async () => {
    vi.useFakeTimers()
    const { auth, client } = fakeClient()
    const result = runGoogleSignIn(client)
    await vi.advanceTimersByTimeAsync(0)
    expect(Browser.open).toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(GOOGLE_SIGN_IN_TIMEOUT_MS - 1)
    expect(googleSignInPending()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toEqual({
      outcome: 'failed',
      error: 'Sign-in timed out'
    })
    expect(Browser.close).toHaveBeenCalledTimes(1)
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(GOOGLE_SIGN_IN_TIMEOUT_MS).toBe(3 * 60 * 1000)
  })

  it('ignores a second sign-in while one is pending', async () => {
    const { auth, client } = fakeClient()
    const { result: first } = await started(client)

    await expect(runGoogleSignIn(client)).resolves.toEqual({ outcome: 'busy' })
    expect(auth.signInWithOAuth).toHaveBeenCalledTimes(1)
    expect(Browser.open).toHaveBeenCalledTimes(1)

    deliverAuthCallback('ask://auth-callback?code=the-code')
    await expect(first).resolves.toMatchObject({ outcome: 'signedIn' })
  })

  it('fails when the browser cannot open', async () => {
    vi.mocked(Browser.open).mockRejectedValueOnce(new Error('no browser'))
    const { auth, client } = fakeClient()

    await expect(runGoogleSignIn(client)).resolves.toEqual({
      outcome: 'failed',
      error: "Couldn't open the browser"
    })
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(googleSignInPending()).toBe(false)
    expect(browser.remove).toHaveBeenCalledTimes(1)
  })

  it('throws when Supabase cannot start the sign-in', async () => {
    const { auth, client } = fakeClient()
    const failure = new Error('provider is not enabled')
    auth.signInWithOAuth.mockResolvedValueOnce({
      data: { provider: 'google', url: null },
      error: failure
    } as never)

    await expect(runGoogleSignIn(client)).rejects.toBe(failure)
    expect(Browser.open).not.toHaveBeenCalled()
    expect(googleSignInPending()).toBe(false)
  })

  it('throws when the code exchange fails', async () => {
    const { auth, client } = fakeClient()
    const failure = new Error('invalid flow state')
    auth.exchangeCodeForSession.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: failure
    } as never)
    const { result } = await started(client)

    deliverAuthCallback('ask://auth-callback?code=the-code')

    await expect(result).rejects.toBe(failure)
    expect(googleSignInPending()).toBe(false)
  })

  it('still settles when the browser listener cannot be removed', async () => {
    browser.remove.mockRejectedValueOnce(new Error('gone'))
    const { client } = fakeClient()
    const { result } = await started(client)

    finishBrowser()

    await expect(result).resolves.toEqual({ outcome: 'cancelled' })
    await settle()
  })

  it('throws, and takes no callback, when the browser listener fails', async () => {
    const failure = new Error('no plugin')
    vi.mocked(Browser.addListener).mockRejectedValueOnce(failure)
    const { client } = fakeClient()

    await expect(runGoogleSignIn(client)).rejects.toBe(failure)
    expect(Browser.open).not.toHaveBeenCalled()
    expect(googleSignInPending()).toBe(false)
  })
})

describe('deliverAuthCallback', () => {
  beforeEach(() => {
    browser.finished.length = 0
    vi.clearAllMocks()
  })

  it('ignores, and logs, a callback when no sign-in is pending', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      deliverAuthCallback('ask://auth-callback?code=stale')
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        '[auth] ignored a sign-in callback: no sign-in is under way'
      )
      expect(Browser.close).not.toHaveBeenCalled()
      expect(googleSignInPending()).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('does nothing for a URL that is not a sign-in callback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { auth, client } = fakeClient()
    const { result } = await started(client)
    try {
      deliverAuthCallback('ask://ask?q=hello')
      deliverAuthCallback('ask://ask?code=abc')
      expect(warn).not.toHaveBeenCalled()
      expect(Browser.close).not.toHaveBeenCalled()
      expect(googleSignInPending()).toBe(true)
    } finally {
      warn.mockRestore()
      finishBrowser()
    }
    await expect(result).resolves.toEqual({ outcome: 'cancelled' })
    expect(auth.exchangeCodeForSession).not.toHaveBeenCalled()
  })
})

describe('Google sign-in with the real Supabase client', () => {
  beforeEach(() => {
    browser.finished.length = 0
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the PKCE verifier it stored with the code, and stores the session', async () => {
    const config = {
      apiBaseUrl: 'https://ask.test.invalid',
      supabaseUrl: 'https://supabase.test.invalid',
      supabaseKey: 'sb_publishable_fake'
    }
    const now = Math.floor(Date.now() / 1000)
    const tokenResponse = {
      access_token: 'fake-access-token',
      refresh_token: 'fake-refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: now + 3600,
      user: { id: 'user-1', email: 'user@example.test', aud: 'authenticated' }
    }
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(tokenResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const storage = memoryStorage()
    const client = createSupabase(config, storage)

    const { result } = await started(client)

    const opened = new URL(vi.mocked(Browser.open).mock.calls[0][0].url)
    expect(opened.origin + opened.pathname).toBe(
      'https://supabase.test.invalid/auth/v1/authorize'
    )
    expect(opened.searchParams.get('provider')).toBe('google')
    expect(opened.searchParams.get('redirect_to')).toBe(AUTH_CALLBACK_URL)
    expect(opened.searchParams.get('code_challenge_method')).toBe('s256')
    const verifier = await storage.getItem(`${AUTH_STORAGE_KEY}-code-verifier`)
    expect(verifier).toBeTruthy()

    deliverAuthCallback('ask://auth-callback?code=fake-auth-code')
    await expect(result).resolves.toMatchObject({
      outcome: 'signedIn',
      session: { access_token: 'fake-access-token' }
    })

    const tokenCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/auth/v1/token?grant_type=pkce')
    )
    expect(tokenCall).toBeDefined()
    const body = JSON.parse(String(tokenCall![1]!.body))
    expect(body).toEqual({
      auth_code: 'fake-auth-code',
      code_verifier: JSON.parse(verifier!)
    })
    expect(await storage.getItem(AUTH_STORAGE_KEY)).toContain(
      'fake-access-token'
    )
    await client.auth.stopAutoRefresh()
  })
})
