import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCitationReminderText } from '../citation-reminder'
import { createResearcher } from '../researcher'

// The citation reminder through the REAL researcher loop (prepareStep, the
// answer-step guard, the dedup/source/deadline wrappers, the ToolLoopAgent).
// Only the edges are stubbed: the answering model, which searches SEARCHES
// times and then answers, and the search backend. Every model call's prompt is
// recorded as the model got it, across every model instance the turn builds
// (the guard builds one per attempt).

const SEARCHES = 4

const state = vi.hoisted(() => ({
  calls: 0,
  prompts: [] as Array<Array<{ role: string; content: unknown }>>,
  // When set, Date.now() jumps past the answer deadline once this many model
  // calls have been made.
  deadlineAfterCall: null as number | null,
  clockOffsetMs: 0
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
        doStream: async ({ prompt }) => {
          state.calls++
          const n = state.calls
          state.prompts.push(prompt as never)
          if (state.deadlineAfterCall !== null && n >= state.deadlineAfterCall)
            state.clockOffsetMs = 250_000
          const isTool = n <= SEARCHES
          // The first answer attempt says DRAFT; whatever runs after it says
          // FINAL, so the test can tell which attempt reached the stream.
          const text =
            n === SEARCHES + 1 ? '## DRAFT answer' : '## FINAL answer'
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
                  c.enqueue({ type: 'text-delta', id: 't', delta: text })
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
  let n = 0
  return {
    createSearchTool: vi.fn(() =>
      tool({
        description: 'fake search',
        inputSchema: searchSchema,
        async *execute(params: any) {
          n++
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
    model: 'ollama:kimi-k2.6:cloud',
    searchMode: 'quality',
    alwaysSearch: false,
    skipSearch: false,
    needsSources: true,
    currentChatId: 'chat-reminder-test'
  })
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'the user question' }]
  })
  await result.consumeStream()
  return { steps: await result.steps, text: await result.text }
}

type Prompt = Array<{ role: string; content: unknown }>

function reminderCount(prompt: Prompt) {
  const reminder = getCitationReminderText()
  return prompt.filter(
    m =>
      m.role === 'user' &&
      Array.isArray(m.content) &&
      (m.content as Array<{ type: string; text?: string }>).some(
        p => p.type === 'text' && p.text === reminder
      )
  ).length
}

function endsWithReminder(prompt: Prompt) {
  const last = prompt[prompt.length - 1]
  return last.role === 'user' && reminderCount([last]) === 1
}

beforeEach(() => {
  state.calls = 0
  state.prompts.length = 0
  state.deadlineAfterCall = null
  state.clockOffsetMs = 0
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(
    () => realNow() + state.clockOffsetMs
  )
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('createResearcher — citation reminder on the answer step', () => {
  it('research steps never see it; the answer step is re-run with it, once', async () => {
    vi.stubEnv('CITATION_REMINDER_MIN_TOOL_CALLS', '3')
    const { steps, text } = await runTurn()

    // 4 search steps + 1 answer step; the answer step made two model calls.
    expect(steps).toHaveLength(SEARCHES + 1)
    expect(state.prompts).toHaveLength(SEARCHES + 2)

    // Every research call (including the guarded step 3, which searched) and
    // the aborted first answer attempt got the unchanged input.
    for (const p of state.prompts.slice(0, SEARCHES + 1)) {
      expect(reminderCount(p)).toBe(0)
    }
    // The re-run ends with the reminder, exactly once, and is what the turn
    // streamed: nothing of the aborted DRAFT attempt reaches the output.
    const rerun = state.prompts[SEARCHES + 1]
    expect(endsWithReminder(rerun)).toBe(true)
    expect(reminderCount(rerun)).toBe(1)
    expect(text).toBe('## FINAL answer')
    // Same input as the aborted attempt, plus the reminder.
    expect(rerun.slice(0, -1)).toEqual(state.prompts[SEARCHES])
  })

  it('below the threshold (default 8) the answer is not re-run', async () => {
    const { text } = await runTurn()
    expect(state.prompts).toHaveLength(SEARCHES + 1)
    for (const p of state.prompts) expect(reminderCount(p)).toBe(0)
    expect(text).toBe('## DRAFT answer')
  })

  it('CITATION_REMINDER=off disables it', async () => {
    vi.stubEnv('CITATION_REMINDER_MIN_TOOL_CALLS', '1')
    vi.stubEnv('CITATION_REMINDER', 'off')
    const { text } = await runTurn()
    for (const p of state.prompts) expect(reminderCount(p)).toBe(0)
    expect(text).toBe('## DRAFT answer')
  })

  it('on the answer-deadline step the reminder is appended directly (no re-run)', async () => {
    // Past the deadline from the 2nd model call on: steps from 2 have their
    // tools withdrawn, so each is an answer step by construction.
    state.deadlineAfterCall = 2
    await runTurn()
    expect(reminderCount(state.prompts[0])).toBe(0)
    expect(reminderCount(state.prompts[1])).toBe(0)
    for (const p of state.prompts.slice(2)) {
      expect(endsWithReminder(p)).toBe(true)
      expect(reminderCount(p)).toBe(1)
    }
  })
})
