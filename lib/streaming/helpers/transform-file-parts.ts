import type { UIMessage } from 'ai'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { findFileByObjectKey } from '@/lib/db/file-actions'
import { queryFileChunks } from '@/lib/embeddings/upload-rag'

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'

// Single `new URL` parse shared by both derived values — localPath (for disk
// I/O) and objectKey (for the DB lookup) always agree because they come from
// the same parse, and a malformed/non-upload URL yields both as null.
function resolveUploadUrl(
  url: string
): { localPath: string; objectKey: string } | null {
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.startsWith('/uploads/')) return null
    const relative = parsed.pathname.slice('/uploads/'.length)
    const resolved = path.join(UPLOADS_DIR, relative)
    if (
      !resolved.startsWith(UPLOADS_DIR + path.sep) &&
      resolved !== UPLOADS_DIR
    )
      return null
    return { localPath: resolved, objectKey: decodeURIComponent(relative) }
  } catch {
    return null
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// Extract the plain text from the most recent user turn's text parts.
// Used as the RAG query when a file is also attached to that message.
function extractUserQuery(parts: any[]): string {
  return parts
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.text ?? '')
    .join(' ')
    .trim()
}

async function transformPart(
  part: any,
  userQuery: string,
  modelHasVision: boolean
): Promise<any[]> {
  if (part.type !== 'file') return [part]

  const resolved = resolveUploadUrl(part.url)
  if (!resolved) return [part]
  const { localPath, objectKey } = resolved
  const filename = part.filename || path.basename(localPath)

  // A transient DB error here must not fail the whole turn — every other
  // I/O step in this function already degrades gracefully (fileExists,
  // queryFileChunks, the base64 read, pdftotext all swallow their errors).
  // Falling back to "ready, no row" means the attachment still renders from
  // disk/chunks instead of 500ing every past message that has a file part.
  let row: Awaited<ReturnType<typeof findFileByObjectKey>> = null
  try {
    row = await findFileByObjectKey(objectKey)
  } catch (err) {
    console.warn(
      '[transform-file-parts] findFileByObjectKey failed, treating as ready:',
      err
    )
  }
  const status = row?.status ?? 'ready' // pre-feature files (or a lookup error) have no row

  if (status === 'pending' || status === 'processing') {
    const stage = row?.ingestStage || 'queued'
    return [
      {
        type: 'text',
        text: `[Attached file: ${filename} — still being processed (${stage}). Its content is not available yet; tell the user to ask again shortly.]`
      }
    ]
  }
  if (status === 'failed') {
    return [
      {
        type: 'text',
        text: `[Attached file: ${filename} — processing failed: ${row?.ingestError ?? 'unknown error'}.]`
      }
    ]
  }

  if (!(await fileExists(localPath)))
    return [
      {
        type: 'text',
        text: `[Attached file: ${filename} — file is no longer available.]`
      }
    ]

  const query = userQuery || filename
  const result = await queryFileChunks(localPath, query, 10)

  // ── Image ─────────────────────────────────────────────────────────────────
  // Vision-capable models get the raw image (their own vision, preferred);
  // every other model gets ONLY the VLM-extracted text. Sending the base64
  // to a text-only model makes the provider reject the whole turn, so it is
  // strictly gated on modelHasVision.
  if (part.mediaType?.startsWith('image/')) {
    const out: any[] = []
    if (result) {
      out.push({
        type: 'text',
        text: `[Attached image: ${filename}]\n\nExtracted content:\n\n${result.chunks.join('\n\n---\n\n')}`
      })
    }
    if (modelHasVision) {
      try {
        const buf = await fs.readFile(localPath)
        out.push({
          ...part,
          url: `data:${part.mediaType};base64,${buf.toString('base64')}`
        })
      } catch {
        /* keep whatever text we already have */
      }
    }
    if (out.length === 0) {
      // Non-vision model with no extracted text (VLM chunking failed / not
      // ready): an honest note beats silently dropping the attachment.
      return [
        {
          type: 'text',
          text: `[Attached image: ${filename} — no extractable text is available and the selected model cannot view images.]`
        }
      ]
    }
    return out
  }

  if (result) {
    const context = result.chunks.join('\n\n---\n\n')
    return [
      {
        type: 'text',
        text: `[Attached document: ${filename}]\n\nRelevant excerpts:\n\n${context}`
      }
    ]
  }

  // Ready but no chunks (pre-feature upload, or chunking failed). PDFs get
  // the pdftotext full-text fallback that predates the RAG pipeline; every
  // other type gets an honest note instead of the old silent drop.
  if (part.mediaType === 'application/pdf') {
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const { stdout } = await execFileAsync(
        'pdftotext',
        ['-layout', '-enc', 'UTF-8', localPath, '-'],
        { maxBuffer: 10 * 1024 * 1024 }
      )
      const text = stdout.trim()
      if (text.length > 50) {
        return [
          { type: 'text', text: `[Attached document: ${filename}]\n\n${text}` }
        ]
      }
    } catch {
      /* fall through */
    }

    return [
      {
        type: 'text',
        text: `[Attached document: ${filename}]\n\n(Could not extract content.)`
      }
    ]
  }

  return [
    {
      type: 'text',
      text: `[Attached file: ${filename}]\n\n(Could not extract content.)`
    }
  ]
}

export async function transformFileParts(
  messages: UIMessage[],
  opts?: { modelHasVision?: boolean }
): Promise<UIMessage[]> {
  const modelHasVision = opts?.modelHasVision ?? false
  return Promise.all(
    messages.map(async msg => {
      if (msg.role !== 'user') return msg

      const parts = (msg.parts ?? []) as any[]
      if (!parts.some((p: any) => p.type === 'file')) return msg

      const userQuery = extractUserQuery(parts)
      const transformed = await Promise.all(
        parts.map(p => transformPart(p, userQuery, modelHasVision))
      )
      const flat = transformed.flat()

      // Merge consecutive text parts — openai-compatible provider rejects arrays of text parts
      const merged: any[] = []
      for (const part of flat) {
        const last = merged[merged.length - 1]
        if (part.type === 'text' && last?.type === 'text') {
          last.text = last.text + '\n\n' + part.text
        } else {
          merged.push({ ...part })
        }
      }

      return { ...msg, parts: merged } as UIMessage
    })
  )
}
