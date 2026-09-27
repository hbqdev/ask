import {
  convertToModelMessages,
  pruneMessages,
  readUIMessageStream,
  type UIMessage
} from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildDocumentRetrievalArtifacts,
  documentSourceId
} from '@/lib/streaming/helpers/document-retrieval-part'
import { stripCitationAnchorsFromHistory } from '@/lib/streaming/helpers/strip-citation-anchors-from-history'
import { auditCitations, resolveCitationAnchor } from '@/lib/utils/citation'
import { extractCitationMaps } from '@/lib/utils/citation'

import { createResearcher } from '../researcher'

// CITATION_HANDLES end to end through the REAL researcher loop: the forced
// step-0 search (synthetic model + real dedup/source/deadline wrappers + the
// real search toModelOutput), a real multi-url fetch in which one url fails,
// and an injected documentRetrieval pair. The answering model copies every
// `cite` string it is shown, verbatim, into its answer; the answer is then
// assembled from the UI stream exactly as the client assembles it and resolved
// by the renderer's own code. Every copied cite must render the very result it
// labelled — the round trip that running-count numbering broke.

const ANSWER_SENTENCE = 'A supported fact.'
const CITE_KEY_RE = /"cite":"(\[\d+\]\(#[^)"]+\))"/g

const state = vi.hoisted(() => ({
  prompts: [] as unknown[],
  // What the model saw: cite string → url of the result it labelled.
  citeToUrl: new Map<string, string>()
}))

vi.mock('@/lib/memory/inject', () => ({
  getMemoryInjection: vi.fn(async () => '')
}))
vi.mock('youtube-transcript-plus', () => ({
  fetchTranscript: vi.fn(async (url: string) => ({
    videoDetails: { title: `Video ${url.slice(-3)}` },
    segments: [{ text: `transcript of ${url}`, duration: 1, offset: 0 }]
  })),
  toPlainText: vi.fn((segments: { text: string }[], sep = '\n') =>
    segments.map(s => s.text).join(sep)
  ),
  YoutubeTranscriptNotAvailableLanguageError: class extends Error {}
}))
vi.mock('@/lib/utils/usage-logging', () => ({ logToolPayload: vi.fn() }))
vi.mock('@/lib/utils/ssrf-guard', () => ({
  assertUrlAllowed: vi.fn(async (u: string) => {
    if (u.includes('blocked')) throw new Error('blocked for test')
  })
}))

const USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
}

/** Every `cite` the model was shown, with the url of the result it sits on. */
function recordCites(prompt: unknown) {
  for (const msg of prompt as Array<{ role: string; content: any }>) {
    if (msg.role !== 'tool') continue
    for (const part of msg.content) {
      const results = part?.output?.value?.results
      if (!Array.isArray(results)) continue
      for (const r of results) {
        if (typeof r?.cite === 'string') state.citeToUrl.set(r.cite, r.url)
      }
    }
  }
}

vi.mock('../../utils/registry', () => ({
  getModel: vi.fn(() => {
    let call = 0
    return new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        call++
        state.prompts.push(prompt)
        const n = call
        // Step 2's answer: one sentence per cite, the cite copied verbatim.
        let answer = 'Answer.'
        if (n === 2) {
          recordCites(prompt)
          answer = [...state.citeToUrl.keys()]
            .map(cite => `${ANSWER_SENTENCE} ${cite}`)
            .join('\n')
        }
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: 'stream-start', warnings: [] })
              if (n === 1) {
                c.enqueue({
                  type: 'tool-call',
                  toolCallId: 'fetch-call-7f3a',
                  toolName: 'fetch',
                  input: JSON.stringify({
                    url: [
                      'https://www.youtube.com/watch?v=AAAAAAAAAAA',
                      'https://blocked.example/page',
                      'https://youtu.be/BBBBBBBBBBB'
                    ]
                  })
                })
                c.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage: USAGE
                })
              } else {
                c.enqueue({ type: 'text-start', id: 't' })
                c.enqueue({ type: 'text-delta', id: 't', delta: answer })
                c.enqueue({ type: 'text-end', id: 't' })
                c.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: USAGE
                })
              }
              c.close()
            }
          })
        }
      }
    })
  })
}))

// The search backend is stubbed; its toModelOutput is the REAL one, so the
// model sees exactly what production hands it.
vi.mock('../../tools/search', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/tools/search')>(
      '@/lib/tools/search'
    )
  const { tool } = await vi.importActual<typeof import('ai')>('ai')
  const { searchSchema } = await vi.importActual<
    typeof import('@/lib/schema/search')
  >('@/lib/schema/search')
  const real = actual.createSearchTool('openai:gpt-4o-mini')
  return {
    ...actual,
    createSearchTool: vi.fn(() =>
      tool({
        description: 'stub search',
        inputSchema: searchSchema,
        toModelOutput: real.toModelOutput as any,
        async *execute(params: any, context: any) {
          yield {
            state: 'complete' as const,
            query: params.query,
            images: [],
            number_of_results: 5,
            results: [1, 2, 3, 4, 5].map(i => ({
              title: `Search result ${i}`,
              url: `https://s${i}.example/page`,
              content: `search content ${i}`
            })),
            toolCallId: context?.toolCallId
          }
        }
      })
    )
  }
})

const DOC_INPUT = {
  sourceId: documentSourceId('doc', 'file-9'),
  title: 'report.pdf',
  url: 'https://ask.example/uploads/u/chats/c/report.pdf',
  chunks: ['revenue 4.2M', 'headcount 37'],
  query: 'q'
}

/**
 * One turn as create-chat-stream-response runs it: the documentRetrieval pair
 * appended to the model input and its UI part written to the stream, then the
 * researcher's stream assembled into the assistant UIMessage the client
 * renders and persistence stores.
 */
async function runTurn() {
  const artifacts = buildDocumentRetrievalArtifacts(DOC_INPUT)!
  const agent = await createResearcher({
    model: 'ollama:kimi-k2.6:cloud',
    searchMode: 'balanced',
    standaloneQuery: 'node 24 release notes',
    alwaysSearch: true,
    documentRetrievalSources: [
      { toolCallId: artifacts.toolCallId, title: DOC_INPUT.title }
    ]
  })
  const result = await agent.stream({
    messages: [
      { role: 'user', content: 'what changed in node 24?' },
      ...artifacts.modelMessages
    ]
  })
  let message: UIMessage | undefined
  for await (const m of readUIMessageStream({
    stream: result.toUIMessageStream()
  })) {
    message = m
  }
  const steps = await result.steps
  return {
    message: {
      ...message!,
      parts: [artifacts.part, ...message!.parts]
    } as UIMessage,
    forcedId: steps[0].toolCalls[0]!.toolCallId
  }
}

beforeEach(() => {
  state.prompts.length = 0
  state.citeToUrl.clear()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('CITATION_HANDLES on — cites copied from the tool results render their own result', () => {
  it('forced search, multi-url fetch with a failed url, and documentRetrieval', async () => {
    vi.stubEnv('CITATION_HANDLES', '')
    const { message, forcedId } = await runTurn()

    // What the model was handed: 5 search + 2 fetched pages (the blocked url
    // is left out) + 2 document excerpts, each with its own handle.
    const cites = [...state.citeToUrl.keys()]
    expect(cites).toHaveLength(9)
    expect(cites).toEqual(
      expect.arrayContaining([
        `[1](#${forcedId})`,
        `[5](#${forcedId})`,
        '[1](#fetch-call-7f3a)',
        '[2](#fetch-call-7f3a)',
        `[1](#${DOC_INPUT.sourceId})`,
        `[2](#${DOC_INPUT.sourceId})`
      ])
    )
    expect(cites).not.toContain('[3](#fetch-call-7f3a)')

    // The renderer's audit over the assembled message: every anchor is the
    // message's own, none repaired, none dropped.
    expect(auditCitations(message)).toEqual({
      total: 9,
      own: 9,
      recovered: 0,
      unresolved: 0
    })
    // And each one renders the page it labelled, not merely some page.
    const maps = extractCitationMaps(message)
    for (const [cite, url] of state.citeToUrl) {
      const [, n, id] = /^\[(\d+)\]\(#(.+)\)$/.exec(cite)!
      const res = resolveCitationAnchor(Number(n), id, maps)
      expect(res.status, cite).toBe('own')
      expect(res.status !== 'unresolved' && res.source.url, cite).toBe(url)
    }
    // Nothing the client stores carries a cite: handles are model-only.
    const stored = JSON.stringify(message.parts.filter(p => p.type !== 'text'))
    expect(stored).not.toContain('"cite"')
  })

  it('tells the model to copy the cite string (guidance, forced-search and attached-source clauses)', async () => {
    vi.stubEnv('CITATION_HANDLES', '')
    await runTurn()
    const system = JSON.stringify((state.prompts[0] as any[])[0])
    expect(system).toContain('copy its `cite` string exactly')
    expect(system).toContain("copying each result's `cite` string")
    expect(system).toContain('copy the `cite` string of the excerpt you used')
    expect(system).not.toContain('MUST be the digit 1')
  })
})

describe('CITATION_HANDLES=off — no handles anywhere the model looks', () => {
  it('tool results and prompt carry no cite', async () => {
    vi.stubEnv('CITATION_HANDLES', 'off')
    await runTurn()
    const everything = JSON.stringify(state.prompts)
    expect(everything.match(CITE_KEY_RE)).toBeNull()
    expect(everything).not.toContain('`cite`')
    expect(everything).toContain('MUST be the digit 1')
    expect(everything).toContain('with the real id that call returned')
  })
})

// A cite string lives only in the CURRENT turn's model-facing tool output.
// Next turn, the answer text that copied it is prior history: the stripper
// must remove it, and the prior turn's stored tool output never had one.
describe('history: prior-turn cite strings do not survive into the next turn', () => {
  it('stripped from the answer text, absent from the stored tool part', async () => {
    vi.stubEnv('CITATION_HANDLES', '')
    const { message } = await runTurn()
    expect(auditCitations(message).total).toBe(9)

    const history: UIMessage[] = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'what changed in node 24?' }]
      },
      { ...message, id: 'a1' },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'and 25?' }] }
    ]
    // The route's exact history pipeline (create-chat-stream-response.ts).
    const stripped = stripCitationAnchorsFromHistory(history)
    const modelMessages = pruneMessages({
      messages: await convertToModelMessages(stripped),
      reasoning: 'before-last-message',
      toolCalls: 'before-last-2-messages',
      emptyMessages: 'remove'
    })
    const bound = JSON.stringify(modelMessages)
    expect(bound).not.toMatch(/\[\d+\]\(#/)
    expect(bound).not.toContain('"cite"')
    // The prose of the earlier answer is kept.
    expect(bound).toContain(ANSWER_SENTENCE)
  })

  it('a continued turn (trailing assistant message) keeps its own anchors', () => {
    const own = '[2](#fetch-call-7f3a)'
    const msgs: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: `Fact. ${own}` }]
      }
    ]
    const out = stripCitationAnchorsFromHistory(msgs)
    expect((out[1].parts[0] as { text: string }).text).toContain(own)
  })
})
