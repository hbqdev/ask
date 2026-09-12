import { NextRequest, NextResponse } from 'next/server'

import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  isUploadSigningConfigured,
  uploadSignatureRequired,
  verifyUploadSignature
} from '@/lib/storage/upload-url-signing'

// Stream a previously-uploaded file from the local uploads volume.
//
// Path layout: /uploads/<userId>/(chats|generated)/<chatId>/<file>
//   - `chats`     — user uploads (see app/api/upload/route.ts)
//   - `generated` — image-generation outputs (see lib/imagegen/persist-image.ts)
// Both share the same capability-URL auth model below.
//
// Auth model: signed capability URL. The path contains a UUID userId, a UUID
// chatId, and a timestamp+sanitized-filename, and the query carries an HMAC
// signature + expiry minted by lib/storage/upload-url-signing.ts. When
// UPLOADS_REQUIRE_SIGNATURE is on (and a secret is configured) a request with a
// missing/tampered signature is rejected (403) and an expired one is rejected
// (410) — a leaked or old link stops working. The only consumer is the browser
// (a same-origin <img>/<a>): the LLM provider never fetches these URLs — vision
// images are inlined as base64 data URIs and documents are read from disk in
// lib/streaming/helpers/transform-file-parts.ts. Persisted history stores the
// stable path and is re-signed at render time (loadChat), so old chats mint a
// fresh short-lived URL on every view rather than serving a baked, expiring one.
// The flag defaults off so a deploy keeps serving legacy unsigned URLs until an
// operator flips it on. Path-traversal protection is always enforced.

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: segments } = await params

  // Defensive: at minimum we need <userId>/(chats|generated)/<chatId>/<file>
  if (!segments || segments.length < 4) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const [pathUserId, ...rest] = segments
  if (rest[0] !== 'chats' && rest[0] !== 'generated') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Signed-capability check. Only enforced when the operator has opted in AND a
  // signing secret is configured — otherwise serve as before (legacy unsigned
  // URLs baked in older chats keep working). The signed objectKey is exactly
  // the decoded path segments the route resolves below.
  if (uploadSignatureRequired() && isUploadSigningConfigured()) {
    const objectKey = segments.join('/')
    const result = verifyUploadSignature(
      objectKey,
      req.nextUrl.searchParams.get('exp'),
      req.nextUrl.searchParams.get('sig')
    )
    if (result === 'expired') {
      return NextResponse.json({ error: 'Link expired' }, { status: 410 })
    }
    if (result !== 'ok') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // Resolve to an absolute path and reject anything that escapes UPLOADS_DIR
  // (the `[...path]` catch-all will accept things like `../../etc/passwd`).
  const absPath = path.resolve(UPLOADS_DIR, ...segments)
  const uploadsReal = await fs.realpath(UPLOADS_DIR).catch(() => UPLOADS_DIR)
  if (!absPath.startsWith(uploadsReal + path.sep)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const stat = await fs.stat(absPath)
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const data = await fs.readFile(absPath)
    // Crude content-type inference from extension — covers the types we store
    // (png/jpg/webp/svg/pdf); anything else falls back to octet-stream.
    const ext = path.extname(absPath).toLowerCase()
    const contentType =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.svg'
              ? 'image/svg+xml'
              : ext === '.pdf'
                ? 'application/pdf'
                : 'application/octet-stream'

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Cache-Control': 'private, max-age=3600',
      // Never let the browser MIME-sniff a served file into something
      // executable — honor the Content-Type we set above.
      'X-Content-Type-Options': 'nosniff'
    }
    if (ext === '.svg') {
      // The image card links outputs with target=_blank, so an SVG opened via
      // top-level navigation renders as a document and would run any embedded
      // <script> same-origin. A sandbox CSP neutralizes that script execution
      // (it's irrelevant to <img> rendering, which never runs SVG scripts).
      headers['Content-Security-Policy'] = 'sandbox'
    }

    // NextResponse's body type wants a typed array, not a Node Buffer —
    // newer @types/node marks Buffer as `Buffer<ArrayBufferLike>` which
    // doesn't fit BodyInit's URLSearchParams-shaped expectations.
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers
    })
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    console.error('Uploads GET error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
