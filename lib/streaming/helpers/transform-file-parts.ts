import type { UIMessage } from 'ai'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { findFileByObjectKey } from '@/lib/db/file-actions'
import { queryFileChunks } from '@/lib/embeddings/upload-rag'

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'

function urlToLocalPath(url: string): string | null {
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
    return resolved
  } catch {
    return null
  }
}

function objectKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.startsWith('/uploads/')) return null
    return decodeURIComponent(parsed.pathname.slice('/uploads/'.length))
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

async function transformPart(part: any, userQuery: string): Promise<any[]> {
  if (part.type !== 'file') return [part]

  const localPath = urlToLocalPath(part.url)
  const objectKey = objectKeyFromUrl(part.url)
  if (!localPath || !objectKey) return [part]
  const filename = part.filename || path.basename(localPath)

  const row = await findFileByObjectKey(objectKey)
  const status = row?.status ?? 'ready' // pre-feature files have no row

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

  // ── Image — extracted text (if any) plus base64 pass-through ──────────────
  if (part.mediaType?.startsWith('image/')) {
    const out: any[] = []
    if (result) {
      out.push({
        type: 'text',
        text: `[Attached image: ${filename}]\n\nExtracted content:\n\n${result.chunks.join('\n\n---\n\n')}`
      })
    }
    try {
      const buf = await fs.readFile(localPath)
      out.push({
        ...part,
        url: `data:${part.mediaType};base64,${buf.toString('base64')}`
      })
    } catch {
      /* keep whatever text we already have */
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
  messages: UIMessage[]
): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async msg => {
      if (msg.role !== 'user') return msg

      const parts = (msg.parts ?? []) as any[]
      if (!parts.some((p: any) => p.type === 'file')) return msg

      const userQuery = extractUserQuery(parts)
      const transformed = await Promise.all(
        parts.map(p => transformPart(p, userQuery))
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
