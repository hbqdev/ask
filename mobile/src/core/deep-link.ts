// The app's URL scheme: ask://ask?q=<question> hands Ask a question (from a
// Shortcut, a widget or another app). The Ask home puts it in the box for the
// user to send; it never sends by itself (AskHome). iOS delivers
// the URL through the App plugin's appUrlOpen event, which it holds until a
// listener is added, so a link that launched the app still arrives.
//
// ask://auth-callback is Google sign-in coming back (core/auth/oauth). It goes
// only to the sign-in, through useAuthCallbackLink, which the AuthProvider
// keeps for the life of the app; parseAskUrl rejects it, so it never reaches
// the composer.
import { App } from '@capacitor/app'
import { useEffect, useRef } from 'react'

import { deliverAuthCallback } from '@/core/auth/oauth'

/** The longest question a link may carry; the rest is dropped. */
const MAX_QUESTION_CHARS = 2000

/**
 * The question in an ask://ask?q= link, trimmed to 2000 characters, or null
 * for any other URL (another scheme, host or path, or a blank q).
 */
export function parseAskUrl(url: string): { question: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'ask:' || parsed.host !== 'ask') return null
  if (parsed.pathname !== '' && parsed.pathname !== '/') return null
  const question = (parsed.searchParams.get('q') ?? '')
    .trim()
    .slice(0, MAX_QUESTION_CHARS)
  return question ? { question } : null
}

/** Calls onQuestion with the question of each ask:// link the app is opened with. */
export function useAskDeepLink(onQuestion: (question: string) => void) {
  // The latest callback, so the listener is added once.
  const latest = useRef(onQuestion)
  useEffect(() => {
    latest.current = onQuestion
  }, [onQuestion])

  useEffect(() => {
    const handle = App.addListener('appUrlOpen', ({ url }) => {
      const link = parseAskUrl(url)
      if (link) latest.current(link.question)
    })
    return () => {
      void handle.then(h => h.remove())
    }
  }, [])
}

/**
 * Hands each URL the app is opened with to the Google sign-in, which takes
 * its ask://auth-callback and nothing else. Mounted once, signed in or not.
 */
export function useAuthCallbackLink() {
  useEffect(() => {
    const handle = App.addListener('appUrlOpen', ({ url }) =>
      deliverAuthCallback(url)
    )
    return () => {
      void handle.then(h => h.remove())
    }
  }, [])
}
