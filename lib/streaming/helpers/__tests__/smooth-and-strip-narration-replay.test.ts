import { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import { smoothAndStripNarration } from '../smooth-and-strip-narration'
import { stripNarrationFromMessage } from '../strip-narration-from-message'
import {
  findGluedHeadingSeam,
  findHeadingMatch
} from '../strip-narration-preamble'

import turn1 from './fixtures/narration-replay-t1.json'
import turn2 from './fixtures/narration-replay-t2.json'

// Replays of a REAL lab turn pair (chat bllkvux84ck1uz3wwrwnydg5,
// ollama:deepseek-v4-pro:cloud, 2026-09-28) through the live transform. The
// fixtures are the text-delta chunks and tool calls of the recorded UI SSE.
//
// Turn 2's final answer opened with a 785-char English preamble glued to its
// heading ("…the detailed chapter breakdown.## Trận chiến…"). The old
// transform never recognised that seam, held the whole 4,916-char answer and
// emitted it as ONE delta at text-end (~72 s of nothing for the user). That
// is why the recording holds that part as a single delta: its original model
// chunking was collapsed by the very bug under test. The replays below re-cut
// it with turn 1's recorded chunk sizes (same model, same chat, passed
// through 1:1 because turn 1's answer starts with a proper `## `), plus
// one-char, single-delta and seeded-random cuts.

type ReplayEvent =
  | { type: 'tool'; toolName: string }
  | { type: 'text'; deltas: string[] }

type ReplayPart =
  | { type: 'tool'; toolName: string }
  | {
      type: 'text'
      raw: string
      deltas: string[]
      // Emitted text-delta chunks, each with how many raw chars of this part
      // had been fed into the transform when it came out.
      out: { text: string; fed: number }[]
    }

const T1 = turn1.events as ReplayEvent[]
const T2 = turn2.events as ReplayEvent[]

const lastText = (events: ReplayEvent[]) =>
  events[events.length - 1] as { type: 'text'; deltas: string[] }

async function replay(events: ReplayEvent[]): Promise<ReplayPart[]> {
  const stream = smoothAndStripNarration()({ tools: {}, stopStream: () => {} })
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

  const parts: ReplayPart[] = []
  for (const [i, event] of events.entries()) {
    const id = `p${i}`
    if (event.type === 'tool') {
      await writer.write({
        type: 'tool-call',
        toolCallId: id,
        toolName: event.toolName,
        input: {}
      })
      parts.push(event)
      continue
    }
    let fed = 0
    await writer.write({ type: 'text-start', id })
    for (const text of event.deltas) {
      fed += text.length
      await writer.write({ type: 'text-delta', id, text, fed })
    }
    await writer.write({ type: 'text-end', id })
    parts.push({
      type: 'text',
      raw: event.deltas.join(''),
      deltas: event.deltas,
      out: []
    })
  }
  await writer.close()
  await readAll

  // Every non-text chunk passes through, in order.
  expect(
    emitted.filter(c => c.type === 'tool-call').map(c => c.toolName)
  ).toEqual(
    events.flatMap(e => (e.type === 'tool' ? [e.toolName] : ([] as string[])))
  )

  for (const [i, part] of parts.entries()) {
    if (part.type !== 'text') continue
    part.out = emitted
      .filter(c => c.type === 'text-delta' && c.id === `p${i}`)
      // The end-of-part flush is synthesized from text-end: all was fed.
      .map(c => ({ text: c.text as string, fed: c.fed ?? part.raw.length }))
  }
  return parts
}

/** The UIMessage a turn persists, from each text part's raw or live text. */
function toMessage(parts: ReplayPart[], view: 'raw' | 'live'): UIMessage {
  return {
    id: 'm',
    role: 'assistant',
    parts: parts.flatMap((p, i) => {
      if (p.type === 'tool') {
        return [
          { type: 'step-start' },
          {
            type: `tool-${p.toolName}`,
            toolCallId: `p${i}`,
            state: 'output-available',
            input: {},
            output: {}
          }
        ]
      }
      const text =
        view === 'raw' ? p.raw : p.out.map(chunk => chunk.text).join('')
      return [{ type: 'step-start' }, { type: 'text', text }]
    })
  } as unknown as UIMessage
}

const texts = (msg: UIMessage) =>
  (msg.parts as any[]).filter(p => p.type === 'text').map(p => p.text as string)

/** Cut `text` into consecutive chunks of the given sizes (cycled). */
function rechunk(text: string, sizes: number[]): string[] {
  const out: string[] = []
  for (let at = 0, i = 0; at < text.length; i++) {
    const size = sizes[i % sizes.length]
    out.push(text.slice(at, at + size))
    at += size
  }
  return out
}

/** Deterministic chunk sizes in [1, max] (LCG), so a failure reproduces. */
function seededSizes(seed: number, max: number): number[] {
  const sizes: number[] = []
  let s = seed
  for (let i = 0; i < 4096; i++) {
    s = (s * 1103515245 + 12345) % 2147483648
    sizes.push(1 + (s % max))
  }
  return sizes
}

const T2_ANSWER = lastText(T2).deltas.join('')
const T2_SEAM = findGluedHeadingSeam(T2_ANSWER) as number
const T2_PREFIX_LENGTH = T2_ANSWER.slice(0, T2_SEAM).trim().length
const T1_CHUNK_SIZES = lastText(T1).deltas.map(d => d.length)

describe('live narration transform — real turn replays (lab, deepseek-v4-pro)', () => {
  it('turn 2 fixture is the glued-seam shape the old transform held back', () => {
    expect(T2_ANSWER).toHaveLength(4916)
    expect(findHeadingMatch(T2_ANSWER)).toBeNull() // never a line-start `## `
    expect(T2_SEAM).toBe(785)
    expect(T2_PREFIX_LENGTH).toBe(785)
    expect(T2_ANSWER.slice(T2_SEAM - 18, T2_SEAM + 13)).toBe(
      'chapter breakdown.## Trận chiến'
    )
    // Turn 1's final part is the model's real chunking (926 deltas).
    expect(T1_CHUNK_SIZES).toHaveLength(926)
  })

  const chunkings: [string, string[]][] = [
    [
      "turn 1's recorded deepseek chunk sizes",
      rechunk(T2_ANSWER, T1_CHUNK_SIZES)
    ],
    ['one char per delta', Array.from(T2_ANSWER)],
    ['a single delta (as recorded)', [T2_ANSWER]],
    ['seeded random 1–8', rechunk(T2_ANSWER, seededSizes(7, 8))],
    ['seeded random 1–40', rechunk(T2_ANSWER, seededSizes(42, 40))],
    ['seeded random 1–200', rechunk(T2_ANSWER, seededSizes(2026, 200))]
  ]

  it.each(chunkings)(
    'turn 2 (%s): drops the preamble, streams from the heading, matches persist',
    async (_label, finalDeltas) => {
      const events: ReplayEvent[] = [
        ...T2.slice(0, -1),
        { type: 'text', deltas: finalDeltas }
      ]
      const parts = await replay(events)
      const final = parts[parts.length - 1] as Extract<
        ReplayPart,
        { type: 'text' }
      >
      const live = final.out.map(chunk => chunk.text).join('')

      // (a) Nothing of the preamble is emitted: the output is exactly the
      // raw text from the `##` on.
      expect(live).toBe(T2_ANSWER.slice(T2_SEAM))
      expect(live).not.toContain('I have enough information now')
      expect(live).not.toContain('Let me write the answer')

      // (b) Released as soon as the persist guard is certain — the text after
      // the seam outweighs the 785-char prefix — then passed through 1:1.
      const first = final.out[0]
      expect(first.text.startsWith('## Trận chiến quan trọng nhất')).toBe(true)
      const releaseIndex = final.deltas.findIndex(
        (_d, i) => final.deltas.slice(0, i + 1).join('').length === first.fed
      )
      const maxChunk = Math.max(...final.deltas.map(d => d.length))
      expect(first.fed - T2_SEAM).toBeGreaterThan(T2_PREFIX_LENGTH)
      expect(first.fed - T2_SEAM).toBeLessThanOrEqual(
        T2_PREFIX_LENGTH + maxChunk
      )
      expect(final.out).toHaveLength(final.deltas.length - releaseIndex)
      expect(final.out.slice(1).map(chunk => chunk.text)).toEqual(
        final.deltas.slice(releaseIndex + 1)
      )

      // (c) Live output == the persisted cleaned answer, and the two message
      // views converge (the inter-step status parts pass through live and
      // are dropped by the same persist/render cleanup either way).
      const persisted = stripNarrationFromMessage(toMessage(parts, 'raw'))
      expect(texts(persisted)).toEqual([live])
      expect(
        texts(stripNarrationFromMessage(toMessage(parts, 'live')))
      ).toEqual(texts(persisted))
      for (const part of parts.slice(0, -1)) {
        if (part.type !== 'text') continue
        expect(part.out.map(chunk => chunk.text).join('')).toBe(part.raw)
      }
    }
  )

  it("turn 2 with turn 1's chunking releases 792 chars after the seam", async () => {
    const parts = await replay([
      ...T2.slice(0, -1),
      { type: 'text', deltas: rechunk(T2_ANSWER, T1_CHUNK_SIZES) }
    ])
    const final = parts[parts.length - 1] as Extract<
      ReplayPart,
      { type: 'text' }
    >
    // The guard is certain once 786 chars (> the 785-char prefix) follow the
    // seam; the delta that crosses it ends 792 chars after the seam, so the
    // first emission comes after 1,577 of 4,916 raw chars and the remaining
    // 3,339 chars stream progressively (previously: all 4,916 at text-end).
    expect(final.out[0].fed).toBe(1577)
    expect(final.out[0].fed - T2_SEAM).toBe(792)
  })

  it('turn 1 (answer starts with a proper `## `) is emitted chunk-for-chunk as recorded', async () => {
    const parts = await replay(T1)
    for (const part of parts) {
      if (part.type !== 'text') continue
      // Identical chunks to what the lab emitted with the old transform: the
      // 171-char status part is held to its end as before, and the answer
      // is released on its first delta and passed through 1:1.
      expect(part.out.map(chunk => chunk.text)).toEqual(part.deltas)
    }
    const final = parts[parts.length - 1] as Extract<
      ReplayPart,
      { type: 'text' }
    >
    expect(final.out[0].fed).toBe(final.deltas[0].length)
    expect(texts(stripNarrationFromMessage(toMessage(parts, 'raw')))).toEqual([
      final.raw
    ])
  })

  it('turn 1 answer re-cut one char per delta still streams from the first `## `', async () => {
    const answer = lastText(T1).deltas.join('')
    const parts = await replay([
      ...T1.slice(0, -1),
      { type: 'text', deltas: Array.from(answer) }
    ])
    const final = parts[parts.length - 1] as Extract<
      ReplayPart,
      { type: 'text' }
    >
    expect(final.out[0]).toEqual({ text: '## ', fed: 3 })
    expect(final.out.map(chunk => chunk.text).join('')).toBe(answer)
  })
})
