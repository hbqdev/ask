import { describe, expect, it } from 'vitest'

import { streamPartTimer } from '../stream-part-timer'

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

describe('streamPartTimer', () => {
  it('reports the type of every part, in order, forwarding chunks unchanged', async () => {
    const seen: string[] = []
    const chunks = [
      { type: 'tool-input-start' },
      { type: 'tool-output-available' },
      { type: 'text-delta', delta: 'hello' }
    ]
    const out = await drain(
      fromArray(chunks).pipeThrough(streamPartTimer(t => seen.push(t)))
    )
    // Reporting every occurrence (not just the first) keeps this transform
    // dumb; LatencyTracker owns the first-seen dedup so the rule lives in
    // one place.
    expect(seen).toEqual([
      'tool-input-start',
      'tool-output-available',
      'text-delta'
    ])
    expect(out).toEqual(chunks)
  })

  it('reports repeats too, so the consumer decides what to keep', async () => {
    const seen: string[] = []
    await drain(
      fromArray([{ type: 'text-delta' }, { type: 'text-delta' }]).pipeThrough(
        streamPartTimer(t => seen.push(t))
      )
    )
    expect(seen).toEqual(['text-delta', 'text-delta'])
  })

  it('passes through parts with no type without reporting or dropping them', async () => {
    const seen: string[] = []
    const chunks = [{ noType: true }, { type: 'text-delta' }]
    const out = await drain(
      fromArray(chunks as Array<{ type?: string }>).pipeThrough(
        streamPartTimer(t => seen.push(t))
      )
    )
    expect(seen).toEqual(['text-delta'])
    expect(out).toEqual(chunks)
  })

  it('never lets a throwing callback break the stream', async () => {
    // Telemetry must not be able to kill a turn mid-answer.
    const chunks = [{ type: 'text-delta' }, { type: 'text-delta' }]
    const out = await drain(
      fromArray(chunks).pipeThrough(
        streamPartTimer(() => {
          throw new Error('sink exploded')
        })
      )
    )
    expect(out).toEqual(chunks)
  })

  it('does not fire on an empty stream', async () => {
    const seen: string[] = []
    const out = await drain(
      fromArray<{ type?: string }>([]).pipeThrough(
        streamPartTimer(t => seen.push(t))
      )
    )
    expect(seen).toEqual([])
    expect(out).toEqual([])
  })
})
