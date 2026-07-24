import { NextRequest, NextResponse } from 'next/server'

import { promises as fs } from 'node:fs'
import path from 'node:path'

// Stream a previously-uploaded file from the local uploads volume.
//
// Path layout: /uploads/<userId>/(chats|generated)/<chatId>/<file>
//   - `chats`     — user uploads (see app/api/upload/route.ts)
//   - `generated` — image-generation outputs (see lib/imagegen/persist-image.ts)
// Both share the same capability-URL auth model below.
//
// Auth model: capability URL. The path contains a UUID userId, a UUID chatId,
// and a timestamp+sanitized-filename — the UUIDs are unguessable and the URL
// is only ever shared with the user who uploaded it and the LLM provider that
// has to follow it. This is the only way the LLM provider can fetch the file:
// it pulls the URL from outside the browser, so it can't carry a user cookie.
// Treat the URL as the capability (like an S3 presigned URL) — no session
// check on GET, just path-traversal protection.

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
    // Crude content-type inference from extension — fine for our three
    // supported types (jpeg/png/pdf). If we add more types later, replace
    // with a proper lookup.
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

    // NextResponse's body type wants a typed array, not a Node Buffer —
    // newer @types/node marks Buffer as `Buffer<ArrayBufferLike>` which
    // doesn't fit BodyInit's URLSearchParams-shaped expectations.
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'private, max-age=3600'
      }
    })
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    console.error('Uploads GET error:', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
