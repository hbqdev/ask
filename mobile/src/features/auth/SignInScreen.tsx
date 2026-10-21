import { Browser } from '@capacitor/browser'
import { useState, type FormEvent, type MouseEvent } from 'react'

import { useAuth } from '@/core/auth/AuthProvider'
import { OrbitMark } from '@/core/ui/OrbitMark'

/** Ask's web reset flow; the app has no password reset of its own. */
export const FORGOT_PASSWORD_URL =
  'https://ask.hbqnexus.win/auth/forgot-password'

// 16px text keeps iOS from zooming into a focused field.
const FIELD =
  'h-12 w-full rounded-xl border border-foreground/15 bg-foreground/5 px-4 text-base text-foreground outline-none placeholder:text-foreground/40 focus:border-mark-blue'

/** Email and password sign-in, the only way into the app. */
export function SignInScreen() {
  const { signIn, error } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [browserFailed, setBrowserFailed] = useState(false)

  const trimmedEmail = email.trim()
  const canSubmit = trimmedEmail !== '' && password !== '' && !submitting

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    // On success the shell swaps this screen out; on failure useAuth().error
    // says why.
    await signIn(trimmedEmail, password)
    setSubmitting(false)
  }

  function openForgotPassword(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    setBrowserFailed(false)
    // If the browser cannot open, say where to go instead.
    Browser.open({ url: FORGOT_PASSWORD_URL }).catch(() =>
      setBrowserFailed(true)
    )
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="flex w-full max-w-sm flex-col items-center">
        <OrbitMark className="size-20" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">
          Sign in to Ask
        </h1>

        <form
          className="mt-8 flex w-full flex-col gap-3"
          onSubmit={onSubmit}
          noValidate
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground/70">Email</span>
            <input
              type="email"
              name="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="username"
              inputMode="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="next"
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground/70">
              Password
            </span>
            <input
              type="password"
              name="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              enterKeyHint="go"
              className={FIELD}
            />
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-xl bg-mark-orange/15 px-4 py-3 text-sm text-foreground"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-2 h-12 w-full touch-manipulation rounded-xl bg-mark-blue text-base font-semibold text-white active:opacity-80 disabled:opacity-40"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <a
          href={FORGOT_PASSWORD_URL}
          onClick={openForgotPassword}
          className="mt-4 flex min-h-11 items-center px-3 text-sm font-medium text-mark-blue active:opacity-50"
        >
          Forgot password?
        </a>
        {browserFailed && (
          <p role="status" className="text-center text-sm text-foreground/60">
            Couldn't open the browser. Visit
            ask.hbqnexus.win/auth/forgot-password
          </p>
        )}
      </div>
    </main>
  )
}
