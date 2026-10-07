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

import { buildSearchWithdrawnNote } from '../../tools/search-rounds'
import { ANSWER_NOW_NOTE } from '../answer-deadline'
import { getCitationReminderText } from '../citation-reminder'
import { createResearcher } from '../researcher'

// The search-round cap through the REAL researcher loop (prepareStep, the
// dedup/source/deadline wrappers, the ToolLoopAgent). Only the edges are
// stubbed:
// - a model that follows a per-test script of tool calls per step regardless
//   of what it is offered or told (prod chat cznh8gc1gz41vq2lwjb560br,
//   mistral-large-4: search calls on steps that no longer offered search, and
//   on the answer-now step);
// - a search backend that behaves like lib/tools/search.ts: it counts the
//   rounds that actually run into the researcher's turn counter, refuses past
//   the budget with the cap's result shape, does not count a near-duplicate
//   skip, and awaits between its cap check and its increment (the real tool
//   awaits the query embedding there), so parallel calls in one step all pass
//   the check — the known overshoot, deliberately not fixed here;
// - a fetch backend.
// Every model call records the tools it was offered and its system prompt.

// One model step: a single action, or several tool calls in parallel.
type Action =
  | 'search'
  // Near-duplicate of an earlier query: the search tool's own dedup skip.
  | 'search-dup'
  // Exact repeat of the turn's first query: the researcher's wrapper answers
  // it before the search tool runs.
  | 'search-repeat'
  | 'search-invalid'
  | 'fetch'
  | 'answer'
type Step = Action | Action[]

const state = vi.hoisted(() => ({
  script: [] as unknown[],
  // Like mistral-large-4 in a direct Ollama replay: offered NO tools (plus the
  // answer-now note), it writes the answer instead of following its script.
  answersWithoutTools: false,
  // false: the fake search keeps its own round counter instead of the
  // researcher's, so only the refusal fallback can withdraw search.
  sharedCounter: true,
  privateCounter: { used: 0 },
  calls: 0,
  // Calls that reached the search tool (real, skipped or refused by its cap).
  searchCalls: 0,
  realSearches: 0,
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
          const planned = (state.script[n - 1] ?? 'answer') as string | string[]
          const actions =
            state.answersWithoutTools && (tools ?? []).length === 0
              ? []
              : (Array.isArray(planned) ? planned : [planned]).filter(
                  a => a !== 'answer'
                )
          const inputFor = (action: string, i: number) => {
            switch (action) {
              case 'search':
                return {
                  toolName: 'search',
                  input: JSON.stringify({ query: `distinct query ${n}-${i}` })
                }
              case 'search-dup':
                return {
                  toolName: 'search',
                  input: JSON.stringify({ query: `near-dup ${n}-${i}` })
                }
              case 'search-repeat':
                return {
                  toolName: 'search',
                  input: JSON.stringify({ query: 'distinct query 1-0' })
                }
              case 'search-invalid':
                // Lab step 4: invented args for a tool it no longer saw.
                return {
                  toolName: 'search',
                  input: JSON.stringify({ search_mode: 'news', recent: true })
                }
              default:
                return {
                  toolName: 'fetch',
                  input: JSON.stringify({ url: 'https://example.com/1' })
                }
            }
          }
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: 'stream-start', warnings: [] })
                if (actions.length > 0) {
                  actions.forEach((action, i) =>
                    c.enqueue({
                      type: 'tool-call',
                      toolCallId: `call-${n}-${i}`,
                      ...inputFor(action, i)
                    })
                  )
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
  const { buildSearchRoundCapNotice, resolveSearchRoundsBudget } =
    await vi.importActual<typeof import('../../tools/search-rounds')>(
      '../../tools/search-rounds'
    )
  return {
    createSearchTool: vi.fn(
      (
        _model: string,
        opts?: {
          searchMode?: 'speed' | 'balanced' | 'quality'
          searchRounds?: { used: number }
        }
      ) =>
        tool({
          description: 'fake search',
          inputSchema: searchSchema,
          async *execute(params: any) {
            state.searchCalls++
            const rounds =
              state.sharedCounter && opts?.searchRounds
                ? opts.searchRounds
                : state.privateCounter
            const budget = resolveSearchRoundsBudget(opts?.searchMode)
            if (rounds.used >= budget) {
              yield {
                state: 'complete' as const,
                results: [],
                images: [],
                query: params.query,
                number_of_results: 0,
                searchLimitReached: true,
                notice: buildSearchRoundCapNotice(budget, false)
              }
              return
            }
            if (String(params.query).startsWith('near-dup')) {
              yield {
                state: 'complete' as const,
                results: [],
                images: [],
                query: params.query,
                number_of_results: 0,
                note: 'Skipped: this search is a near-duplicate of an earlier search this turn.'
              }
              return
            }
            await new Promise(resolve => setTimeout(resolve, 0))
            rounds.used++
            state.realSearches++
            const k = state.realSearches
            yield { state: 'searching' as const, query: params.query }
            yield {
              state: 'complete' as const,
              query: params.query,
              images: [],
              number_of_results: 1,
              results: [
                {
                  title: `Source ${k}`,
                  url: `https://example.com/${k}`,
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
  script: Step[],
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

const count = (system: string, note: string) => system.split(note).length - 1
const answerNowNotes = (system: string) => count(system, ANSWER_NOW_NOTE)
// Balanced, budget 3 (the default).
const NOTE = buildSearchWithdrawnNote(3, false)

type Steps = Awaited<ReturnType<typeof runTurn>>['steps']
const outputs = (steps: Steps) =>
  steps.flatMap(s =>
    s.toolResults.map(r => r?.output as Record<string, unknown> | undefined)
  )
const capRefusals = (steps: Steps) =>
  outputs(steps).filter(o => o?.searchLimitReached === true).length
const searchCallsMade = (steps: Steps) =>
  steps.flatMap(s => s.toolCalls).filter(c => c?.toolName === 'search').length

const withdrawnLog = (step: number, used: number, budget = 3) =>
  `[search-cap] search withdrawn at step ${step} after the round cap (rounds ${used}/${budget}, chat=chat-search-cap-test)`
const evasionLog = (step: number) =>
  `[search-cap] model kept calling search after withdrawal at step ${step} — tools withdrawn, answering now (chat=chat-search-cap-test)`

let log: MockInstance<typeof console.log>

beforeEach(() => {
  state.script = []
  state.answersWithoutTools = false
  state.sharedCounter = true
  state.privateCounter = { used: 0 }
  state.calls = 0
  state.searchCalls = 0
  state.realSearches = 0
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

describe('createResearcher — search withdrawn as soon as the budget is spent', () => {
  it('budget spent after step 1: step 2 offers no search, with the note once, and a compliant model answers with no refusal', async () => {
    const { steps, text } = await runTurn([
      'search',
      ['search', 'search'],
      'answer'
    ])
    expect(steps).toHaveLength(3)
    expect(text).toBe('## Answer')
    expect(state.realSearches).toBe(3)
    // Nothing was refused: the step that used to discover the cap is gone.
    expect(capRefusals(steps)).toBe(0)
    expect(state.searchCalls).toBe(3)

    const all = state.advertised[0]
    expect(all).toContain('search')
    for (const i of [0, 1]) {
      expect(state.advertised[i]).toEqual(all)
      expect(count(state.systems[i], NOTE)).toBe(0)
    }
    expect(state.advertised[2]).toEqual(all.filter(t => t !== 'search'))
    expect(state.advertised[2]).toContain('fetch')
    expect(count(state.systems[2], NOTE)).toBe(1)
    expect(answerNowNotes(state.systems[2])).toBe(0)

    expect(logLines(log, '[search-cap]')).toEqual([withdrawnLog(2, 3)])
    expect(logLines(log, '[deadline]')).toEqual([])
  })

  it('a model that calls search anyway at step 2: refused by the cap, step 3 is answer-now', async () => {
    const { steps, text } = await runTurn([
      'search',
      ['search', 'search'],
      'search',
      'search',
      'answer'
    ])
    expect(text).toBe('## Answer')
    expect(steps).toHaveLength(5)
    // Step 2 ran without search; the tool's own cap refused the call.
    expect(state.advertised[2]).not.toContain('search')
    expect(steps[2].toolResults[0]?.output).toMatchObject({
      searchLimitReached: true
    })
    // Steps 3-4: no tools, the answer-now note once, and not the withdrawal
    // note ("answer now" says it all; quality's would offer fetch).
    for (const i of [3, 4]) {
      expect(state.advertised[i]).toEqual([])
      expect(answerNowNotes(state.systems[i])).toBe(1)
      expect(count(state.systems[i], NOTE)).toBe(0)
    }
    // Step 3's call was refused without reaching the search tool.
    expect(state.searchCalls).toBe(4)
    expect(steps[3].toolResults[0]?.output).toMatchObject({ answerNow: true })

    expect(logLines(log, '[search-cap] search withdrawn')).toEqual([
      withdrawnLog(2, 3)
    ])
    expect(logLines(log, '[search-cap] model kept calling')).toEqual([
      evasionLog(3)
    ])
    expect(logLines(log, '[deadline]')).toEqual([])
  })

  it('an invalid-input search call on the withdrawn step also switches to answer-now', async () => {
    const { steps, text } = await runTurn([
      'search',
      ['search', 'search'],
      'search-invalid',
      'answer'
    ])
    // How AI SDK v6 records it: an `invalid` tool call plus a tool-error.
    const call = steps[2].toolCalls[0] as { toolName: string; invalid?: true }
    expect(call).toMatchObject({ toolName: 'search', invalid: true })
    expect(steps[2].content.some(p => p.type === 'tool-error')).toBe(true)

    expect(state.advertised[2]).not.toContain('search')
    expect(state.advertised[2]).toContain('fetch')
    expect(state.advertised[3]).toEqual([])
    expect(answerNowNotes(state.systems[3])).toBe(1)
    expect(text).toBe('## Answer')
    expect(logLines(log, '[search-cap] model kept calling')).toEqual([
      evasionLog(3)
    ])
  })

  it("the prod turn's shape: one step and 4 refused calls fewer, the parallel overshoot untouched", async () => {
    // Prod chat cznh8gc1gz41vq2lwjb560br (mistral-large-4, balanced, budget
    // 3), stored: step 0 1 search, step 1 4 parallel searches (5 ran), step 2
    // 4 refused (search still offered), step 3 4 refused (withdrawn), step 4
    // answer-now and 4 more search calls anyway, step 5 the answer: 6 steps,
    // 17 search calls. Same model behaviour per offer, replayed: the step
    // that was offered search with the budget already spent is gone.
    const four: Action[] = ['search', 'search', 'search', 'search']
    const { steps, text } = await runTurn([
      'search',
      four,
      four,
      four,
      'answer'
    ])
    expect(text).toBe('## Answer')
    expect(steps).toHaveLength(5)
    expect(searchCallsMade(steps)).toBe(13)
    // The overshoot (5 rounds on a budget of 3) is a separate decision.
    expect(state.realSearches).toBe(5)
    // Step 2: withdrawn with the note; its 4 calls refused by the tool's cap.
    expect(state.advertised[2]).not.toContain('search')
    expect(count(state.systems[2], NOTE)).toBe(1)
    expect(capRefusals(steps)).toBe(4)
    // Step 3: answer-now; its 4 calls refused before reaching the tool.
    expect(state.advertised[3]).toEqual([])
    expect(
      steps[3].toolResults.every(r => (r?.output as any)?.answerNow === true)
    ).toBe(true)
    expect(state.searchCalls).toBe(9)
    expect(logLines(log, '[search-cap] search withdrawn')).toEqual([
      withdrawnLog(2, 5)
    ])
    expect(logLines(log, '[search-cap] model kept calling')).toEqual([
      evasionLog(3)
    ])
  })

  it('dedup-skipped and repeated searches do not spend the budget: search stays offered', async () => {
    const { steps, text } = await runTurn([
      ['search', 'search'],
      ['search-dup', 'search-repeat'],
      'search',
      'answer'
    ])
    expect(text).toBe('## Answer')
    expect(steps).toHaveLength(4)
    // Step 1's skip and repeat ran nothing: 2 of 3 rounds after it.
    expect(steps[1].toolResults.map(r => r?.output)).toEqual([
      expect.objectContaining({ note: expect.stringContaining('Skipped') }),
      expect.objectContaining({ duplicateQuery: true })
    ])
    expect(state.advertised[2]).toContain('search')
    expect(count(state.systems[2], NOTE)).toBe(0)
    // Step 2's real search spends the last round; step 3 offers no search.
    expect(state.realSearches).toBe(3)
    expect(state.advertised[3]).not.toContain('search')
    expect(count(state.systems[3], NOTE)).toBe(1)
    expect(capRefusals(steps)).toBe(0)
    expect(logLines(log, '[search-cap]')).toEqual([withdrawnLog(3, 3)])
  })

  it('quality: the same proactive withdrawal, the note offers fetch, and fetching stays allowed', async () => {
    vi.stubEnv('SEARCH_ROUNDS_MAX_QUALITY', '2')
    const script: Step[] = [
      'search',
      'search',
      ...Array.from({ length: 6 }, () => 'fetch' as const),
      'answer'
    ]
    const { steps, text } = await runTurn(script, 'quality')
    expect(text).toBe('## Answer')
    expect(steps).toHaveLength(script.length)
    expect(state.fetchCalls).toBe(6)
    expect(capRefusals(steps)).toBe(0)
    const qualityNote = buildSearchWithdrawnNote(2, true)
    expect(qualityNote).toContain('You may still call `fetch`')
    const withoutSearch = state.advertised[0].filter(t => t !== 'search')
    expect(withoutSearch).toContain('fetch')
    for (const i of script.keys()) {
      if (i < 2) {
        expect(state.advertised[i]).toContain('search')
        expect(count(state.systems[i], qualityNote)).toBe(0)
        continue
      }
      expect(state.advertised[i]).toEqual(withoutSearch)
      expect(count(state.systems[i], qualityNote)).toBe(1)
      expect(answerNowNotes(state.systems[i])).toBe(0)
    }
    expect(logLines(log, '[search-cap]')).toEqual([withdrawnLog(2, 2, 2)])
  })

  it('fallback: a refusal still withdraws search from the next step when the counter is not shared', async () => {
    state.sharedCounter = false
    const { steps, text } = await runTurn([
      'search',
      ['search', 'search'],
      'search',
      'fetch',
      'answer'
    ])
    expect(text).toBe('## Answer')
    expect(steps).toHaveLength(5)
    // No counter to read: step 2 still offers search, and its call is refused.
    expect(state.advertised[2]).toContain('search')
    expect(steps[2].toolResults[0]?.output).toMatchObject({
      searchLimitReached: true
    })
    // Withdrawn from step 3; its fetch is fine (no search call after it).
    expect(state.advertised[3]).not.toContain('search')
    expect(count(state.systems[3], NOTE)).toBe(1)
    expect(state.advertised[4]).not.toContain('search')
    expect(logLines(log, '[search-cap] search withdrawn')).toEqual([
      withdrawnLog(3, 0)
    ])
    expect(logLines(log, '[search-cap] model kept calling')).toEqual([])
  })

  it('the answer-now step gets the citation reminder appended, as the deadline step does', async () => {
    // Both withdraw every tool and add the answer-now note, so the step writes
    // the answer by construction (citation-reminder.ts `append` mode).
    vi.stubEnv('CITATION_REMINDER', 'on')
    await runTurn([
      'search',
      ['search', 'search'],
      'search',
      'search',
      'answer'
    ])
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
    // Steps 0-2: below the reminder's tool-call threshold, no answer-now.
    for (const m of state.lastMessages.slice(0, 3)) {
      expect(endsWithReminder(m)).toBe(false)
    }
    for (const m of state.lastMessages.slice(3)) {
      expect(endsWithReminder(m)).toBe(true)
    }
    expect(logLines(log, '[deadline]')).toEqual([])
  })

  it('the time deadline still applies on top, and its log still means time', async () => {
    // The clock passes the deadline during the 3rd model call (step 2), so
    // every step from 3 on is a deadline step — and also an answer-now step,
    // since step 2 searched after the withdrawal.
    state.deadlineAfterCall = 3
    await runTurn([
      'search',
      ['search', 'search'],
      'search',
      'search',
      'answer'
    ])
    // Step 2: withdrawn by the budget only, with the note.
    expect(state.advertised[2]).not.toContain('search')
    expect(state.advertised[2]).toContain('fetch')
    expect(count(state.systems[2], NOTE)).toBe(1)
    // Step 3 onward: no tools, one answer-now note, no withdrawal note, and
    // the time deadline logged.
    for (const tools of state.advertised.slice(3)) {
      expect(tools).toEqual([])
    }
    for (const system of state.systems.slice(3)) {
      expect(answerNowNotes(system)).toBe(1)
      expect(count(system, NOTE)).toBe(0)
    }
    expect(
      logLines(log, '[deadline]').some(l => l.includes('elapsed at step 3'))
    ).toBe(true)
  })

  // Lab chat jcckydan2uqv7l4qelyjq1ob, follow-up turn (mistral-large-4,
  // balanced): once search was gone it never searched again but fetched one
  // URL per step for 13 steps before answering (17 steps, 1.21M prompt
  // tokens, 268s). Balanced has no fetch budget, so its notes say "answer now".
  const LAB_TURN: Step[] = [
    'search',
    ['search', 'search'],
    ...Array.from({ length: 13 }, () => 'fetch' as const),
    'answer'
  ]
  const POST_CAP_LOG =
    '[search-cap] 4 tool steps after the round cap — tools withdrawn, answering now (chat=chat-search-cap-test)'

  it('balanced: 4 tool steps after the withdrawal, then answer-now, and the turn ends with text', async () => {
    state.answersWithoutTools = true
    const { steps, text } = await runTurn(LAB_TURN)
    // Steps 0-1 search, steps 2-5 fetch (search withdrawn), step 6 answers.
    expect(steps).toHaveLength(7)
    expect(text).toBe('## Answer')
    expect(state.fetchCalls).toBe(4)
    const withoutSearch = state.advertised[0].filter(t => t !== 'search')
    for (const i of [2, 3, 4, 5]) {
      expect(state.advertised[i]).toEqual(withoutSearch)
      expect(count(state.systems[i], NOTE)).toBe(1)
      expect(answerNowNotes(state.systems[i])).toBe(0)
    }
    expect(state.advertised[6]).toEqual([])
    expect(answerNowNotes(state.systems[6])).toBe(1)
    expect(count(state.systems[6], NOTE)).toBe(0)
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
    expect(steps[6].toolResults[0]?.output).toMatchObject({ answerNow: true })
    for (const tools of state.advertised.slice(6)) {
      expect(tools).toEqual([])
    }
    expect(logLines(log, '[search-cap] 4 tool steps')).toEqual([POST_CAP_LOG])
  })
})
