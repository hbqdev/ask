import { MockLanguageModelV3 } from 'ai/test'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi
} from 'vitest'

import { ANSWER_NOW_NOTE } from '../answer-deadline'
import { getCitationReminderText } from '../citation-reminder'
import { createResearcher } from '../researcher'

// The search-round cap through the REAL researcher loop (prepareStep, the
// dedup/source/deadline wrappers, the ToolLoopAgent). Only the edges are
// stubbed: a model that follows a per-test script of actions regardless of
// what it is offered or told (prod chat cznh8gc1gz41vq2lwjb560br: 80 refused
// search calls over ~30 steps; lab chat jcckydan2uqv7l4qelyjq1ob: search calls
// on every step after search was withdrawn), a search backend whose third call
// onward returns the round-cap refusal shape lib/tools/search.ts yields, and a
// fetch backend. Every model call records the tools it was offered and its
// system prompt.

// Search calls that run for real before the cap refuses the rest.
const REAL_SEARCHES = 2

type Action = 'search' | 'search-invalid' | 'fetch' | 'answer'

const state = vi.hoisted(() => ({
  script: [] as string[],
  // Like mistral-large-4 in a direct Ollama replay: offered NO tools (plus the
  // answer-now note), it writes the answer instead of following its script.
  answersWithoutTools: false,
  calls: 0,
  searchCalls: 0,
  fetchCalls: 0,
  advertised: [] as string[][],
  systems: [] as string[],
  lastMessages: [] as unknown[],
  clockOffsetMs: 0,
  deadlineAfterCall: null as number | null
}))

vi.mock('@/lib/memory/inject', () => ({
  getMemoryInjection: vi.fn(async () => '')
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

vi.mock('../../utils/registry', () => ({
  getModel: vi.fn(
    () =>
      new MockLanguageModelV3({
        doStream: async ({ tools, prompt }) => {
          state.calls++
          const n = state.calls
          state.advertised.push((tools ?? []).map(t => t.name))
          state.systems.push(
            prompt
              .filter(m => m.role === 'system')
              .map(m => String(m.content))
              .join('\n')
          )
          state.lastMessages.push(prompt[prompt.length - 1])
          if (state.deadlineAfterCall !== null && n >= state.deadlineAfterCall)
            state.clockOffsetMs = 250_000
          const action =
            state.answersWithoutTools && (tools ?? []).length === 0
              ? 'answer'
              : (state.script[n - 1] ?? 'answer')
          const call =
            action === 'search'
              ? {
                  toolName: 'search',
                  input: JSON.stringify({ query: `distinct query ${n}` })
                }
              : action === 'search-invalid'
                ? // Lab step 4: invented args for a tool it no longer saw.
                  {
                    toolName: 'search',
                    input: JSON.stringify({ search_mode: 'news', recent: true })
                  }
                : action === 'fetch'
                  ? {
                      toolName: 'fetch',
                      input: JSON.stringify({ url: 'https://example.com/1' })
                    }
                  : null
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: 'stream-start', warnings: [] })
                if (call) {
                  c.enqueue({
                    type: 'tool-call',
                    toolCallId: `call-${n}`,
                    ...call
                  })
                  c.enqueue({
                    type: 'finish',
                    finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                    usage: USAGE
                  })
                } else {
                  c.enqueue({ type: 'text-start', id: 't' })
                  c.enqueue({ type: 'text-delta', id: 't', delta: '## Answer' })
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
  )
}))

vi.mock('../../tools/search', async () => {
  const { tool } = await vi.importActual<typeof import('ai')>('ai')
  const { searchSchema } = await vi.importActual<
    typeof import('@/lib/schema/search')
  >('@/lib/schema/search')
  return {
    createSearchTool: vi.fn(() =>
      tool({
        description: 'fake search',
        inputSchema: searchSchema,
        async *execute(params: any) {
          state.searchCalls++
          const n = state.searchCalls
          if (n > REAL_SEARCHES) {
            // lib/tools/search.ts past the round cap.
            yield {
              state: 'complete' as const,
              results: [],
              images: [],
              query: params.query,
              number_of_results: 0,
              searchLimitReached: true,
              notice: 'Search limit reached (3 rounds). Answer now.'
            }
            return
          }
          yield { state: 'searching' as const, query: params.query }
          yield {
            state: 'complete' as const,
            query: params.query,
            images: [],
            number_of_results: 1,
            results: [
              {
                title: `Source ${n}`,
                url: `https://example.com/${n}`,
                content: 'text'
              }
            ]
          }
        }
      })
    )
  }
})

vi.mock('../../tools/fetch', async () => {
  const actual =
    await vi.importActual<typeof import('../../tools/fetch')>(
      '../../tools/fetch'
    )
  const { tool } = await vi.importActual<typeof import('ai')>('ai')
  const { z } = await vi.importActual<typeof import('zod')>('zod')
  return {
    ...actual,
    createFetchTool: vi.fn(() =>
      tool({
        description: 'fake fetch',
        inputSchema: z.object({ url: z.string() }),
        async execute({ url }: { url: string }) {
          state.fetchCalls++
          return {
            state: 'complete' as const,
            query: '',
            images: [],
            results: [{ title: 'Page', url, content: 'full text' }]
          }
        }
      })
    )
  }
})

async function runTurn(
  script: Action[],
  searchMode: 'balanced' | 'quality' = 'balanced'
) {
  state.script = script
  const agent = await createResearcher({
    model: 'ollama:mistral-large-4:cloud',
    searchMode,
    alwaysSearch: false,
    skipSearch: false,
    needsSources: true,
    currentChatId: 'chat-search-cap-test'
  })
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'the user question' }]
  })
  await result.consumeStream()
  return { steps: await result.steps, text: await result.text }
}

const logLines = (log: MockInstance<typeof console.log>, prefix: string) =>
  log.mock.calls
    .map(args => String(args[0]))
    .filter(line => line.startsWith(prefix))

const noteCount = (system: string) => system.split(ANSWER_NOW_NOTE).length - 1

const WITHDRAWN_LOG = `[search-cap] search withdrawn at step ${REAL_SEARCHES + 1} after the round cap (chat=chat-search-cap-test)`
const evasionLog = (step: number) =>
  `[search-cap] model kept calling search after withdrawal at step ${step} — tools withdrawn, answering now (chat=chat-search-cap-test)`

let log: MockInstance<typeof console.log>

beforeEach(() => {
  state.script = []
  state.answersWithoutTools = false
  state.calls = 0
  state.searchCalls = 0
  state.fetchCalls = 0
  state.advertised.length = 0
  state.systems.length = 0
  state.lastMessages.length = 0
  state.clockOffsetMs = 0
  state.deadlineAfterCall = null
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(
    () => realNow() + state.clockOffsetMs
  )
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('createResearcher — search round cap: withdraw, then answer-now', () => {
  it('a model that keeps calling search: offered → withdrawn → answer-now with no tools', async () => {
    // Searches on every call it gets until call 6.
    const { steps, text } = await runTurn([
      'search',
      'search',
      'search',
      'search',
      'search',
      'answer'
    ])
    expect(steps).toHaveLength(6)
    expect(text).toBe('## Answer')

    // Steps 0-2 come before any capped result (step 2's own search is the
    // first one refused): search is offered as usual, no answer-now note.
    const all = state.advertised[0]
    expect(all).toContain('search')
    for (const i of [0, 1, 2]) {
      expect(state.advertised[i]).toEqual(all)
      expect(noteCount(state.systems[i])).toBe(0)
    }
    // Step 3: search withdrawn, everything else as before. The model calls
    // search anyway; the tool's own cap refusal is the backstop.
    expect(state.advertised[3]).toEqual(all.filter(t => t !== 'search'))
    expect(state.advertised[3]).toContain('fetch')
    expect(noteCount(state.systems[3])).toBe(0)
    expect(steps[3].toolResults[0]?.output).toMatchObject({
      searchLimitReached: true
    })
    // Steps 4-5: it searched after the withdrawal, so answer-now: no tools
    // and the answer-now note, once.
    for (const i of [4, 5]) {
      expect(state.advertised[i]).toEqual([])
      expect(noteCount(state.systems[i])).toBe(1)
    }
    // Step 4's search was refused without reaching the search tool.
    expect(state.searchCalls).toBe(4)
    expect(steps[4].toolResults[0]?.output).toMatchObject({ answerNow: true })

    expect(logLines(log, '[search-cap] search withdrawn')).toEqual([
      WITHDRAWN_LOG
    ])
    expect(logLines(log, '[search-cap] model kept calling')).toEqual([
      evasionLog(4)
    ])
    // Not the time deadline.
    expect(logLines(log, '[deadline]')).toEqual([])
  })

  it('an invalid-input search call after the withdrawal also switches to answer-now', async () => {
    const { steps, text } = await runTurn([
      'search',
      'search',
      'search',
      'search-invalid',
      'answer'
    ])
    // How AI SDK v6 records it: an `invalid` tool call plus a tool-error.
    const call = steps[3].toolCalls[0] as { toolName: string; invalid?: true }
    expect(call).toMatchObject({ toolName: 'search', invalid: true })
    expect(steps[3].content.some(p => p.type === 'tool-error')).toBe(true)

    expect(state.advertised[3]).not.toContain('search')
    expect(state.advertised[3]).toContain('fetch')
    expect(state.advertised[4]).toEqual([])
    expect(noteCount(state.systems[4])).toBe(1)
    expect(text).toBe('## Answer')
    expect(logLines(log, '[search-cap] model kept calling')).toEqual([
      evasionLog(4)
    ])
  })

  it('a compliant model is unaffected: fetch after the withdrawal keeps its tools', async () => {
    const { steps, text } = await runTurn([
      'search',
      'search',
      'search',
      'fetch',
      'answer'
    ])
    expect(steps).toHaveLength(5)
    expect(text).toBe('## Answer')
    const withoutSearch = state.advertised[0].filter(t => t !== 'search')
    for (const i of [3, 4]) {
      expect(state.advertised[i]).toEqual(withoutSearch)
      expect(noteCount(state.systems[i])).toBe(0)
    }
    expect(state.fetchCalls).toBe(1)
    expect(logLines(log, '[search-cap] search withdrawn')).toEqual([
      WITHDRAWN_LOG
    ])
    expect(logLines(log, '[search-cap] model kept calling')).toEqual([])
  })

  it('the answer-now step gets the citation reminder appended, as the deadline step does', async () => {
    // Both withdraw every tool and add the answer-now note, so the step writes
    // the answer by construction (citation-reminder.ts `append` mode).
    vi.stubEnv('CITATION_REMINDER', 'on')
    await runTurn(['search', 'search', 'search', 'search', 'search', 'answer'])
    const endsWithReminder = (m: unknown) => {
      const msg = m as { role: string; content: unknown }
      return (
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        (msg.content as Array<{ type: string; text?: string }>).some(
          p => p.type === 'text' && p.text === getCitationReminderText()
        )
      )
    }
    // Steps 0-3: below the reminder's tool-call threshold, no answer-now.
    for (const m of state.lastMessages.slice(0, 4)) {
      expect(endsWithReminder(m)).toBe(false)
    }
    for (const m of state.lastMessages.slice(4)) {
      expect(endsWithReminder(m)).toBe(true)
    }
    expect(logLines(log, '[deadline]')).toEqual([])
  })

  it('the time deadline still applies on top, and its log still means time', async () => {
    // The clock passes the deadline during the 4th model call (step 3), so
    // every step from 4 on is a deadline step — and also an answer-now step,
    // since step 3 searched after the withdrawal.
    state.deadlineAfterCall = 4
    await runTurn(['search', 'search', 'search', 'search', 'search', 'answer'])
    // Step 3: withdrawn by the cap only.
    expect(state.advertised[3]).not.toContain('search')
    expect(state.advertised[3]).toContain('fetch')
    // Step 4 onward: no tools, one note, and the time deadline logged.
    for (const tools of state.advertised.slice(4)) {
      expect(tools).toEqual([])
    }
    for (const system of state.systems.slice(4)) {
      expect(noteCount(system)).toBe(1)
    }
    expect(
      logLines(log, '[deadline]').some(l => l.includes('elapsed at step 4'))
    ).toBe(true)
  })

  // Lab chat jcckydan2uqv7l4qelyjq1ob, follow-up turn (mistral-large-4,
  // balanced): after the cap it never searched again but fetched one URL per
  // step on steps 3-15 and answered at step 16 (17 steps, 1.21M prompt
  // tokens, 268s). Balanced has no fetch budget, so the cap notice already
  // says "answer now".
  const LAB_TURN: Action[] = [
    'search',
    'search',
    'search',
    ...Array.from({ length: 13 }, () => 'fetch' as const),
    'answer'
  ]
  const POST_CAP_LOG =
    '[search-cap] 4 tool steps after the round cap — tools withdrawn, answering now (chat=chat-search-cap-test)'

  it('balanced: after 4 tool steps past the cap the turn is answer-now and ends with text', async () => {
    state.answersWithoutTools = true
    const { steps, text } = await runTurn(LAB_TURN)
    // Steps 0-2 search (step 2 capped), steps 3-6 fetch, step 7 answers.
    expect(steps).toHaveLength(8)
    expect(text).toBe('## Answer')
    expect(state.fetchCalls).toBe(4)
    const withoutSearch = state.advertised[0].filter(t => t !== 'search')
    for (const i of [3, 4, 5, 6]) {
      expect(state.advertised[i]).toEqual(withoutSearch)
      expect(noteCount(state.systems[i])).toBe(0)
    }
    expect(state.advertised[7]).toEqual([])
    expect(noteCount(state.systems[7])).toBe(1)
    expect(logLines(log, '[search-cap] 4 tool steps')).toEqual([POST_CAP_LOG])
    expect(logLines(log, '[search-cap] model kept calling')).toEqual([])
    expect(logLines(log, '[deadline]')).toEqual([])
  })

  it('balanced: a fetch the model emits anyway on the answer-now step is refused', async () => {
    // This model keeps following its script with no tools offered.
    const { steps, text } = await runTurn(LAB_TURN)
    expect(text).toBe('## Answer')
    // Only the 4 fetches on offered steps ran; every later one was refused.
    expect(state.fetchCalls).toBe(4)
    expect(steps[7].toolResults[0]?.output).toMatchObject({ answerNow: true })
    for (const tools of state.advertised.slice(7)) {
      expect(tools).toEqual([])
    }
    expect(logLines(log, '[search-cap] 4 tool steps')).toEqual([POST_CAP_LOG])
  })

  it('quality: fetching after the cap stays allowed (it has a fetch budget)', async () => {
    const { steps, text } = await runTurn(LAB_TURN, 'quality')
    expect(steps).toHaveLength(LAB_TURN.length)
    expect(text).toBe('## Answer')
    expect(state.fetchCalls).toBe(13)
    const withoutSearch = state.advertised[0].filter(t => t !== 'search')
    for (const i of LAB_TURN.keys()) {
      if (i < 3) continue
      expect(state.advertised[i]).toEqual(withoutSearch)
      expect(noteCount(state.systems[i])).toBe(0)
    }
    expect(logLines(log, '[search-cap] 4 tool steps')).toEqual([])
  })
})
