import type { UIMessageChunk } from 'ai'
import { describe, expect, it } from 'vitest'

import { peekStartChunk } from '../resumable-chat-transport'

function streamOf(chunks: UIMessageChunk[]) {
  return new ReadableStream<UIMessageChunk>({
    start(c) {
      chunks.forEach(ch => c.enqueue(ch))
      c.close()
    }
  })
}

async function drain(s: ReadableStream<UIMessageChunk>) {
  const out: UIMessageChunk[] = []
  const r = s.getReader()
  for (;;) {
    const { done, value } = await r.read()
    if (done) return out
    out.push(value)
  }
}

describe('peekStartChunk', () => {
  it('reports the replayed message id and preserves every chunk in order', async () => {
    const chunks: UIMessageChunk[] = [
      { type: 'start', messageId: 'a1' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'hi' },
      { type: 'text-end', id: 't' },
      { type: 'finish' }
    ]
    let seen: string | undefined = 'unset'
    const out = await peekStartChunk(streamOf(chunks), id => (seen = id))
    expect(seen).toBe('a1')
    expect(await drain(out)).toEqual(chunks)
  })

  it('reports undefined when the first chunk is not a start', async () => {
    let seen: string | undefined = 'unset'
    const out = await peekStartChunk(
      streamOf([{ type: 'text-start', id: 't' }]),
      id => (seen = id)
    )
    expect(seen).toBeUndefined()
    expect(await drain(out)).toHaveLength(1)
  })

  it('handles an empty stream', async () => {
    const out = await peekStartChunk(streamOf([]), () => {})
    expect(await drain(out)).toEqual([])
  })
})
