import { Browser } from '@capacitor/browser'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import {
  FORGOT_PASSWORD_URL,
  SignInScreen
} from '@/features/auth/SignInScreen'

vi.mock('@capacitor/browser', () => ({
  Browser: { open: vi.fn(async () => {}) }
}))

vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))

// Fake values only.
const EMAIL = 'user@example.test'
const PASSWORD = 'fake-password'

function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  const auth: Auth = {
    status: 'signedOut',
    session: null,
    error: null,
    signIn: vi.fn(async () => true),
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

describe('SignInScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the mark, the fields and the button', () => {
    fakeAuth()
    render(<SignInScreen />)
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
    render(<SignInScreen />)
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
    render(<SignInScreen />)

    await user.type(emailField(), ` ${EMAIL} `)
    await user.type(passwordField(), PASSWORD)
    await user.click(signInButton())

    expect(auth.signIn).toHaveBeenCalledWith(EMAIL, PASSWORD)
  })

  it('Enter in the password field submits', async () => {
    const auth = fakeAuth()
    const user = userEvent.setup()
    render(<SignInScreen />)

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
    render(<SignInScreen />)

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
    render(<SignInScreen />)
    fireEvent.submit(signInButton().closest('form')!)
    expect(auth.signIn).not.toHaveBeenCalled()
  })

  it('shows the sign-in error', () => {
    fakeAuth({ error: 'Invalid email or password' })
    render(<SignInScreen />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Invalid email or password'
    )
  })

  it('shows no error box without an error', () => {
    fakeAuth()
    render(<SignInScreen />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Forgot password? opens the reset page in the browser', async () => {
    fakeAuth()
    const user = userEvent.setup()
    render(<SignInScreen />)

    const link = screen.getByRole('link', { name: 'Forgot password?' })
    expect(link).toHaveAttribute('href', FORGOT_PASSWORD_URL)
    await user.click(link)

    expect(FORGOT_PASSWORD_URL).toBe(
      'https://ask.hbqnexus.win/auth/forgot-password'
    )
    expect(Browser.open).toHaveBeenCalledWith({ url: FORGOT_PASSWORD_URL })
  })

  it('stays put when the browser cannot open', async () => {
    fakeAuth()
    vi.mocked(Browser.open).mockRejectedValueOnce(new Error('no browser'))
    const user = userEvent.setup()
    render(<SignInScreen />)

    await user.click(screen.getByRole('link', { name: 'Forgot password?' }))
    expect(Browser.open).toHaveBeenCalledTimes(1)
    expect(emailField()).toBeInTheDocument()
  })
})
