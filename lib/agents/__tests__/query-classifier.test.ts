import { generateText } from 'ai'
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'

import { classifyQuery } from '../query-classifier'

// The classifier reads its result from a TOOL CALL, not Output.object.
// Ollama's `format: <json schema>` constrains decoding only for LOCAL models
// and is silently ignored by cloud ones — glm-5.2:cloud returns prose plus a
// `thinking` field — so a schema-based classifier would fail closed on every
// turn the moment CLASSIFIER_MODEL_ID pointed at a :cloud model.

// Captured durable-telemetry lines, so the soft-budget tests can assert the
// recorded outcome ('budget' vs 'ok'). Hoisted so the vi.mock factory below
// (which is itself hoisted) may reference it.
const { capturedClassifierLines } = vi.hoisted(() => ({
  capturedClassifierLines: [] as string[]
}))

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    generateText: vi.fn()
  }
})

vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => vi.fn(modelId => ({ modelId })))
}))

vi.mock('../../utils/fetch-with-timeout', () => ({
  createTimeoutFetch: vi.fn(() => vi.fn())
}))

vi.mock('../../telemetry/latency-store', () => ({
  durableLatencySink: (line: string) => {
    capturedClassifierLines.push(line)
  }
}))

const mockGenerateText = vi.mocked(generateText)

function userMsg(text: string) {
  return {
    id: '1',
    role: 'user' as const,
    parts: [{ type: 'text' as const, text }]
  }
}

function assistantMsg(text: string) {
  return {
    id: '2',
    role: 'assistant' as const,
    parts: [{ type: 'text' as const, text }]
  }
}

describe('classifyQuery', () => {
  const originalOllamaUrl = process.env.OLLAMA_BASE_URL
  const originalClassifierOllamaUrl = process.env.CLASSIFIER_OLLAMA_BASE_URL

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
  })

  afterAll(() => {
    process.env.OLLAMA_BASE_URL = originalOllamaUrl
    process.env.CLASSIFIER_OLLAMA_BASE_URL = originalClassifierOllamaUrl
  })

  it('returns the model classification on success', async () => {
    mockGenerateText.mockResolvedValue({
      toolCalls: [
        {
          toolName: 'classify',
          input: {
            skipSearch: true,
            standaloneQuery: 'confirm the plan',
            needsRecent: false
          }
        }
      ]
    } as any)

    const result = await classifyQuery({
      messages: [
        userMsg('sonarr regex to exclude CAM releases'),
        assistantMsg('Option 1: X. Option 2: Y. Best practice: do both.'),
        userMsg('so you are saying to do both, right?')
      ]
    })

    expect(result).toEqual({
      skipSearch: true,
      standaloneQuery: 'confirm the plan',
      needsRecent: false
    })
  })

  it('falls back to always-search using the raw latest message when the model call throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('model unavailable'))

    const result = await classifyQuery({
      messages: [userMsg('what is the tallest mountain in South Korea')]
    })

    expect(result).toEqual({
      skipSearch: false,
      standaloneQuery: 'what is the tallest mountain in South Korea',
      needsRecent: false,
      // TRUE on every failure path, opposite to the prompt's default of
      // false. A classifier that could not answer must never be the reason a
      // turn stops searching: an ungrounded answer about a version or price
      // is wrong, where a needlessly sourced one is merely worse written.
      needsSources: true,
      intent: 'general',
      // No fused expansions from a failed call — the caller falls back to
      // the standalone expander rather than narrowing the search.
      expandedQueries: []
    })
  })

  it('falls back when the model returns an empty standaloneQuery', async () => {
    mockGenerateText.mockResolvedValue({
      toolCalls: [
        {
          toolName: 'classify',
          input: {
            skipSearch: true,
            standaloneQuery: '   ',
            needsRecent: false
          }
        }
      ]
    } as any)

    const result = await classifyQuery({
      messages: [userMsg('hello there')]
    })

    expect(result).toEqual({
      skipSearch: false,
      standaloneQuery: 'hello there',
      needsRecent: false,
      // TRUE on every failure path, opposite to the prompt's default of
      // false. A classifier that could not answer must never be the reason a
      // turn stops searching: an ungrounded answer about a version or price
      // is wrong, where a needlessly sourced one is merely worse written.
      needsSources: true,
      intent: 'general',
      // No fused expansions from a failed call — the caller falls back to
      // the standalone expander rather than narrowing the search.
      expandedQueries: []
    })
  })

  it('falls back immediately without calling the model when OLLAMA_BASE_URL is not configured', async () => {
    delete process.env.OLLAMA_BASE_URL

    const result = await classifyQuery({
      messages: [userMsg('what time is it')]
    })

    expect(mockGenerateText).not.toHaveBeenCalled()
    expect(result).toEqual({
      skipSearch: false,
      standaloneQuery: 'what time is it',
      needsRecent: false,
      // TRUE on every failure path, opposite to the prompt's default of
      // false. A classifier that could not answer must never be the reason a
      // turn stops searching: an ungrounded answer about a version or price
      // is wrong, where a needlessly sourced one is merely worse written.
      needsSources: true,
      intent: 'general',
      // No fused expansions from a failed call — the caller falls back to
      // the standalone expander rather than narrowing the search.
      expandedQueries: []
    })
  })

  it('prefers CLASSIFIER_OLLAMA_BASE_URL over OLLAMA_BASE_URL when both are set', async () => {
    process.env.CLASSIFIER_OLLAMA_BASE_URL = 'http://serenity:11434'
    mockGenerateText.mockResolvedValue({
      toolCalls: [
        {
          toolName: 'classify',
          input: {
            skipSearch: false,
            standaloneQuery: 'what time is it',
            needsRecent: true
          }
        }
      ]
    } as any)

    await classifyQuery({ messages: [userMsg('what time is it')] })

    const { createOllama } = await import('ai-sdk-ollama')
    expect(createOllama).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://serenity:11434' })
    )
  })

  it('clips long prior-turn text but never the latest message', async () => {
    // Prior assistant turns here are full research reports; six of them
    // uncapped overflow the classifier model's context and make it resolve
    // the wrong (previous) turn. The prompt must clip history yet keep the
    // latest message — the thing being classified — intact.
    mockGenerateText.mockResolvedValue({
      toolCalls: [
        {
          toolName: 'classify',
          input: {
            skipSearch: false,
            standaloneQuery: 'x',
            needsRecent: false
          }
        }
      ]
    } as any)

    const longReport = 'A'.repeat(6000)
    const latest = 'is claude max 20 actually 20x more? '.repeat(20).trim() // long, must survive

    await classifyQuery({
      messages: [
        userMsg('first question'),
        assistantMsg(longReport),
        userMsg(latest)
      ]
    })

    const call = mockGenerateText.mock.calls[0][0] as { prompt: string }
    // Full 6000-char report must NOT appear verbatim in the prompt.
    expect(call.prompt).not.toContain(longReport)
    expect(call.prompt).toContain('…[truncated]')
    // The latest message must be present in full, untruncated.
    expect(call.prompt).toContain(latest)
  })

  it('returns the model-provided intent on success', async () => {
    mockGenerateText.mockResolvedValue({
      toolCalls: [
        {
          toolName: 'classify',
          input: {
            skipSearch: false,
            standaloneQuery: 'latest node.js LTS version',
            needsRecent: true,
            intent: 'code'
          }
        }
      ]
    } as any)

    const result = await classifyQuery({
      messages: [userMsg('whats the newest node lts')]
    })

    expect(result.intent).toBe('code')
  })

  it('falls back to intent="general" when the classifier errors', async () => {
    mockGenerateText.mockRejectedValue(new Error('boom'))

    const result = await classifyQuery({
      messages: [userMsg('anything')]
    })

    expect(result.intent).toBe('general')
    expect(result.skipSearch).toBe(false)
  })
})

// Soft budget (CLASSIFIER_BUDGET_MS, default 4000): the fused classify+expand
// call is raced against a timer that, on expiry, aborts the in-flight request
// and resolves the turn on the graceful always-search fallback. This is the
// tail cap prod telemetry showed never engaging; these tests pin the behavior
// in isolation so a regression that silently disables the cap is caught here
// rather than only in a latency histogram weeks later.
describe('classifyQuery soft budget', () => {
  const originalOllamaUrl = process.env.OLLAMA_BASE_URL
  const originalClassifierOllamaUrl = process.env.CLASSIFIER_OLLAMA_BASE_URL

  beforeEach(() => {
    vi.clearAllMocks()
    capturedClassifierLines.length = 0
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
    // Fake `performance` too, so modelMs/total_ms advance with the fake clock
    // and the recorded timings reflect ~budget rather than ~0.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(() => {
    process.env.OLLAMA_BASE_URL = originalOllamaUrl
    process.env.CLASSIFIER_OLLAMA_BASE_URL = originalClassifierOllamaUrl
  })

  function parseClassifyLine(): Record<string, unknown> | undefined {
    const line = capturedClassifierLines.find(l =>
      l.startsWith('[latency:classify]')
    )
    if (!line) return undefined
    return JSON.parse(line.replace('[latency:classify] ', '')) as Record<
      string,
      unknown
    >
  }

  it('caps the wait at CLASSIFIER_BUDGET_MS (4000) when the model is slow (9000ms), returning the graceful always-search fallback and outcome=budget', async () => {
    // The model would answer with a perfectly good classification — but not
    // until 9000ms, well past the 4000ms soft budget. The cap must win first.
    mockGenerateText.mockImplementation((() =>
      new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              toolCalls: [
                {
                  toolName: 'classify',
                  input: {
                    skipSearch: true,
                    standaloneQuery: 'the slow model answer',
                    needsRecent: false,
                    needsSources: false,
                    intent: 'general',
                    expandedQueries: ['a', 'b']
                  }
                }
              ],
              usage: { inputTokens: 100, outputTokens: 20 }
            }),
          9000
        )
      )) as any)

    let settled = false
    const promise = classifyQuery({
      messages: [userMsg('hello world')]
    }).then(r => {
      settled = true
      return r
    })

    // Just before the budget: still waiting on the model.
    await vi.advanceTimersByTimeAsync(3999)
    expect(settled).toBe(false)

    // Cross the budget: the cap must resolve the turn NOW, not at 9000ms.
    await vi.advanceTimersByTimeAsync(2)
    expect(settled).toBe(true)

    const result = await promise

    // Graceful fallback classification (always-search on the raw message).
    expect(result.skipSearch).toBe(false)
    expect(result.standaloneQuery).toBe('hello world')
    expect(result.expandedQueries).toEqual([])

    const line = parseClassifyLine()
    expect(line?.outcome).toBe('budget')
    // Recorded time reflects the cap (~4000), not the model's 9000.
    expect(line?.total_ms as number).toBeGreaterThanOrEqual(3999)
    expect(line?.total_ms as number).toBeLessThan(6000)
    expect(line?.model_ms as number).toBeLessThan(6000)
  })

  it('uses the model classification (outcome=ok) when it answers within budget', async () => {
    mockGenerateText.mockImplementation((() =>
      new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              toolCalls: [
                {
                  toolName: 'classify',
                  input: {
                    skipSearch: false,
                    standaloneQuery: 'What is the capital of Germany?',
                    needsRecent: false,
                    needsSources: false,
                    intent: 'general',
                    expandedQueries: ['capital city Germany']
                  }
                }
              ],
              usage: { inputTokens: 100, outputTokens: 20 }
            }),
          1500
        )
      )) as any)

    const promise = classifyQuery({ messages: [userMsg('and Germany?')] })
    await vi.advanceTimersByTimeAsync(1600)
    const result = await promise

    expect(result.standaloneQuery).toBe('What is the capital of Germany?')
    expect(result.skipSearch).toBe(false)
    expect(parseClassifyLine()?.outcome).toBe('ok')
  })
})
