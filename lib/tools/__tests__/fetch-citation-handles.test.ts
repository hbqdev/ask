import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'
import {
  extractCitationMaps,
  resolveCitationAnchor
} from '@/lib/utils/citation'

// CITATION_HANDLES on the fetch tool: each fetched page the model sees carries
// its ready-made `cite` string. A fetch of several urls numbers its pages by
// position in the MERGED results, from which failed urls are left out — the
// handle must carry that position, not the url's position in the request.
// Driven through the real execute (YouTube branch, SSRF guard stubbed to block
// one url) so no network or scraper backend is touched.

const youtubeMocks = vi.hoisted(() => ({
  fetchTranscript: vi.fn(async (url: string) => ({
    videoDetails: { title: `Video ${url.slice(-3)}` },
    segments: [{ text: `transcript of ${url}`, duration: 1, offset: 0 }]
  })),
  toPlainText: vi.fn((segments: { text: string }[], separator = '\n') =>
    segments.map(s => s.text).join(separator)
  ),
  YoutubeTranscriptNotAvailableLanguageError: class extends Error {}
}))

vi.mock('youtube-transcript-plus', () => youtubeMocks)
vi.mock('@/lib/utils/usage-logging', () => ({ logToolPayload: vi.fn() }))
vi.mock('@/lib/utils/ssrf-guard', () => ({
  assertUrlAllowed: vi.fn(async (u: string) => {
    if (u.includes('blocked')) throw new Error('blocked for test')
  })
}))

import { createFetchTool } from '../fetch'

const GOOD_1 = 'https://www.youtube.com/watch?v=AAAAAAAAAAA'
const BLOCKED = 'https://blocked.example/page'
const GOOD_2 = 'https://youtu.be/BBBBBBBBBBB'
const CALL_ID = 'f3c1d2e4-5b6a-4c7d-8e9f-0a1b2c3d4e5f'

const tool = createFetchTool()

async function execute(url: string | string[]) {
  const out = tool.execute!({ url, type: 'regular' }, {
    toolCallId: CALL_ID,
    messages: []
  } as any) as AsyncIterable<Record<string, any>>
  let last: Record<string, any> | undefined
  for await (const c of out) last = c
  return last!
}

// Typed loosely: the tests assert the concrete json shape themselves.
async function modelOutput(output: unknown): Promise<unknown> {
  return tool.toModelOutput!({
    toolCallId: CALL_ID,
    input: { url: '', type: 'regular' },
    output: output as never
  })
}

function resolve(cite: string, output: unknown) {
  const m = /^\[(\d+)\]\(#([^)]+)\)$/.exec(cite)!
  const maps = extractCitationMaps({
    id: 'm',
    role: 'assistant',
    parts: [
      {
        type: 'tool-fetch',
        toolCallId: CALL_ID,
        state: 'output-available',
        output
      }
    ]
  } as unknown as UIMessage)
  return resolveCitationAnchor(parseInt(m[1], 10), m[2], maps)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('fetch toModelOutput — CITATION_HANDLES on (default)', () => {
  it('numbers a multi-url fetch by merged position; the failed url is skipped', async () => {
    const output = await execute([GOOD_1, BLOCKED, GOOD_2])
    expect(output.results.map((r: { url: string }) => r.url)).toEqual([
      GOOD_1,
      GOOD_2
    ])

    const mo = (await modelOutput(output)) as {
      type: 'json'
      value: { results: Array<{ cite: string; url: string }> }
    }
    expect(mo.type).toBe('json')
    expect(mo.value.results.map(r => r.cite)).toEqual([
      `[1](#${CALL_ID})`,
      `[2](#${CALL_ID})`
    ])
    // Round trip: each cite renders the very page it labels (the stored UI
    // part has no cites — they exist only in what the model sees).
    for (const r of mo.value.results) {
      const res = resolve(r.cite, output)
      expect(res.status).toBe('own')
      expect(res.status !== 'unresolved' && res.source.url).toBe(r.url)
    }
    expect(output.results[0]).not.toHaveProperty('cite')
  })

  it('gives a one-page fetch [1]', async () => {
    const output = await execute(GOOD_1)
    const mo = (await modelOutput(output)) as {
      value: { results: Array<{ cite: string }> }
    }
    expect(mo.value.results[0].cite).toBe(`[1](#${CALL_ID})`)
  })

  it('offers nothing to cite on a failed fetch', async () => {
    const output = await execute(BLOCKED)
    expect(output.results[0].title).toMatch(/^Fetch failed:/)
    const mo = (await modelOutput(output)) as {
      value: { results: Array<Record<string, unknown>> }
    }
    expect(mo.value.results[0]).not.toHaveProperty('cite')
  })
})

describe('fetch toModelOutput — CITATION_HANDLES=off', () => {
  it('is exactly what the SDK sends for a tool without toModelOutput', async () => {
    vi.stubEnv('CITATION_HANDLES', 'off')
    const output = await execute([GOOD_1, BLOCKED, GOOD_2])
    const mo = await modelOutput(output)
    // createToolModelOutput's default: { type: 'json', value: output }.
    expect(mo).toEqual({ type: 'json', value: output })
    expect((mo as { value: unknown }).value).toBe(output)
    expect(JSON.stringify(mo)).not.toContain('"cite"')
  })
})
