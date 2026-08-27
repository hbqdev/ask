import type { UIMessage } from 'ai'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { findFileByObjectKey } from '@/lib/db/file-actions'
import { queryFileChunks } from '@/lib/embeddings/upload-rag'

import {
  type DocumentRetrievalInput,
  documentSourceId
} from './document-retrieval-part'

const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads'

// Single `new URL` parse shared by both derived values — localPath (for disk
// I/O) and objectKey (for the DB lookup) always agree because they come from
// the same parse, and a malformed/non-upload URL yields both as null.
export function resolveUploadUrl(
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

// Bounded server-side wait so the FIRST reply sees ingested content instead of
// telling the user "still being processed, ask again." Re-polls the file row
// until it leaves pending/processing (reaches ready/failed/expired) or the
// deadline passes; returns the most recent row (possibly still pending on
// timeout). Scoped by the caller to the non-vision/document path only — a
// vision-capable model renders an image's pixels immediately and never waits.
// Bounds are read from env at call time (so tests can override them):
//   INGEST_WAIT_TIMEOUT_MS (default 120000) — timeoutMs <= 0 skips polling
//   INGEST_WAIT_POLL_MS    (default 1500)
async function waitForIngestReady(
  objectKey: string,
  currentRow: Awaited<ReturnType<typeof findFileByObjectKey>>
): Promise<Awaited<ReturnType<typeof findFileByObjectKey>>> {
  const timeoutMs = Number(process.env.INGEST_WAIT_TIMEOUT_MS ?? 120000)
  const pollMs = Number(process.env.INGEST_WAIT_POLL_MS ?? 1500)
  if (timeoutMs <= 0) return currentRow

  let row = currentRow
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs))
    try {
      const next = await findFileByObjectKey(objectKey)
      row = next
      const status = next?.status
      if (status !== 'pending' && status !== 'processing') return row
    } catch {
      // A transient lookup failure must not abort the wait — keep polling and
      // fall back to the last good row on timeout.
    }
  }
  return row
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
  modelHasVision: boolean,
  userId?: string,
  // When provided, ranked chunks for a ready NON-image document are pushed here
  // (as a citable `documentRetrieval` source) instead of being injected inline
  // as plain "Relevant excerpts" text — the streaming layer assembles them into
  // a synthetic, citable tool result. See create-chat-stream-response.ts.
  documentSink?: DocumentRetrievalInput[]
): Promise<any[]> {
  if (part.type !== 'file') return [part]

  const resolved = resolveUploadUrl(part.url)
  if (!resolved) return [part]
  const { localPath, objectKey } = resolved
  const filename = part.filename || path.basename(localPath)

  // User-scope guard (security). Object keys are
  // `<userId>/chats/<chatId>/<ts>-<name>`, so the first path segment is the
  // owning user. `url` is client-supplied, so without this an attacker could
  // reference `/uploads/<victimUserId>/…` and get the victim's extracted text
  // injected. Reject a foreign objectKey up front — do NOT read the file or DB
  // for a key that isn't the requester's.
  if (userId && objectKey.split('/')[0] !== userId) {
    return [
      { type: 'text', text: `[Attached file: ${filename} — not accessible.]` }
    ]
  }

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
  let status = row?.status ?? 'ready' // pre-feature files (or a lookup error) have no row

  // An expired file has been tombstoned by the TTL sweep: its bytes and chunks
  // are gone from disk, so there is nothing to render for ANY model (vision
  // included). Return the re-upload note here, before the vision/base64 and
  // pending/failed gates, so we never read the (missing) file or query chunks.
  if (status === 'expired') {
    const days = Number(process.env.UPLOAD_TTL_DAYS ?? 14)
    return [
      {
        type: 'text',
        text: `[Attached file: ${filename} — this upload expired after ${days} days of chat inactivity and is no longer available. Tell the user to re-upload it to ask about it again.]`
      }
    ]
  }

  // A vision-capable model can render an image's pixels immediately — the
  // base64 needs no ingestion — so the pending/processing/failed gates below
  // (which exist to avoid handing back not-yet-extracted, or unextractable,
  // TEXT) must NOT short-circuit it. Extracted-text augmentation is still only
  // added once chunks are ready (see the image branch). Non-vision models need
  // the VLM text, so they keep the gates.
  const isImage = !!part.mediaType?.startsWith('image/')
  const visionImage = isImage && modelHasVision

  if (!visionImage) {
    // Ingest is the content source on this path (non-vision model, or any
    // document), so give the first turn a bounded chance to see the extracted
    // text before falling back to the "ask again" note. Env-tunable; a
    // vision+image already rendered its pixels above and never reaches here.
    if (status === 'pending' || status === 'processing') {
      const updated = await waitForIngestReady(objectKey, row)
      if (updated) {
        row = updated
        status = updated.status ?? status
      }
    }
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
  }

  if (!(await fileExists(localPath)))
    return [
      {
        type: 'text',
        text: `[Attached file: ${filename} — file is no longer available.]`
      }
    ]

  // A referenceable pointer to the attachment's canonical URL, appended below
  // to every pathway where the model actually receives the attachment's content
  // (vision pixels, VLM-extracted image text, or extracted document text). This
  // is what lets the model echo the exact `/uploads/<objectKey>` path back as
  // the image-generation tool's `baseImageUrl`. Deliberately NOT emitted on the
  // not-accessible / expired / unprocessed / unextractable notes above and
  // below — those pathways must stay unreferenceable.
  const attachmentUrlPart = {
    type: 'text',
    text: `[Attachment ${filename} — URL: /uploads/${objectKey}]`
  }

  const query = userQuery || filename
  const result = await queryFileChunks(localPath, query, 10)

  // ── Image ─────────────────────────────────────────────────────────────────
  // Vision-capable models get the raw image (their own vision, preferred);
  // every other model gets ONLY the VLM-extracted text. Sending the base64
  // to a text-only model makes the provider reject the whole turn, so it is
  // strictly gated on modelHasVision.
  if (isImage) {
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
    out.push(attachmentUrlPart)
    return out
  }

  if (result) {
    // The ranked excerpts now live in a CITABLE `documentRetrieval` tool result
    // the streaming layer assembles (create-chat-stream-response). When a sink
    // is provided, hand it the chunks and emit only a short pointer note here so
    // the raw file URL never reaches the model — the content arrives via the
    // tool result and becomes citable. Callers that do NOT assemble that tool
    // result (no sink) keep the inline excerpts so the document content still
    // reaches the model exactly as before.
    if (documentSink) {
      documentSink.push({
        sourceId: documentSourceId('doc', objectKey),
        title: filename,
        url: part.url,
        chunks: result.chunks
      })
      return [
        { type: 'text', text: `[Attached document: ${filename}]` },
        attachmentUrlPart
      ]
    }
    const context = result.chunks.join('\n\n---\n\n')
    return [
      {
        type: 'text',
        text: `[Attached document: ${filename}]\n\nRelevant excerpts:\n\n${context}`
      },
      attachmentUrlPart
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
          { type: 'text', text: `[Attached document: ${filename}]\n\n${text}` },
          attachmentUrlPart
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
  opts?: {
    modelHasVision?: boolean
    userId?: string
    // OUT param: ready non-image document sources are appended here (as citable
    // `documentRetrieval` inputs) rather than injected inline as excerpt text.
    documentSink?: DocumentRetrievalInput[]
  }
): Promise<UIMessage[]> {
  const modelHasVision = opts?.modelHasVision ?? false
  const userId = opts?.userId
  const documentSink = opts?.documentSink
  return Promise.all(
    messages.map(async msg => {
      if (msg.role !== 'user') return msg

      const parts = (msg.parts ?? []) as any[]
      if (!parts.some((p: any) => p.type === 'file')) return msg

      const userQuery = extractUserQuery(parts)
      const transformed = await Promise.all(
        parts.map(p =>
          transformPart(p, userQuery, modelHasVision, userId, documentSink)
        )
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
