// Reads the ingest worker's POST /api/ingest/complete body with bounded memory.
//
// The worker sends every chunk it extracted in one JSON body (a big text file
// makes tens of MB, and an upload can be up to 2 GB). Only the first chunks can
// be indexed anyway, so at most `maxBytes` of the body is kept. The rest is
// still read and thrown away, never cut off: the worker must get its answer,
// not a reset connection that it would report as a failure.
//
// Over the cap, the kept prefix is not valid JSON. The worker's body is
// `{"fileId": "<id>", "chunks": ["...", "...", ...` (Python json.dumps, keys in
// insertion order), so the file id and every chunk string that ended inside the
// prefix are recovered, in order, and the result is marked truncated.

export interface IngestCompleteBody {
  fileId?: unknown
  chunks?: unknown
  error?: unknown
  retryable?: unknown
  /** True when the body was over the cap and only its leading chunks were kept. */
  truncated: boolean
}

const CHUNKS_UPLOAD_HEAD =
  /^\s*\{\s*"fileId"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"chunks"\s*:\s*\[/

/** Index of the quote closing the JSON string whose content starts at `from`. */
function closingQuote(text: string, from: number): number {
  let at = text.indexOf('"', from)
  while (at !== -1) {
    let backslashes = 0
    while (text[at - 1 - backslashes] === '\\') backslashes++
    if (backslashes % 2 === 0) return at
    at = text.indexOf('"', at + 1)
  }
  return -1
}

function leadingChunks(prefix: string): IngestCompleteBody | null {
  const head = CHUNKS_UPLOAD_HEAD.exec(prefix)
  if (!head) return null
  const chunks: string[] = []
  let at = head[0].length
  for (;;) {
    while (/\s/.test(prefix[at] ?? '')) at++
    if (prefix[at] !== '"') break
    const end = closingQuote(prefix, at + 1)
    if (end === -1) break
    chunks.push(JSON.parse(prefix.slice(at, end + 1)))
    at = end + 1
    while (/\s/.test(prefix[at] ?? '')) at++
    if (prefix[at] !== ',') break
    at++
  }
  return { fileId: JSON.parse(head[1]), chunks, truncated: true }
}

/**
 * The parsed body, or null when it is not valid JSON (or, over the cap, not a
 * chunks upload).
 */
export async function readIngestCompleteBody(
  req: Request,
  maxBytes: number
): Promise<IngestCompleteBody | null> {
  const kept: Uint8Array[] = []
  let keptBytes = 0
  let over = false
  if (req.body) {
    const reader = req.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (keptBytes >= maxBytes) {
        over = true
        continue
      }
      const room = maxBytes - keptBytes
      if (value.length > room) over = true
      const piece = value.length > room ? value.subarray(0, room) : value
      kept.push(piece)
      keptBytes += piece.length
    }
  }
  const text = new TextDecoder().decode(Buffer.concat(kept))
  if (over) return leadingChunks(text)
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return { truncated: false }
    return { ...parsed, truncated: false }
  } catch {
    return null
  }
}
