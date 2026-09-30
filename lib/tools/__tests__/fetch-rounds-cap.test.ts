import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Per-turn fetch cap (lib/tools/fetch-budget.ts). Driven through the YouTube
// branch of the REAL fetch execute so no network or scraper backend is touched.

const youtubeMocks = vi.hoisted(() => ({
  fetchTranscript: vi.fn(),
  toPlainText: vi.fn((segments: { text: string }[], separator = '\n') =>
    segments.map(s => s.text).join(separator)
  ),
  YoutubeTranscriptNotAvailableLanguageError: class extends Error {}
}))

vi.mock('youtube-transcript-plus', () => youtubeMocks)
vi.mock('@/lib/utils/usage-logging', () => ({ logToolPayload: vi.fn() }))
vi.mock('@/lib/utils/ssrf-guard', () => ({
  assertUrlAllowed: vi.fn(async () => {})
}))

import { createFetchTool } from '../fetch'
import {
  buildFetchLimitNotice,
  FETCH_ROUNDS_MAX_QUALITY_DEFAULT,
  resolveFetchRoundsBudget
} from '../fetch-budget'

const URL_ = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

type Chunk = Record<string, unknown>

async function run(
  tool: ReturnType<typeof createFetchTool>,
  n: number
): Promise<{ first: Chunk; last: Chunk }> {
  const out = tool.execute!({ url: URL_, type: 'regular' }, {
    toolCallId: `tc-${n}`,
    messages: []
  } as never) as AsyncIterable<Chunk>
  const chunks: Chunk[] = []
  for await (const c of out) chunks.push(c)
  return { first: chunks[0], last: chunks[chunks.length - 1] }
}

beforeEach(() => {
  youtubeMocks.fetchTranscript.mockReset()
  youtubeMocks.fetchTranscript.mockResolvedValue({
    videoDetails: { title: 'A Video' },
    segments: [{ text: 'hello', duration: 1, offset: 0, lang: 'en' }]
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('resolveFetchRoundsBudget', () => {
  it('caps quality at 8 fetch calls by default', () => {
    expect(FETCH_ROUNDS_MAX_QUALITY_DEFAULT).toBe(8)
    expect(resolveFetchRoundsBudget('quality', {})).toBe(8)
  })

  it('leaves balanced / speed / undefined uncapped by default', () => {
    expect(resolveFetchRoundsBudget('balanced', {})).toBeNull()
    expect(resolveFetchRoundsBudget('speed', {})).toBeNull()
    expect(resolveFetchRoundsBudget(undefined, {})).toBeNull()
  })

  it('honours FETCH_ROUNDS_MAX_QUALITY for quality only', () => {
    const env = { FETCH_ROUNDS_MAX_QUALITY: '3' }
    expect(resolveFetchRoundsBudget('quality', env)).toBe(3)
    expect(resolveFetchRoundsBudget('balanced', env)).toBeNull()
  })

  it('honours FETCH_ROUNDS_MAX for the other modes', () => {
    const env = { FETCH_ROUNDS_MAX: '4' }
    expect(resolveFetchRoundsBudget('balanced', env)).toBe(4)
    expect(resolveFetchRoundsBudget('speed', env)).toBe(4)
    // Quality has its own knob.
    expect(resolveFetchRoundsBudget('quality', env)).toBe(8)
  })

  it('ignores invalid overrides and floors fractions', () => {
    for (const bad of ['0', '-2', 'abc', '', ' ']) {
      expect(
        resolveFetchRoundsBudget('quality', { FETCH_ROUNDS_MAX_QUALITY: bad })
      ).toBe(8)
      expect(
        resolveFetchRoundsBudget('balanced', { FETCH_ROUNDS_MAX: bad })
      ).toBeNull()
    }
    expect(
      resolveFetchRoundsBudget('quality', { FETCH_ROUNDS_MAX_QUALITY: '5.9' })
    ).toBe(5)
  })
})

describe('fetch tool — per-turn fetch cap', () => {
  it('quality: fetches up to the budget, then refuses with a non-error notice', async () => {
    vi.stubEnv('FETCH_ROUNDS_MAX_QUALITY', '2')
    const tool = createFetchTool({ searchMode: 'quality', chatId: 'c1' })

    const a = await run(tool, 1)
    const b = await run(tool, 2)
    expect((a.last.results as unknown[]).length).toBe(1)
    expect((b.last.results as unknown[]).length).toBe(1)
    expect(youtubeMocks.fetchTranscript).toHaveBeenCalledTimes(2)

    const c = await run(tool, 3)
    // Refused before the "fetching" state: a single complete chunk.
    expect(c.first).toBe(c.last)
    expect(c.last.state).toBe('complete')
    expect(c.last.results).toEqual([])
    expect(c.last.fetchLimitReached).toBe(true)
    expect(c.last.notice).toBe(buildFetchLimitNotice(2))
    // Nothing citable on a refusal.
    expect('toolCallId' in c.last).toBe(false)
    expect(youtubeMocks.fetchTranscript).toHaveBeenCalledTimes(2)
  })

  it('the budget is per tool instance, i.e. per turn', async () => {
    vi.stubEnv('FETCH_ROUNDS_MAX_QUALITY', '1')
    const turn1 = createFetchTool({ searchMode: 'quality' })
    await run(turn1, 1)
    expect((await run(turn1, 2)).last.fetchLimitReached).toBe(true)

    const turn2 = createFetchTool({ searchMode: 'quality' })
    expect((await run(turn2, 1)).last.fetchLimitReached).toBeUndefined()
  })

  it('balanced (no fetch cap by default) is never refused', async () => {
    const tool = createFetchTool({ searchMode: 'balanced' })
    for (let i = 1; i <= 10; i++) {
      expect((await run(tool, i)).last.fetchLimitReached).toBeUndefined()
    }
  })

  it('the process-wide instance (no searchMode) is never capped', async () => {
    vi.stubEnv('FETCH_ROUNDS_MAX_QUALITY', '1')
    vi.stubEnv('FETCH_ROUNDS_MAX', '1')
    const tool = createFetchTool()
    await run(tool, 1)
    expect((await run(tool, 2)).last.fetchLimitReached).toBeUndefined()
  })
})

describe('buildFetchLimitNotice', () => {
  it('states the cap and keeps the answer-format instruction', () => {
    const n = buildFetchLimitNotice(8)
    expect(n).toContain('Fetch limit reached (8 fetch calls this turn)')
    expect(n).toContain('begin your reply immediately with its `## ` heading')
  })
})
