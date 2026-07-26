// Newline-delimited JSON over a fetch body.
//
// The advanced-search route knows its candidate URLs ~2s in (the SearXNG
// fan-out) but does not return until crawl and rerank finish, ~15-20s later,
// so the user stares at nothing while sources we already have sit unsent.
// Streaming lets the route emit a preview line immediately and the enriched,
// reranked line when it is ready.
//
// Chunk boundaries do not respect line boundaries — a JSON object routinely
// arrives split across two reads, and a multi-byte character can be split
// mid-sequence — so the buffering here is the part worth getting right.

export async function* readNdjson(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<unknown> {
  const reader = body.getReader()
  // stream: true keeps partial multi-byte sequences buffered across reads.
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const parsed = parseLine(line)
        if (parsed !== undefined) yield parsed
      }
    }
    buffer += decoder.decode()
    const parsed = parseLine(buffer)
    if (parsed !== undefined) yield parsed
  } finally {
    reader.releaseLock()
  }
}

/**
 * undefined means "nothing to yield" — a blank line, or a malformed one. A
 * truncated preview must never cost the caller the final results, so a bad
 * line is skipped rather than thrown.
 */
function parseLine(line: string): unknown | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}
