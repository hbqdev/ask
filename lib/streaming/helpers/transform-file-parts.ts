import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { UIMessage } from 'ai'

const execFileAsync = promisify(execFile)
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'
// Cap scanned-PDF rendering at 5 pages to keep image payload reasonable
const MAX_SCANNED_PAGES = 5

function urlToLocalPath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!parsed.pathname.startsWith('/uploads/')) return null
    const relative = parsed.pathname.slice('/uploads/'.length)
    const resolved = path.join(UPLOADS_DIR, relative)
    // Guard against path traversal
    if (!resolved.startsWith(UPLOADS_DIR + path.sep) && resolved !== UPLOADS_DIR) {
      return null
    }
    return resolved
  } catch {
    return null
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

// Uses poppler pdftotext: preserves columns, spacing, and reading order
async function extractPdfText(filePath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'pdftotext',
    ['-layout', '-enc', 'UTF-8', filePath, '-'],
    { maxBuffer: 10 * 1024 * 1024 }
  )
  return stdout
}

// Uses poppler pdftoppm: renders PDF pages to PNG images
// Returns base64-encoded PNG buffers, capped at MAX_SCANNED_PAGES
async function renderPdfPages(
  filePath: string
): Promise<{ data: string; mediaType: 'image/png' }[]> {
  const tmpDir = path.join(os.tmpdir(), `pdf-${randomUUID()}`)
  await fs.mkdir(tmpDir, { recursive: true })
  const prefix = path.join(tmpDir, 'page')

  try {
    await execFileAsync('pdftoppm', [
      '-png',
      '-r', '150',
      '-l', String(MAX_SCANNED_PAGES),
      filePath,
      prefix
    ])

    const entries = await fs.readdir(tmpDir)
    const pngFiles = entries.filter(f => f.endsWith('.png')).sort()

    return await Promise.all(
      pngFiles.map(async filename => {
        const buf = await fs.readFile(path.join(tmpDir, filename))
        return { data: buf.toString('base64'), mediaType: 'image/png' as const }
      })
    )
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// Transforms a single part. Returns an array because a scanned PDF
// expands into [textPart, ...imageParts].
async function transformPart(part: any): Promise<any[]> {
  if (part.type !== 'file') return [part]

  const localPath = urlToLocalPath(part.url)
  if (!localPath) return [part] // not a local upload — pass through unchanged

  if (!(await fileExists(localPath))) {
    // File is gone (container recreated, ephemeral volume cleared) — drop silently
    return []
  }

  const filename = part.filename || path.basename(localPath)

  // ── PDF ──────────────────────────────────────────────────────────────────
  if (part.mediaType === 'application/pdf') {
    try {
      const text = await extractPdfText(localPath)
      const trimmed = text.trim()

      if (trimmed.length > 50) {
        // Normal text-layer PDF
        return [{ type: 'text', text: `[Attached document: ${filename}]\n\n${trimmed}` }]
      }

      // Scanned / image-only PDF — render pages and let the model vision-read them
      const pages = await renderPdfPages(localPath)
      if (pages.length === 0) {
        return [{
          type: 'text',
          text: `[Attached document: ${filename}]\n\n(This PDF appears to be empty or unreadable.)`
        }]
      }

      const note = pages.length === MAX_SCANNED_PAGES ? ` (first ${MAX_SCANNED_PAGES} pages)` : ''
      return [
        { type: 'text', text: `[Attached document: ${filename}${note}]` },
        ...pages.map(p => ({
          type: 'file',
          url: `data:${p.mediaType};base64,${p.data}`,
          mediaType: p.mediaType
        }))
      ]
    } catch (err) {
      console.error(`[transform-file-parts] Failed to process ${filename}:`, err)
      return [{
        type: 'text',
        text: `[Attached document: ${filename}]\n\n(Could not extract content from this PDF.)`
      }]
    }
  }

  // ── Image ─────────────────────────────────────────────────────────────────
  if (part.mediaType?.startsWith('image/')) {
    try {
      const buf = await fs.readFile(localPath)
      return [{ ...part, url: `data:${part.mediaType};base64,${buf.toString('base64')}` }]
    } catch {
      return []
    }
  }

  // Unsupported type — drop
  return []
}

export async function transformFileParts(messages: UIMessage[]): Promise<UIMessage[]> {
  return Promise.all(
    messages.map(async msg => {
      if (msg.role !== 'user') return msg

      const parts = (msg.parts ?? []) as any[]
      if (!parts.some((p: any) => p.type === 'file')) return msg

      const transformed = await Promise.all(parts.map(transformPart))
      const flat = transformed.flat()

      // Merge consecutive text parts into one. The openai-compatible provider
      // rejects content:[{type:"text"},{type:"text"}] (array); it only accepts
      // content:"string". A single text part collapses to string format in the SDK.
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
