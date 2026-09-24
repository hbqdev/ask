import { describe, expect, it, vi } from 'vitest'

// The fetch result must echo its own toolCallId so the model can cite a fetched
// page as [n](#toolCallId) — the id is otherwise invisible to it (the Ollama
// wire format carries no tool-call id on a tool result). Driven through the
// YouTube branch so no network or scraper backend is touched.

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

const URL_ = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

async function run(options: Record<string, unknown>, url = URL_) {
  const out = createFetchTool().execute!(
    { url, type: 'regular' },
    options as any
  ) as AsyncIterable<Record<string, unknown>>
  const chunks: Record<string, unknown>[] = []
  for await (const c of out) chunks.push(c)
  return chunks[chunks.length - 1]
}

describe('fetch tool output carries its toolCallId', () => {
  it('echoes the toolCallId on a successful fetch', async () => {
    youtubeMocks.fetchTranscript.mockResolvedValue({
      videoDetails: { title: 'A Video' },
      segments: [{ text: 'hello', duration: 1, offset: 0, lang: 'en' }]
    })
    const final = await run({ toolCallId: 'abc-123', messages: [] })
    expect(final.state).toBe('complete')
    expect(final.toolCallId).toBe('abc-123')
    expect((final.results as unknown[]).length).toBe(1)
  })

  it('omits toolCallId when the caller supplies none (url-rag driver)', async () => {
    youtubeMocks.fetchTranscript.mockResolvedValue({
      videoDetails: { title: 'A Video' },
      segments: [{ text: 'hello', duration: 1, offset: 0, lang: 'en' }]
    })
    const final = await run({})
    expect(final.state).toBe('complete')
    expect('toolCallId' in final).toBe(false)
  })

  it('does not offer an id to cite on a failed fetch', async () => {
    const final = await run({ toolCallId: 'abc-123', messages: [] }, '')
    expect(final.state).toBe('complete')
    expect(String((final.results as { title: string }[])[0].title)).toMatch(
      /Fetch failed/
    )
    expect('toolCallId' in final).toBe(false)
  })
})
