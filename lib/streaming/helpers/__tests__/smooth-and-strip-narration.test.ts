import { describe, expect, it } from 'vitest'

import { smoothAndStripNarration } from '../smooth-and-strip-narration'

/**
 * Drives the transform with a sequence of text-delta chunks (plus the
 * bracketing text-start/text-end) and returns the assembled answer text
 * the way the real AI SDK consumer would: concatenate every `text-delta`
 * chunk's `.text` field, in order emitted. This mirrors both
 * `toUIMessageStream`'s server-side transform and the client-side
 * `processUIMessageStream` reducer — both only ever read `.text`/`.delta`
 * off text-delta chunks, never anything attached to text-start/text-end.
 */
async function runTransform(deltas: string[]) {
  const factory = smoothAndStripNarration()
  const stream = factory({ tools: {}, stopStream: () => {} })
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()

  const emitted: any[] = []
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      emitted.push(value)
    }
  })()

  await writer.write({ type: 'text-start', id: 'p1' })
  for (const text of deltas) {
    await writer.write({ type: 'text-delta', id: 'p1', text })
  }
  await writer.write({ type: 'text-end', id: 'p1' })
  await writer.close()
  await readAll

  const assembled = emitted
    .filter(c => c.type === 'text-delta')
    .map(c => c.text)
    .join('')

  return { emitted, assembled }
}

describe('smoothAndStripNarration', () => {
  it('passes through a clean answer starting with ## immediately (no drop)', async () => {
    const deltas = ['## Capital of Japan\n', 'The capital of Japan is Tokyo.']
    const { assembled } = await runTransform(deltas)
    expect(assembled).toBe(deltas.join(''))
  })

  it('strips gemma4-style narration before the heading', async () => {
    const deltas = [
      'I have enough info. ',
      'I will now write the response.\n',
      '## Remedying Canker Sores\n',
      'Canker sores are painful.'
    ]
    const { assembled } = await runTransform(deltas)
    expect(assembled.startsWith('## Remedying Canker Sores')).toBe(true)
    expect(assembled).not.toMatch(/I have enough info/)
    expect(assembled).toContain('Canker sores are painful.')
  })

  it('preserves a refusal with no heading (does not drop the answer)', async () => {
    const deltas = ['I cannot ', 'fulfill this ', 'request.']
    const { assembled } = await runTransform(deltas)
    expect(assembled).toBe(deltas.join(''))
  })

  it('strips narration even when preceded by an unrelated garbled sentence, streamed chunk by chunk', async () => {
    // Real bug: gemma4:31b:cloud prepended "Coins are not mentioned yet."
    // before its actual self-talk. Streamed as small deltas the way the
    // real model output arrives, to also exercise the buffer's per-chunk
    // narration-plausibility check (NARRATION_SNIFF_LIMIT), not just the
    // final assembled string.
    const deltas = [
      'Coins are not ',
      'mentioned yet. ',
      'I have enough search ',
      'results to answer.\n',
      '## Causes of Canker Sores\n',
      'The exact cause is unknown.'
    ]
    const { assembled } = await runTransform(deltas)
    expect(assembled.startsWith('## Causes of Canker Sores')).toBe(true)
    expect(assembled).not.toMatch(/Coins are not mentioned/)
    expect(assembled).not.toMatch(/I have enough search/)
    expect(assembled).toContain('The exact cause is unknown.')
  })

  it('preserves a short factual answer with no heading', async () => {
    const deltas = ['Paris.']
    const { assembled } = await runTransform(deltas)
    expect(assembled).toBe('Paris.')
  })

  it('preserves a genuine intro paragraph before the first heading', async () => {
    const deltas = [
      'Canker sores are painful ulcers that affect many people.\n',
      '## Background\n',
      'They typically resolve within two weeks.'
    ]
    const { assembled } = await runTransform(deltas)
    expect(assembled).toBe(deltas.join(''))
  })

  it('does not hold a long non-narration answer with no heading forever', async () => {
    // A long factual answer with no heading and no narration-starter
    // prefix must eventually flush once it's clearly not narration —
    // it must not require a heading to ever appear.
    const longAnswer =
      'The mitochondria is the powerhouse of the cell. '.repeat(20)
    const deltas = [longAnswer]
    const { assembled } = await runTransform(deltas)
    expect(assembled).toBe(longAnswer)
  })

  it('flushes a narration-looking buffer that never gets a heading (hard cap)', async () => {
    // Pathological case: the model keeps talking in a narration voice and
    // never produces a heading. The hard cap must still flush everything
    // so the answer is never silently dropped.
    const narrationForever =
      'I have enough info. ' + 'and I keep thinking more and more. '.repeat(400)
    const deltas = [narrationForever]
    const { assembled } = await runTransform(deltas)
    expect(assembled).toBe(narrationForever)
  })

  it('resets state between multiple text parts (text-start boundaries)', async () => {
    const factory = smoothAndStripNarration()
    const stream = factory({ tools: {}, stopStream: () => {} })
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()

    const emitted: any[] = []
    const readAll = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        emitted.push(value)
      }
    })()

    // First text part: narration then heading.
    await writer.write({ type: 'text-start', id: 'p1' })
    await writer.write({
      type: 'text-delta',
      id: 'p1',
      text: 'I have enough info.\n## First\ncontent one'
    })
    await writer.write({ type: 'text-end', id: 'p1' })

    // Second text part: clean answer, must not inherit narrationMode=false
    // from the previous part.
    await writer.write({ type: 'text-start', id: 'p2' })
    await writer.write({
      type: 'text-delta',
      id: 'p2',
      text: '## Second\ncontent two'
    })
    await writer.write({ type: 'text-end', id: 'p2' })

    await writer.close()
    await readAll

    const part1Text = emitted
      .filter(c => c.type === 'text-delta' && c.id === 'p1')
      .map(c => c.text)
      .join('')
    const part2Text = emitted
      .filter(c => c.type === 'text-delta' && c.id === 'p2')
      .map(c => c.text)
      .join('')

    expect(part1Text.startsWith('## First')).toBe(true)
    expect(part2Text).toBe('## Second\ncontent two')
  })

  it('passes through reasoning and other chunk types unchanged', async () => {
    const factory = smoothAndStripNarration()
    const stream = factory({ tools: {}, stopStream: () => {} })
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()

    const emitted: any[] = []
    const readAll = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        emitted.push(value)
      }
    })()

    await writer.write({ type: 'reasoning-start', id: 'r1' })
    await writer.write({
      type: 'reasoning-delta',
      id: 'r1',
      text: 'thinking...'
    })
    await writer.write({ type: 'reasoning-end', id: 'r1' })
    await writer.close()
    await readAll

    expect(emitted).toEqual([
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', text: 'thinking...' },
      { type: 'reasoning-end', id: 'r1' }
    ])
  })
})
