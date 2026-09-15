/**
 * Normalize a user- or provider-supplied URL to a safe http(s) URL, or return
 * null if the scheme is not allowed. Prevents XSS via javascript:/data: URLs
 * reaching a clickable href / window.open sink.
 */
export const sanitizeHttpUrl = (
  raw: string | undefined | null
): string | null => {
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString()
    }
    return null
  } catch {
    return null
  }
}

/**
 * Best-effort hostname/pathname for a URL, empty strings when it can't be
 * parsed. Lets a render path show a hostname without a malformed provider URL
 * throwing during render.
 */
export const safeUrlParts = (
  raw: string | undefined | null
): { hostname: string; pathname: string } => {
  if (!raw) return { hostname: '', pathname: '' }
  try {
    const u = new URL(raw)
    return { hostname: u.hostname, pathname: u.pathname }
  } catch {
    return { hostname: '', pathname: '' }
  }
}
