import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { processFileForRAG } from '@/lib/embeddings/upload-rag'

// Local-only upload store. Self-hosted deploys don't depend on any cloud
// storage — files live in /app/uploads inside the container (ephemeral;
// recreated on `docker compose up -d --force-recreate morphic`).

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf']
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'

function sanitizeFilename(filename: string) {
  return filename.replace(/[^a-z0-9.\-_]/gi, '_').toLowerCase()
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

    const contentType = req.headers.get('content-type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Invalid content type' },
        { status: 400 }
      )
    }

    const formData = await req.formData()
    const file = formData.get('file') as File
    const chatId = formData.get('chatId') as string
    if (!file) {
      return NextResponse.json({ error: 'File is required' }, { status: 400 })
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: 'File too large (max 10MB)' },
        { status: 400 }
      )
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: 'Unsupported file type' },
        { status: 400 }
      )
    }

    // Layout: <UPLOADS_DIR>/<userId>/<chatId>/<timestamp>-<sanitized-name>
    // userId-scoped so a user can only access their own files (the static
    // route also checks this). chatId-scoped for easy per-thread debugging.
    const sanitizedName = sanitizeFilename(file.name)
    const relativePath = `${userId}/chats/${chatId}/${Date.now()}-${sanitizedName}`
    const absDir = path.join(UPLOADS_DIR, userId, 'chats', chatId)
    const absPath = path.join(UPLOADS_DIR, relativePath)

    await fs.mkdir(absDir, { recursive: true })
    const buffer = Buffer.from(await file.arrayBuffer())
    await fs.writeFile(absPath, buffer)

    // Build RAG index (chunks + embeddings) for text-based files.
    // Runs async — errors are logged but don't fail the upload response.
    processFileForRAG(absPath, file.type, file.name).catch(err =>
      console.error('[upload] RAG processing failed:', err)
    )

    const publicUrl = publicUrlFor(req, `/uploads/${relativePath}`)
    return NextResponse.json(
      {
        success: true,
        file: {
          filename: file.name,
          url: publicUrl,
          mediaType: file.type,
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
