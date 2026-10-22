import { Browser } from '@capacitor/browser'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent
} from 'react'
import { flushSync } from 'react-dom'

import { useAuth } from '@/core/auth/AuthProvider'
import { haptic } from '@/core/haptics'
import { OrbitMark } from '@/core/ui/OrbitMark'

/**
 * Ask's web reset flow on the server the app talks to; the app has no
 * password reset of its own.
 */
export function forgotPasswordUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}/auth/forgot-password`
}

// The field's text follows Dynamic Type (text-base is 14px at the smallest
// sizes); the viewport's maximum-scale=1 (index.html) is what keeps iOS from
// zooming into a focused field, so don't pin it to 16px.
const FIELD =
  'h-12 w-full rounded-xl border border-foreground/15 bg-foreground/5 px-4 text-base text-foreground outline-none placeholder:text-muted-foreground focus:border-mark-blue'

// Google's "G" in its own colours, as its sign-in branding asks.
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

/** Sign-in with Google, or with an email and password. */
export function SignInScreen({ apiBaseUrl }: { apiBaseUrl: string }) {
  const { signIn, signInWithGoogle, error, notice } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [googlePending, setGooglePending] = useState(false)
  const [browserFailed, setBrowserFailed] = useState(false)
  const googleButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const noticeLine = useRef<HTMLParagraphElement>(null)
  const arriving = useRef(true)

  // Arriving here (an app start, a sign-out the user did not ask for), focus
  // goes to why, so VoiceOver reads it: the notice, else the heading. A
  // notice that comes while the screen is up takes it too.
  useEffect(() => {
    const target = notice
      ? noticeLine.current
      : arriving.current
        ? heading.current
        : null
    arriving.current = false
    target?.focus({ preventScroll: true })
  }, [notice])

  const resetUrl = forgotPasswordUrl(apiBaseUrl)
  // Shown when the browser cannot open: the same page, without the scheme.
  const resetHint = resetUrl.replace(/^[a-z]+:\/\//i, '')

  const trimmedEmail = email.trim()
  const canSubmit =
    trimmedEmail !== '' && password !== '' && !submitting && !googlePending

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    // On success the shell swaps this screen out; on failure useAuth().error
    // says why.
    await signIn(trimmedEmail, password)
    setSubmitting(false)
  }

  async function continueWithGoogle() {
    haptic('light')
    setGooglePending(true)
    // On success the shell swaps this screen out; a failure shows
    // useAuth().error, and a cancel just returns here.
    const ok = await signInWithGoogle()
    // Rendered at once, so the button is enabled again before it is focused.
    flushSync(() => setGooglePending(false))
    // Disabling the button (and the browser sheet) took the focus; give it
    // back.
    if (!ok) googleButton.current?.focus()
  }

  function openForgotPassword(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    setBrowserFailed(false)
    // If the browser cannot open, say where to go instead.
    Browser.open({ url: resetUrl }).catch(() => setBrowserFailed(true))
  }

  return (
    // No tab bar here: the screen clears the home indicator itself (on the
    // main, so the form's own padding inside it adds to the inset).
    <main className="safe-bottom flex flex-1 flex-col items-center justify-center overflow-y-auto px-6">
      <div className="flex w-full max-w-sm flex-col items-center py-10">
        <OrbitMark className="size-20" />
        <h1
          ref={heading}
          tabIndex={-1}
          className="mt-6 text-2xl font-semibold tracking-tight"
        >
          Sign in to Ask
        </h1>
        {notice && (
          <p
            ref={noticeLine}
            role="status"
            tabIndex={-1}
            className="mt-4 w-full outline-none rounded-xl bg-foreground/5 px-4 py-3 text-center text-sm text-foreground/70"
          >
            {notice}
          </p>
        )}

        <button
          ref={googleButton}
          type="button"
          onClick={continueWithGoogle}
          disabled={googlePending || submitting}
          aria-busy={googlePending}
          className="mt-8 flex h-12 w-full touch-manipulation items-center justify-center gap-3 rounded-xl border border-foreground/15 bg-foreground/5 text-base font-semibold text-foreground active:opacity-80 disabled:opacity-40"
        >
          <GoogleMark />
          {googlePending ? 'Signing in with Google…' : 'Continue with Google'}
        </button>

        <div
          className="mt-6 flex w-full items-center gap-3 text-sm text-foreground/60"
          aria-hidden="true"
        >
          <span className="h-px flex-1 bg-foreground/15" />
          or
          <span className="h-px flex-1 bg-foreground/15" />
        </div>

        <form
          className="mt-6 flex w-full flex-col gap-3"
          onSubmit={onSubmit}
          noValidate
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-foreground/70">
              Email
            </span>
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
              disabled={googlePending}
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
              disabled={googlePending}
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
            className="mt-2 h-12 w-full touch-manipulation rounded-xl bg-accent-fill text-base font-semibold text-white active:opacity-80 disabled:opacity-40"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <a
          href={resetUrl}
          onClick={openForgotPassword}
          className="mt-4 flex min-h-11 items-center px-3 text-sm font-medium text-accent active:opacity-50"
        >
          Forgot password?
        </a>
        {browserFailed && (
          <p role="status" className="text-center text-sm text-foreground/60">
            Couldn't open the browser. Visit {resetHint}
          </p>
        )}
      </div>
    </main>
  )
}
