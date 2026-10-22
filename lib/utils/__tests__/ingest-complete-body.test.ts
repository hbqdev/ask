// @vitest-environment node
import { describe, expect, it } from 'vitest'

import * as mod from '../ingest-complete-body'

// The ingest worker (Python requests, json=...) sends this exact shape:
// default separators and ensure_ascii, keys in insertion order.
function pythonJson(body: Record<string, unknown>): string {
  return JSON.stringify(body)
    .replace(/","/g, '", "')
    .replace(/":/g, '": ')
    .replace(
      /[\u0080-￿]/g,
      c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    )
}

function request(raw: string, pieceSize = 1000): Request {
  const bytes = new TextEncoder().encode(raw)
  let sent = 0
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(sent, sent + pieceSize))
      sent += pieceSize
      pulled++
    }
  })
  const req = new Request('http://x/api/ingest/complete', {
    method: 'POST',
    body,
    duplex: 'half'
  } as RequestInit)
  ;(req as any).pulledPieces = () => pulled
  return req
}

describe('readIngestCompleteBody', () => {
  it('parses a body within the cap as plain JSON', async () => {
    const raw = pythonJson({ fileId: 'f1', chunks: ['a', 'b "q"', '漢字'] })
    expect(await mod.readIngestCompleteBody(request(raw), 10_000)).toEqual({
      fileId: 'f1',
      chunks: ['a', 'b "q"', '漢字'],
      truncated: false
    })
  })

  it('parses a failure report', async () => {
    const raw = pythonJson({ fileId: 'f1', error: 'boom', retryable: true })
    expect(await mod.readIngestCompleteBody(request(raw), 10_000)).toEqual({
      fileId: 'f1',
      error: 'boom',
      retryable: true,
      truncated: false
    })
  })

  it('returns null for malformed JSON within the cap', async () => {
    expect(
      await mod.readIngestCompleteBody(request('{not valid json'), 10_000)
    ).toBeNull()
  })

  it('keeps only the whole chunks that fit in the cap when the body is larger', async () => {
    const chunks = Array.from(
      { length: 400 },
      (_, i) =>
        `chunk ${i} with "quotes", a back\\slash and 漢字 ${'x'.repeat(i % 50)}` +
        (i % 7 === 0 ? '\\' : '')
    )
    const raw = pythonJson({ fileId: 'f-9', chunks })
    const cap = Math.floor(raw.length / 3)
    const out = await mod.readIngestCompleteBody(request(raw), cap)

    expect(out?.fileId).toBe('f-9')
    expect(out?.truncated).toBe(true)
    const kept = out?.chunks as string[]
    expect(kept.length).toBeGreaterThan(10)
    expect(kept.length).toBeLessThan(400)
    // Exactly the leading chunks, in document order, each one whole.
    expect(kept).toEqual(chunks.slice(0, kept.length))
    // As many as fit: the next chunk would have crossed the cap.
    const through = (n: number) =>
      pythonJson({ fileId: 'f-9', chunks: chunks.slice(0, n) }).length - 2
    expect(through(kept.length)).toBeLessThanOrEqual(cap)
    expect(through(kept.length + 1)).toBeGreaterThan(cap)
  })

  it('reads the whole oversized body (so the sender is never cut off) but keeps only the cap', async () => {
    const chunks = Array.from({ length: 300 }, (_, i) => `c${i}`.repeat(40))
    const raw = pythonJson({ fileId: 'f1', chunks })
    const req = request(raw, 500)
    const out = await mod.readIngestCompleteBody(req, 2_000)
    expect(out?.truncated).toBe(true)
    expect((req as any).pulledPieces()).toBe(Math.ceil(raw.length / 500))
  })

  it('returns null for an oversized body that is not a chunks upload', async () => {
    const raw = pythonJson({ fileId: 'f1', error: 'e'.repeat(5_000) })
    expect(await mod.readIngestCompleteBody(request(raw), 1_000)).toBeNull()
  })
})
