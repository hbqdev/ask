import { createHmac, timingSafeEqual } from 'node:crypto'

// HMAC-signed, expiring capability URLs for the LOCAL uploads store served by
// app/uploads/[...path]/route.ts. This is the self-hosted analogue of the R2
// presigned URLs in r2-client.ts: uploads live on a local disk volume (not S3),
// so we sign the `/uploads/<objectKey>` path ourselves.
//
// Design (see the 2026-09-10 RAG review, finding #5):
//   - Signature is HMAC-SHA256 over `<objectKey>\n<exp>` — the objectKey ONLY,
//     never the host, because the same file is served on the LAN IP, the public
//     domain, and the cloudflared tunnel (see publicUrlFor in app/api/upload).
//     The objectKey already begins with `<userId>/`, so signing it inherently
//     binds the URL to that owner.
//   - We persist the STABLE object key / relative path (never a baked signed
//     URL) and re-sign at RENDER time (loadChat → signUploadUrlsInMessages), so
//     old chats mint a fresh, short-lived URL on every view and never serve a
//     stale/expired link. Signing is idempotent: any existing exp/sig query is
//     stripped before re-signing.
//   - Enforcement is gated by UPLOADS_REQUIRE_SIGNATURE (default off) so a
//     deploy is non-breaking: legacy unsigned URLs already baked into history
//     keep serving until an operator flips the flag on (by which point every
//     render path re-signs).

function secret(): string {
  return process.env.UPLOADS_URL_SECRET || ''
}

/** Signing is only active when a secret is configured. */
export function isUploadSigningConfigured(): boolean {
  return secret().length > 0
}

/** TTL for a freshly-minted signed URL, in seconds (default 3600). */
export function uploadUrlTtlSeconds(): number {
  const n = Number(process.env.UPLOADS_URL_TTL_S)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3600
}

/**
 * When true (and a secret is configured) the GET route rejects an unsigned,
 * tampered, or expired request. Default false so nothing breaks on deploy.
 */
export function uploadSignatureRequired(): boolean {
  return process.env.UPLOADS_REQUIRE_SIGNATURE === 'true'
}

// The pathname prefix under which every uploaded file is served.
const UPLOADS_PREFIX = '/uploads/'

/**
 * Canonical object key from a `/uploads/<objectKey>` pathname — decoded per
 * segment so it matches what the route derives from Next's already-decoded
 * `params.path` (segments.join('/')). Object keys only ever contain
 * `[a-z0-9./\-_]` after sanitization, so the decode is normally identity; it is
 * applied defensively.
 */
function objectKeyFromPathname(pathname: string): string {
  return pathname
    .slice(UPLOADS_PREFIX.length)
    .split('/')
    .map(seg => {
      try {
        return decodeURIComponent(seg)
      } catch {
        return seg
      }
    })
    .join('/')
}

function computeSignature(objectKey: string, exp: number): string {
  return createHmac('sha256', secret())
    .update(`${objectKey}\n${exp}`)
    .digest('hex')
}

/**
 * Append `?exp=&sig=` to an uploads URL (absolute or root-relative), preserving
 * any `#fragment` (e.g. the `#chunk-N` citation anchors). A non-uploads URL, or
 * one passed when signing is unconfigured, is returned unchanged. Idempotent:
 * a stale exp/sig is stripped and replaced.
 */
export function signUploadUrl(inputUrl: string, ttlSeconds?: number): string {
  if (!isUploadSigningConfigured()) return inputUrl
  if (typeof inputUrl !== 'string' || inputUrl.length === 0) return inputUrl

  const wasRelative = inputUrl.startsWith('/')
  let url: URL
  try {
    // A dummy base lets a root-relative path parse; it is dropped on the way
    // out for a relative input so we never leak the placeholder host.
    url = new URL(inputUrl, 'http://uploads.local')
  } catch {
    return inputUrl
  }
  if (!url.pathname.startsWith(UPLOADS_PREFIX)) return inputUrl

  const objectKey = objectKeyFromPathname(url.pathname)
  const exp =
    Math.floor(Date.now() / 1000) + (ttlSeconds ?? uploadUrlTtlSeconds())

  url.searchParams.delete('exp')
  url.searchParams.delete('sig')
  url.searchParams.set('exp', String(exp))
  url.searchParams.set('sig', computeSignature(objectKey, exp))

  return wasRelative
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString()
}

export type UploadSignatureResult = 'ok' | 'expired' | 'bad'

/**
 * Verify a request's signature for `objectKey`. Checks the HMAC first (so a
 * tampered/absent sig is `bad`, i.e. 403) and only then expiry (a valid but
 * past-deadline sig is `expired`, i.e. 410). Timing-safe comparison.
 */
export function verifyUploadSignature(
  objectKey: string,
  exp: string | null | undefined,
  sig: string | null | undefined
): UploadSignatureResult {
  if (!sig || !exp) return 'bad'
  const expNum = Number(exp)
  if (!Number.isFinite(expNum)) return 'bad'

  const expected = computeSignature(objectKey, expNum)
  const provided = Buffer.from(sig, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return 'bad'
  if (!timingSafeEqual(provided, expectedBuf)) return 'bad'

  if (Math.floor(Date.now() / 1000) > expNum) return 'expired'
  return 'ok'
}

/**
 * Re-sign every `/uploads/…` URL reachable inside a set of persisted messages,
 * so a rendered chat always serves fresh, short-lived links regardless of what
 * (unsigned legacy URL, or a now-stale signed one) is baked in history. Covers:
 *   - user `file` parts (`part.url`)
 *   - the `generateImage` tool output (`part.output.imageUrl`) — both the live
 *     `tool-generateImage` and the reloaded `dynamic-tool` form
 *   - the `documentRetrieval` citation source cards (`part.output.results[].url`)
 * A no-op when signing is unconfigured. Mutates a shallow copy; the input
 * messages are not modified in place.
 */
export function signUploadUrlsInMessages<T extends { parts?: any[] }>(
  messages: T[]
): T[] {
  if (!isUploadSigningConfigured()) return messages
  return messages.map(message => {
    const parts = message.parts
    if (!Array.isArray(parts)) return message
    return {
      ...message,
      parts: parts.map(part => signUploadUrlsInPart(part))
    }
  })
}

function signUploadUrlsInPart(part: any): any {
  if (!part || typeof part !== 'object') return part

  // A user file attachment.
  if (part.type === 'file' && typeof part.url === 'string') {
    return { ...part, url: signUploadUrl(part.url) }
  }

  const output = part.output
  if (output && typeof output === 'object') {
    // A generated-image tool result.
    if (typeof output.imageUrl === 'string') {
      return {
        ...part,
        output: { ...output, imageUrl: signUploadUrl(output.imageUrl) }
      }
    }
    // A documentRetrieval tool result: one { title, url, content } per chunk.
    if (Array.isArray(output.results)) {
      return {
        ...part,
        output: {
          ...output,
          results: output.results.map((r: any) =>
            r && typeof r.url === 'string'
              ? { ...r, url: signUploadUrl(r.url) }
              : r
          )
        }
      }
    }
  }

  return part
}
