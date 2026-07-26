import { describe, expect, it } from 'vitest'

import { LatencyTracker } from '../latency-tracker'

// Deterministic clock: each call returns the next queued value.
function fakeClock(values: number[]): () => number {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

describe('LatencyTracker', () => {
  it('emits one [latency] line with marks, ttft, total, and meta', () => {
    const lines: string[] = []
    // start=0, markFirstToken reads 800, emit reads 1500
    const t = new LatencyTracker(
      { chatId: 'c1', mode: 'balanced' },
      fakeClock([0, 800, 1500]),
      l => lines.push(l)
    )
    t.mark('classify_ms', 120)
    t.mark('recall_ms', 40)
    t.markFirstToken()
    t.emit({ skipSearch: false })

    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('[latency] ')).toBe(true)
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj).toMatchObject({
      chatId: 'c1',
      mode: 'balanced',
      classify_ms: 120,
      recall_ms: 40,
      ttft_ms: 800,
      total_ms: 1500,
      skipSearch: false
    })
  })

  it('reports ttft_ms null when no token was emitted, and null chatId', () => {
    const lines: string[] = []
    const t = new LatencyTracker(
      { chatId: null, mode: 'speed' },
      fakeClock([0, 900]),
      l => lines.push(l)
    )
    t.emit({ skipSearch: null })
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj.ttft_ms).toBeNull()
    expect(obj.chatId).toBeNull()
    expect(obj.total_ms).toBe(900)
  })

  it('markFirstToken is idempotent (keeps the first stamp)', () => {
    const lines: string[] = []
    const t = new LatencyTracker(
      { chatId: 'c1', mode: 'balanced' },
      fakeClock([0, 500, 999, 2000]),
      l => lines.push(l)
    )
    t.markFirstToken() // reads 500 → firstTokenAt
    t.markFirstToken() // guard short-circuits: no clock read
    t.emit({}) // reads 999 → total_ms
    const obj = JSON.parse(lines[0].slice('[latency] '.length))
    expect(obj.ttft_ms).toBe(500)
    expect(obj.total_ms).toBe(999)
  })

  // ttft_ms stamps the first chunk of ANY kind, which on a research turn is a
  // tool call — not prose. The measured gap between that and the first visible
  // sentence was ~46s, larger than the whole search pipeline, and nothing in
  // the line accounted for it. These marks make that interval readable.
  describe('stream part timeline', () => {
    it('records the offset of each part type the first time it is seen', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 300, 1200, 5000]),
        l => lines.push(l)
      )
      t.markStreamPart('tool-input-start') // 300
      t.markStreamPart('text-delta') // 1200
      t.emit({}) // 5000
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj.stream).toEqual({
        'tool-input-start': 300,
        'text-delta': 1200
      })
    })

    it('keeps the FIRST offset for a repeated type, not the latest', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 400, 9999, 5000]),
        l => lines.push(l)
      )
      t.markStreamPart('text-delta') // 400
      t.markStreamPart('text-delta') // must not read the clock again
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj.stream['text-delta']).toBe(400)
    })

    it('omits the stream key entirely when no parts were seen', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 700]),
        l => lines.push(l)
      )
      t.emit({})
      expect(
        JSON.parse(lines[0].slice('[latency] '.length))
      ).not.toHaveProperty('stream')
    })
  })

  // A research turn is multi-step, and both of the metrics used to judge the
  // excerpts change turned out to be confounded by that:
  //   - prompt_tokens came from totalUsage, which the AI SDK documents as the
  //     SUM of all step usages, so it was never a prompt size.
  //   - "search -> first prose" was measured first-tool to first-text, so a
  //     turn that added a fetch step read as slower ingestion when it was
  //     really just doing more round trips.
  // These marks make step count explicit and measure ingestion from the LAST
  // tool output, which is the point after which nothing but generation remains.
  describe('multi-step accounting', () => {
    it('counts steps and tool calls rather than only stamping the first', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock(Array.from({ length: 40 }, (_, i) => i * 100)),
        l => lines.push(l)
      )
      t.markStreamPart('start-step')
      t.markStreamPart('tool-input-available')
      t.markStreamPart('tool-output-available')
      t.markStreamPart('start-step')
      t.markStreamPart('tool-input-available')
      t.markStreamPart('tool-output-available')
      t.markStreamPart('start-step')
      t.markStreamPart('text-start')
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj.steps).toBe(3)
      expect(obj.tool_calls).toBe(2)
    })

    it('measures ingestion from the LAST tool output, not the first', () => {
      const lines: string[] = []
      // start=0; parts read 1000, 2000, 9000 (last tool out), 11000 (text)
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 1000, 2000, 9000, 11000, 12000]),
        l => lines.push(l)
      )
      t.markStreamPart('tool-output-available') // 1000 — first tool
      t.markStreamPart('start-step') // 2000
      t.markStreamPart('tool-output-available') // 9000 — last tool
      t.markStreamPart('text-start') // 11000
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      // 11000 - 9000, NOT 11000 - 1000.
      expect(obj.ingest_ms).toBe(2000)
    })

    it('omits ingest_ms when the turn used no tools', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 500, 3000]),
        l => lines.push(l)
      )
      t.markStreamPart('text-start')
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj).not.toHaveProperty('ingest_ms')
      expect(obj.steps).toBe(0)
    })

    it('omits ingest_ms rather than emitting a negative when text precedes the last tool', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 1000, 5000, 9000]),
        l => lines.push(l)
      )
      t.markStreamPart('text-start') // 1000 — prose began first
      t.markStreamPart('tool-output-available') // 5000 — then a later tool call
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj).not.toHaveProperty('ingest_ms')
    })
  })

  // Prompt size is the leading explanation for the post-search gap (15 full
  // crawled pages go into the answering prompt), so the line has to carry it
  // or the next round of tuning is guesswork again.
  describe('token usage', () => {
    it('emits prompt and completion token counts when usage is known', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 1000]),
        l => lines.push(l)
      )
      t.markUsage({ inputTokens: 48_000, outputTokens: 1_200 })
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj.prompt_tokens).toBe(48000)
      expect(obj.completion_tokens).toBe(1200)
    })

    it('distinguishes the summed total from the last step actually sent', () => {
      // prompt_tokens is the SUM across steps (AI SDK: "when there are
      // multiple steps, the usage is the sum of all step usages"), so on its
      // own it cannot answer "how big was the prompt". last_prompt_tokens is
      // the final step's input — the real answering prompt.
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 1000]),
        l => lines.push(l)
      )
      t.markUsage({ inputTokens: 89_284, outputTokens: 3_577 }, 21_500)
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj.prompt_tokens).toBe(89284)
      expect(obj.last_prompt_tokens).toBe(21500)
    })

    it('omits last_prompt_tokens when the last step usage is unavailable', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 1000]),
        l => lines.push(l)
      )
      t.markUsage({ inputTokens: 100, outputTokens: 10 })
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj).not.toHaveProperty('last_prompt_tokens')
    })

    it('omits token keys when usage is unavailable, rather than emitting zeros', () => {
      const lines: string[] = []
      const t = new LatencyTracker(
        { chatId: 'c1', mode: 'balanced' },
        fakeClock([0, 1000]),
        l => lines.push(l)
      )
      t.markUsage({ inputTokens: undefined, outputTokens: undefined })
      t.emit({})
      const obj = JSON.parse(lines[0].slice('[latency] '.length))
      expect(obj).not.toHaveProperty('prompt_tokens')
      expect(obj).not.toHaveProperty('completion_tokens')
    })
  })
})
