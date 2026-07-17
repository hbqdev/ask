import type { UIMessage } from 'ai'
import { promises as fs } from 'node:fs'
import path from 'node:path'

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
  if (!localPath) return [part]
  if (!(await fileExists(localPath))) return [] // dropped silently

  const filename = part.filename || path.basename(localPath)

  // ── PDF — RAG retrieval ───────────────────────────────────────────────────
  if (part.mediaType === 'application/pdf') {
    const query = userQuery || filename

    // Try RAG first (chunks.json produced at upload time)
    const result = await queryFileChunks(localPath, query, 10)
    if (result) {
      const context = result.chunks.join('\n\n---\n\n')
      return [
        {
          type: 'text',
          text: `[Attached document: ${filename}]\n\nRelevant excerpts:\n\n${context}`
        }
      ]
    }

    // Fallback: extract full text (handles files uploaded before RAG was added,
    // or if chunking/embedding hasn't finished yet)
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

  // ── Image — base64 encode ────────────────────────────────────────────────
  if (part.mediaType?.startsWith('image/')) {
    try {
      const buf = await fs.readFile(localPath)
      return [
        {
          ...part,
          url: `data:${part.mediaType};base64,${buf.toString('base64')}`
        }
      ]
    } catch {
      return []
    }
  }

  return [] // unsupported type
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
