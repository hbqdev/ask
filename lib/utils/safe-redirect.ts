// Validate a caller-supplied post-auth redirect target as a SAME-ORIGIN relative
// path. The auth callbacks (/auth/confirm, /auth/oauth) run AFTER the Supabase
// session cookie is set, so an unvalidated `?next=` turns the trusted origin into
// an open-redirect + login-fixation primitive (attacker mints their own OTP,
// links `…/auth/confirm?token_hash=…&next=https://evil.example`, the victim's
// click sets the attacker's session AND 307s to the attacker origin).
//
// Anything that is not a clean site-relative path — an absolute URL
// (`https://evil`), a scheme-relative `//host`, a backslash-smuggled `/\host`
// that browsers resolve cross-origin, or a value carrying control characters —
// falls back to '/'.
export function safeRelativePath(next: string | null | undefined): string {
  if (!next) return '/'
  // Reject control characters (redirect/header smuggling) outright.
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return '/'
  }
  if (next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
    return next
  }
  return '/'
}
