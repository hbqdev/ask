import { NextRequest, NextResponse } from 'next/server'

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { createFileRecord, markFileReady } from '@/lib/db/file-actions'
import { isTextFamily, processFileForRAG } from '@/lib/embeddings/upload-rag'

// Local-only upload store. Self-hosted deploys don't depend on any cloud
// storage — files live in /app/uploads inside the container (ephemeral;
// recreated on `docker compose up -d --force-recreate morphic`).

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024 // 2GB
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'
// Files at or under this size get RAG-indexed inline (fast path) instead of
// waiting on the async ingestion worker — most uploads are small enough
// that the extra round trip through the job queue would only add latency.
const FAST_PATH_MAX_BYTES = 20 * 1024 * 1024 // 20MB

// Broad allowlist: office docs, media, code, and text formats. Extension is
// checked in addition to media type because browsers/clients frequently
// send generic or incorrect content-types (e.g. `application/octet-stream`
// for code files) — requiring both keeps this from being a wildcard filter.
const ALLOWED_MEDIA_PREFIXES = ['image/', 'audio/', 'video/', 'text/']
const ALLOWED_EXACT = new Set([
  'application/pdf',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/epub+zip',
  'application/octet-stream' // code files; gated by extension below
])
const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'txt',
  'md',
  'html',
  'epub',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'flac',
  'mp4',
  'mkv',
  'webm',
  'mov',
  'ts',
  'js',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sh',
  'json',
  'yaml',
  'yml',
  'toml'
])

function isAllowed(mediaType: string, filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!ALLOWED_EXTENSIONS.has(ext)) return false
  return (
    ALLOWED_EXACT.has(mediaType) ||
    ALLOWED_MEDIA_PREFIXES.some(p => mediaType.startsWith(p))
  )
}

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-z0-9.\-_]/gi, '_').toLowerCase()
}

// chatId comes straight from a client-controlled header and is joined
// directly into the on-disk path below — without this, something like
// `x-chat-id: ../../../../etc` would escape UPLOADS_DIR. No dots allowed
// (unlike sanitizeFilename) since a chat id never needs one and disallowing
// it removes any ambiguity around "..".
function sanitizeChatId(chatId: string) {
  return chatId.replace(/[^a-z0-9\-_]/gi, '_')
}

// Build the public URL the LLM and the browser will use to fetch the file.
// Prefer the Host the request came in on so the URL works regardless of
// whether the user is hitting the LAN IP, the public domain, or a tunnel.
function publicUrlFor(req: NextRequest, relativePath: string): string {
  // Strip query strings, force https if the original was https (so mixed
  // http://localhost vs https://ask.hbqnexus.win don't trip the LLM proxy
  // when it's behind a TLS-terminating tunnel).
  const forwardedProto = req.headers.get('x-forwarded-proto')
  const proto =
    forwardedProto ||
    (req.nextUrl.protocol.replace(':', '') as 'http' | 'https') ||
    'http'
  return `${proto}://${req.headers.get('host')}${relativePath}`
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getCurrentUserId()
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const filename = decodeURIComponent(req.headers.get('x-filename') ?? '')
    const rawChatId = req.headers.get('x-chat-id') || null
    const chatId = rawChatId ? sanitizeChatId(rawChatId) : null
    const mediaType =
      req.headers.get('content-type') || 'application/octet-stream'
    if (!filename || !req.body) {
      return NextResponse.json({ error: 'File is required' }, { status: 400 })
    }
    if (!isAllowed(mediaType, filename)) {
      return NextResponse.json(
        { error: 'Unsupported file type' },
        { status: 400 }
      )
    }

    const declaredSize = Number(req.headers.get('content-length') ?? 0)
    if (declaredSize > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: 'File too large (max 2GB)' },
        { status: 400 }
      )
    }

    // Layout: <UPLOADS_DIR>/<userId>/chats/<chatId>/<timestamp>-<sanitized-name>
    // userId-scoped so a user can only access their own files (the static
    // route also checks this). chatId-scoped for easy per-thread debugging.
    const sanitizedName = sanitizeFilename(filename)
    const objectKey = `${userId}/chats/${chatId ?? 'none'}/${Date.now()}-${sanitizedName}`
    const absPath = path.join(UPLOADS_DIR, objectKey)
    await fs.mkdir(path.dirname(absPath), { recursive: true })

    // Stream the body to disk, enforcing the cap as bytes arrive — a 2GB
    // upload must never be buffered in process memory.
    const { createWriteStream } = await import('node:fs')
    const { Readable, Transform } = await import('node:stream')
    const { pipeline } = await import('node:stream/promises')
    let written = 0
    const guard = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length
        if (written > MAX_FILE_SIZE) cb(new Error('too-large'))
        else cb(null, chunk)
      }
    })
    try {
      await pipeline(
        Readable.fromWeb(req.body as any),
        guard,
        createWriteStream(absPath)
      )
    } catch (e) {
      await fs.unlink(absPath).catch(() => {})
      if ((e as Error).message === 'too-large') {
        return NextResponse.json(
          { error: 'File too large (max 2GB)' },
          { status: 400 }
        )
      }
      throw e
    }

    const publicUrl = publicUrlFor(req, `/uploads/${objectKey}`)
    const eligibleForFastPath =
      isTextFamily(mediaType, filename) && written <= FAST_PATH_MAX_BYTES

    let id: string
    try {
      ;({ id } = await createFileRecord({
        userId,
        chatId,
        filename,
        url: publicUrl,
        objectKey,
        mediaType,
        size: written,
        status: 'pending'
      }))
    } catch (e) {
      // Don't leave an orphaned (up to 2GB) file on disk when the row never
      // makes it into the DB.
      await fs.unlink(absPath).catch(() => {})
      throw e
    }

    if (eligibleForFastPath) {
      // Fire-and-forget like today's chunking; typically done in seconds.
      processFileForRAG(absPath, mediaType, filename)
        .then(ok => (ok ? markFileReady(id) : undefined))
        .catch(err => console.error('[upload] fast path failed:', err))
    }

    return NextResponse.json(
      {
        success: true,
        file: {
          id,
          filename,
          url: publicUrl,
          mediaType,
          objectKey,
          status: 'pending',
          type: 'file'
        }
      },
      { status: 200 }
    )
  } catch (err: any) {
    console.error('Upload Error:', err)
    return NextResponse.json(
      { error: 'Upload failed', message: err.message },
      { status: 500 }
    )
  }
}
