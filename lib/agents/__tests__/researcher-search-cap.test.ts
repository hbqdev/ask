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

import { createResearcher } from '../researcher'

// The search-round cap through the REAL researcher loop (prepareStep, the
// dedup/source/deadline wrappers, the ToolLoopAgent). Only the edges are
// stubbed: a model that keeps calling `search` regardless of what it is told
// (prod chat cznh8gc1gz41vq2lwjb560br: 80 refused calls over ~30 steps), and a
// search backend whose third call onward returns the round-cap refusal shape
// lib/tools/search.ts yields. Every model call records the tools it was
// offered.

// The model calls search on its first LOOPY calls, then answers.
const LOOPY = 5
// Search calls that run for real before the cap refuses the rest.
const REAL_SEARCHES = 2

const state = vi.hoisted(() => ({
  calls: 0,
  searchCalls: 0,
  advertised: [] as string[][],
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
        doStream: async ({ tools }) => {
          state.calls++
          const n = state.calls
          state.advertised.push((tools ?? []).map(t => t.name))
          if (state.deadlineAfterCall !== null && n >= state.deadlineAfterCall)
            state.clockOffsetMs = 250_000
          const isTool = n <= LOOPY
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: 'stream-start', warnings: [] })
                if (isTool) {
                  c.enqueue({
                    type: 'tool-call',
                    toolCallId: `search-${n}`,
                    toolName: 'search',
                    input: JSON.stringify({ query: `distinct query ${n}` })
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

async function runTurn() {
  const agent = await createResearcher({
    model: 'ollama:mistral-large-4:cloud',
    searchMode: 'balanced',
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

const withdrawnLogs = (log: MockInstance<typeof console.log>) =>
  log.mock.calls
    .map(args => String(args[0]))
    .filter(line => line.startsWith('[search-cap]'))

let log: MockInstance<typeof console.log>

beforeEach(() => {
  state.calls = 0
  state.searchCalls = 0
  state.advertised.length = 0
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

describe('createResearcher — search withdrawn after the round cap', () => {
  it('stops advertising search from the step after the first capped result', async () => {
    const { steps, text } = await runTurn()

    // Steps 0-4 searched, step 5 answered.
    expect(steps).toHaveLength(LOOPY + 1)
    expect(text).toBe('## Answer')

    // Steps 0-2 come before any capped result (step 2's own search is the
    // first one refused): search is offered as usual.
    for (const tools of state.advertised.slice(0, REAL_SEARCHES + 1)) {
      expect(tools).toContain('search')
    }
    // Every later step: no search, everything else exactly as before.
    const before = state.advertised[0].filter(t => t !== 'search')
    for (const tools of state.advertised.slice(REAL_SEARCHES + 1)) {
      expect(tools).not.toContain('search')
      expect(tools).toEqual(before)
    }
    expect(before).toContain('fetch')

    // Not advertising is not enforcement: the loopy model's later calls still
    // reach the search tool, whose own cap refusal stays the backstop.
    expect(state.searchCalls).toBe(LOOPY)

    // Logged once per turn, at the first withdrawn step.
    expect(withdrawnLogs(log)).toEqual([
      `[search-cap] search withdrawn at step ${REAL_SEARCHES + 1} after the round cap (chat=chat-search-cap-test)`
    ])
  })

  it("the answer deadline's empty tool set still wins once it fires", async () => {
    // The clock passes the deadline during the 4th model call (step 3), so
    // every step from 4 on is a deadline step.
    state.deadlineAfterCall = 4
    await runTurn()
    // Step 3: withdrawn by the cap only.
    expect(state.advertised[3]).not.toContain('search')
    expect(state.advertised[3]).toContain('fetch')
    // Step 4 onward: the deadline withdrew every tool.
    for (const tools of state.advertised.slice(4)) {
      expect(tools).toEqual([])
    }
  })
})
