import { describe, expect, it } from 'vitest'

import { readNdjson } from '../ndjson'

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s))
      c.close()
    }
  })
}

async function collect(chunks: string[]): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const obj of readNdjson(streamOf(chunks))) out.push(obj)
  return out
}

// The search route streams a preview line (candidates, ~2s) and then a final
// line (crawled + reranked, ~15s). Sources currently appear only at the end.
// Chunk boundaries do NOT respect line boundaries, so a naive split on '\n'
// per chunk drops or corrupts objects — that is the whole risk here.
describe('readNdjson', () => {
  it('yields one object per line', async () => {
    await expect(collect(['{"a":1}\n{"a":2}\n'])).resolves.toEqual([
      { a: 1 },
      { a: 2 }
    ])
  })

  it('reassembles an object split across chunk boundaries', async () => {
    await expect(collect(['{"a":', '1}\n'])).resolves.toEqual([{ a: 1 }])
  })

  it('handles a newline arriving in its own chunk', async () => {
    await expect(collect(['{"a":1}', '\n', '{"a":2}\n'])).resolves.toEqual([
      { a: 1 },
      { a: 2 }
    ])
  })

  it('yields a trailing object with no final newline', async () => {
    await expect(collect(['{"a":1}\n{"a":2}'])).resolves.toEqual([
      { a: 1 },
      { a: 2 }
    ])
  })

  it('ignores blank lines rather than emitting undefined', async () => {
    await expect(collect(['{"a":1}\n\n\n{"a":2}\n'])).resolves.toEqual([
      { a: 1 },
      { a: 2 }
    ])
  })

  it('skips a malformed line instead of aborting the stream', async () => {
    // A truncated preview must never cost us the final results.
    await expect(collect(['not json\n{"a":2}\n'])).resolves.toEqual([{ a: 2 }])
  })

  it('handles multi-byte characters split across chunks', async () => {
    const enc = new TextEncoder()
    const bytes = enc.encode('{"q":"café"}\n')
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // split mid-UTF8 sequence
        c.enqueue(bytes.slice(0, 10))
        c.enqueue(bytes.slice(10))
        c.close()
      }
    })
    const out: unknown[] = []
    for await (const o of readNdjson(stream)) out.push(o)
    expect(out).toEqual([{ q: 'café' }])
  })

  it('yields nothing for an empty stream', async () => {
    await expect(collect([])).resolves.toEqual([])
  })
})
