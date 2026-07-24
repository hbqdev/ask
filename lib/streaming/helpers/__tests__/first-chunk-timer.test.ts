import { describe, expect, it } from 'vitest'

import { firstChunkTimer } from '../first-chunk-timer'

async function drain<T>(rs: ReadableStream<T>): Promise<T[]> {
  const out: T[] = []
  const reader = rs.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

function fromArray<T>(items: T[]): ReadableStream<T> {
  return new ReadableStream<T>({
    start(controller) {
      for (const it of items) controller.enqueue(it)
      controller.close()
    }
  })
}

describe('firstChunkTimer', () => {
  it('fires onFirst exactly once and forwards all chunks unchanged', async () => {
    let calls = 0
    const chunks = [{ a: 1 }, { b: 2 }, { c: 3 }]
    const out = await drain(
      fromArray(chunks).pipeThrough(firstChunkTimer(() => calls++))
    )
    expect(calls).toBe(1)
    expect(out).toEqual(chunks)
  })

  it('does not fire onFirst for an empty stream', async () => {
    let calls = 0
    const out = await drain(
      fromArray<number>([]).pipeThrough(firstChunkTimer(() => calls++))
    )
    expect(calls).toBe(0)
    expect(out).toEqual([])
  })
})
