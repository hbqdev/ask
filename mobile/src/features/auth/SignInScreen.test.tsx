import { Browser } from '@capacitor/browser'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { haptic } from '@/core/haptics'
import { forgotPasswordUrl, SignInScreen } from '@/features/auth/SignInScreen'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))

// Fake values only.
const EMAIL = 'user@example.test'
const PASSWORD = 'fake-password'
// A documentation-range server, so nothing points at a real Ask.
const API = 'http://192.0.2.10:3742'
const RESET = 'http://192.0.2.10:3742/auth/forgot-password'

function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  const auth: Auth = {
    status: 'signedOut',
    session: null,
    error: null,
    signIn: vi.fn(async () => true),
    signInWithGoogle: vi.fn(async () => true),
    signOut: vi.fn(async () => {}),
    getAccessToken: vi.fn(async () => null),
    ...overrides
  }
  vi.mocked(useAuth).mockReturnValue(auth)
  return auth
}

const emailField = () => screen.getByLabelText('Email')
const passwordField = () => screen.getByLabelText('Password')
const signInButton = () => screen.getByRole('button', { name: 'Sign in' })
const googleButton = () =>
  screen.getByRole('button', { name: 'Continue with Google' })

/** A signInWithGoogle that settles when the test says so. */
function pendingGoogle() {
  let finish: (ok: boolean) => void = () => {}
  const signInWithGoogle = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        finish = resolve
      })
  )
  return { signInWithGoogle, finish: (ok: boolean) => finish(ok) }
}

describe('SignInScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the mark, the fields and the button', () => {
    fakeAuth()
    render(<SignInScreen apiBaseUrl={API} />)
    expect(screen.getByTestId('orbit-mark')).toBeInTheDocument()
    expect(emailField()).toHaveAttribute('autocomplete', 'username')
    expect(emailField()).toHaveAttribute('type', 'email')
    expect(emailField()).toHaveAttribute('inputmode', 'email')
    expect(emailField()).toHaveAttribute('autocapitalize', 'off')
    expect(emailField()).toHaveAttribute('autocorrect', 'off')
    expect(passwordField()).toHaveAttribute('autocomplete', 'current-password')
    expect(passwordField()).toHaveAttribute('type', 'password')
    expect(passwordField()).toHaveAttribute('enterkeyhint', 'go')
  })

  it('keeps Sign in disabled until both fields are filled', async () => {
    fakeAuth()
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)
    expect(signInButton()).toBeDisabled()

    await user.type(emailField(), EMAIL)
    expect(signInButton()).toBeDisabled()

    await user.type(passwordField(), PASSWORD)
    expect(signInButton()).toBeEnabled()

    await user.clear(emailField())
    await user.type(emailField(), '   ')
    expect(signInButton()).toBeDisabled()
  })

  it('submitting calls signIn with the email and password', async () => {
    const auth = fakeAuth()
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)

    await user.type(emailField(), ` ${EMAIL} `)
    await user.type(passwordField(), PASSWORD)
    await user.click(signInButton())

    expect(auth.signIn).toHaveBeenCalledWith(EMAIL, PASSWORD)
  })

  it('Enter in the password field submits', async () => {
    const auth = fakeAuth()
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)

    await user.type(emailField(), EMAIL)
    await user.type(passwordField(), `${PASSWORD}{Enter}`)

    expect(auth.signIn).toHaveBeenCalledWith(EMAIL, PASSWORD)
  })

  it('disables Sign in while signing in, and enables it again after', async () => {
    let finish: (ok: boolean) => void = () => {}
    const auth = fakeAuth({
      signIn: vi.fn(
        () =>
          new Promise<boolean>(resolve => {
            finish = resolve
          })
      )
    })
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)

    await user.type(emailField(), EMAIL)
    await user.type(passwordField(), PASSWORD)
    await user.click(signInButton())
    const busy = screen.getByRole('button', { name: 'Signing in…' })
    expect(busy).toBeDisabled()

    // A second submit while busy does nothing.
    fireEvent.submit(busy.closest('form')!)
    expect(auth.signIn).toHaveBeenCalledTimes(1)

    finish(false)
    await waitFor(() => expect(signInButton()).toBeEnabled())
  })

  it('does not submit an empty form', () => {
    const auth = fakeAuth()
    render(<SignInScreen apiBaseUrl={API} />)
    fireEvent.submit(signInButton().closest('form')!)
    expect(auth.signIn).not.toHaveBeenCalled()
  })

  it('shows the sign-in error', () => {
    fakeAuth({ error: 'Invalid email or password' })
    render(<SignInScreen apiBaseUrl={API} />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Invalid email or password'
    )
  })

  it('shows no error box without an error', () => {
    fakeAuth()
    render(<SignInScreen apiBaseUrl={API} />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a notice (such as a deleted account) as a status, not an error', () => {
    fakeAuth({ notice: 'Your account was deleted' })
    render(<SignInScreen apiBaseUrl={API} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your account was deleted'
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows no notice without one', () => {
    fakeAuth({ notice: null })
    render(<SignInScreen apiBaseUrl={API} />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('Forgot password? opens the reset page in the browser', async () => {
    fakeAuth()
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)

    const link = screen.getByRole('link', { name: 'Forgot password?' })
    expect(link).toHaveAttribute('href', RESET)
    await user.click(link)

    expect(Browser.open).toHaveBeenCalledWith({ url: RESET })
  })

  it('builds the reset URL from the configured server', () => {
    expect(forgotPasswordUrl('https://ask.example.test')).toBe(
      'https://ask.example.test/auth/forgot-password'
    )
    expect(forgotPasswordUrl('https://ask.example.test/')).toBe(
      'https://ask.example.test/auth/forgot-password'
    )
  })

  it('says where to go when the browser cannot open', async () => {
    fakeAuth()
    vi.mocked(Browser.open).mockRejectedValueOnce(new Error('no browser'))
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)
    const link = screen.getByRole('link', { name: 'Forgot password?' })

    await user.click(link)
    expect(Browser.open).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('status')).toHaveTextContent(
      "Couldn't open the browser. Visit 192.0.2.10:3742/auth/forgot-password"
    )

    // A later tap that works clears the message.
    await user.click(link)
    expect(Browser.open).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('Continue with Google starts the Google sign-in with a tap haptic', async () => {
    const auth = fakeAuth()
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)

    await user.click(googleButton())

    expect(auth.signInWithGoogle).toHaveBeenCalledTimes(1)
    expect(haptic).toHaveBeenCalledWith('light')
  })

  it('shows the pending state and disables the whole form during the Google sign-in', async () => {
    const google = pendingGoogle()
    fakeAuth({ signInWithGoogle: google.signInWithGoogle })
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)
    await user.type(emailField(), EMAIL)
    await user.type(passwordField(), PASSWORD)

    await user.click(googleButton())

    const busy = screen.getByRole('button', {
      name: 'Signing in with Google…'
    })
    expect(busy).toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(emailField()).toBeDisabled()
    expect(passwordField()).toBeDisabled()
    expect(signInButton()).toBeDisabled()

    // A second tap while pending does nothing.
    await user.click(busy)
    expect(google.signInWithGoogle).toHaveBeenCalledTimes(1)
  })

  it('a cancelled Google sign-in returns to the form with focus on the button', async () => {
    const google = pendingGoogle()
    const auth = fakeAuth({ signInWithGoogle: google.signInWithGoogle })
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)
    await user.type(emailField(), EMAIL)
    await user.type(passwordField(), PASSWORD)
    await user.click(googleButton())
    // The focus leaves the button: WebKit drops it from a button that becomes
    // disabled, and the browser sheet takes it. jsdom does neither, so move
    // it here.
    act(() => screen.getByRole('link', { name: 'Forgot password?' }).focus())

    google.finish(false)

    await waitFor(() => expect(googleButton()).toBeEnabled())
    expect(googleButton()).toHaveFocus()
    expect(emailField()).toBeEnabled()
    expect(passwordField()).toBeEnabled()
    expect(signInButton()).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(auth.signIn).not.toHaveBeenCalled()
  })

  it('a successful Google sign-in leaves the focus alone', async () => {
    const google = pendingGoogle()
    fakeAuth({ signInWithGoogle: google.signInWithGoogle })
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)
    await user.click(googleButton())
    act(() => screen.getByRole('link', { name: 'Forgot password?' }).focus())

    google.finish(true)

    await waitFor(() => expect(googleButton()).toBeEnabled())
    expect(googleButton()).not.toHaveFocus()
  })

  it('shows a Google sign-in error', () => {
    fakeAuth({ error: 'Sign-in timed out' })
    render(<SignInScreen apiBaseUrl={API} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Sign-in timed out')
  })

  it('disables Continue with Google while signing in with a password', async () => {
    const auth = fakeAuth({
      signIn: vi.fn(() => new Promise<boolean>(() => {}))
    })
    const user = userEvent.setup()
    render(<SignInScreen apiBaseUrl={API} />)
    await user.type(emailField(), EMAIL)
    await user.type(passwordField(), PASSWORD)

    await user.click(signInButton())

    expect(googleButton()).toBeDisabled()
    await user.click(googleButton())
    expect(auth.signInWithGoogle).not.toHaveBeenCalled()
  })
})
