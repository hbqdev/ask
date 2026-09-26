import { MockLanguageModelV3 } from 'ai/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { detectUserSuppliedSource } from '../always-search'
import { createResearcher, type TurnPlan } from '../researcher'

// createResearcher end to end with only the edges stubbed: the answering
// model (getModel), the search backend (createSearchTool) and the memory DB.
// Everything in between is real — the dedup/source wrappers, the answer
// deadline wrapper, prepareStep and the ToolLoopAgent — so these tests
// observe what a real turn does at step 0.

const { searchCalls, answeringModels } = vi.hoisted(() => ({
  searchCalls: [] as { query: string; search_depth?: string }[],
  answeringModels: [] as MockLanguageModelV3[]
}))

vi.mock('@/lib/memory/inject', () => ({
  getMemoryInjection: vi.fn(async () => '')
}))

vi.mock('../../utils/registry', () => ({
  getModel: vi.fn(() => {
    // A model that never volunteers a tool call: the failure mode under test.
    const m = new MockLanguageModelV3({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] })
            controller.enqueue({ type: 'text-start', id: 't' })
            controller.enqueue({
              type: 'text-delta',
              id: 't',
              delta: 'Answer.'
            })
            controller.enqueue({ type: 'text-end', id: 't' })
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined }
              }
            })
            controller.close()
          }
        })
      })
    })
    answeringModels.push(m)
    return m
  })
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
          searchCalls.push({
            query: params.query,
            search_depth: params.search_depth
          })
          yield {
            state: 'complete' as const,
            query: params.query,
            images: [],
            number_of_results: 1,
            results: [
              {
                title: 'Source',
                url: `https://example.com/${searchCalls.length}`,
                content: 'FORCED-RESULT'
              }
            ]
          }
        }
      })
    )
  }
})

async function runTurn(
  opts: Parameters<typeof createResearcher>[0]
): Promise<{ plan?: TurnPlan; stepToolNames: string[][] }> {
  let plan: TurnPlan | undefined
  const agent = await createResearcher({
    ...opts,
    onTurnPlan: p => {
      plan = p
    }
  })
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'the user message' }]
  })
  await result.consumeStream()
  const steps = await result.steps
  return {
    plan,
    stepToolNames: steps.map(s =>
      s.toolCalls.map(c => (c as { toolName: string }).toolName)
    )
  }
}

describe('createResearcher — ALWAYS_SEARCH on', () => {
  beforeEach(() => {
    searchCalls.length = 0
    answeringModels.length = 0
  })

  it('stable-knowledge question (needsSources=false) is a research turn whose step 0 searches the standalone query', async () => {
    const { plan, stepToolNames } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      searchMode: 'balanced',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: false,
      needsRecent: false,
      standaloneQuery: 'What is the difference between TCP and UDP?'
    })
    expect(plan).toEqual({ turnMode: 'research', forcedSearch: true })
    expect(searchCalls).toEqual([
      {
        query: 'What is the difference between TCP and UDP?',
        search_depth: 'advanced'
      }
    ])
    expect(stepToolNames[0]).toEqual(['search'])
    // The answering model ran once, at step 1, with the result in context,
    // and was told the search already happened.
    expect(answeringModels[0].doStreamCalls).toHaveLength(1)
    const call = answeringModels[0].doStreamCalls[0]
    expect(JSON.stringify(call.prompt)).toContain('FORCED-RESULT')
    expect(JSON.stringify(call.prompt)).toContain(
      'A first web search has already been run for this turn'
    )
  })

  it('a follow-up searches the RESOLVED query, not the raw message', async () => {
    await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: 'Should a multiplayer game server use TCP or UDP?'
    })
    expect(searchCalls.map(c => c.query)).toEqual([
      'Should a multiplayer game server use TCP or UDP?'
    ])
  })

  it('speed mode (classifier bypassed: raw message, needsSources=true) is forced with basic depth', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      searchMode: 'speed',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: 'how do I get melted plastic off an oven tray'
    })
    expect(plan).toEqual({ turnMode: 'research', forcedSearch: true })
    expect(searchCalls).toEqual([
      {
        query: 'how do I get melted plastic off an oven tray',
        search_depth: 'basic'
      }
    ])
  })

  it('classifier failure fallback (skipSearch=false, needsSources=true, raw text) is forced', async () => {
    const { plan, stepToolNames } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      needsRecent: false,
      standaloneQuery: 'raw latest message text'
    })
    expect(plan?.forcedSearch).toBe(true)
    expect(stepToolNames[0]).toEqual(['search'])
  })

  it('a non-question (skipSearch=true) stays direct and does NOT search', async () => {
    const { plan, stepToolNames } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: true,
      needsSources: false,
      standaloneQuery: 'Thanks, no search needed'
    })
    expect(plan).toEqual({ turnMode: 'direct', forcedSearch: false })
    expect(searchCalls).toHaveLength(0)
    expect(stepToolNames).toEqual([[]])
  })

  it('a URL-only message is not forced (fetch reads it); nothing searchable remains', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: 'https://example.com/article'
    })
    expect(plan).toEqual({ turnMode: 'research', forcedSearch: false })
    expect(searchCalls).toHaveLength(0)
  })
})

// The user supplied the turn's subject (a URL, or an attachment the text only
// points at): the turn stays research with search available, but step 0 is
// not forced. The caller derives userSuppliedSource from the latest message's
// UI parts, exactly as create-chat-stream-response.ts does.
describe('createResearcher — ALWAYS_SEARCH on, user-supplied source', () => {
  beforeEach(() => {
    searchCalls.length = 0
    answeringModels.length = 0
  })

  const text = (t: string) => ({ type: 'text', text: t })
  const photo = {
    type: 'file',
    url: 'https://ask.example/uploads/photo.jpg',
    mediaType: 'image/jpeg',
    filename: 'photo.jpg'
  }
  const systemOf = (m: MockLanguageModelV3) =>
    JSON.stringify(m.doStreamCalls[0].prompt[0])
      // The date is appended per call; everything else must be identical.
      .replace(/Current date and time: [^"\\]*/g, 'Current date and time: X')
  const toolNamesOf = (m: MockLanguageModelV3) =>
    (m.doStreamCalls[0].tools ?? []).map(t => t.name).sort()

  it('"summarise this <url>" (classifier bypassed: raw text) is research, NOT forced, search still advertised', async () => {
    const raw =
      'summarise this https://en.wikipedia.org/wiki/User_Datagram_Protocol'
    const { plan, stepToolNames } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: raw,
      userSuppliedSource: detectUserSuppliedSource([text(raw)])
    })
    expect(plan).toEqual({
      turnMode: 'research',
      forcedSearch: false,
      forcedSkip: 'url'
    })
    // No "summarise this" search: the model answers (it would fetch the URL).
    expect(searchCalls).toHaveLength(0)
    expect(stepToolNames[0]).toEqual([])
    const model = answeringModels[0]
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain(
      'A first web search has already been run'
    )
    expect(toolNamesOf(model)).toEqual(
      expect.arrayContaining(['search', 'fetch'])
    )
  })

  it('a URL turn gets exactly the pre-ALWAYS_SEARCH research turn (same prompt, same tools)', async () => {
    const raw = 'summarise this https://example.com/post'
    await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: false,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: raw
    })
    await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: raw,
      userSuppliedSource: 'url'
    })
    const [before, after] = answeringModels
    expect(after.doStreamCalls[0].prompt[0].role).toBe('system')
    expect(systemOf(after)).toContain('Current date and time: X')
    expect(systemOf(after)).toBe(systemOf(before))
    expect(toolNamesOf(after)).toEqual(toolNamesOf(before))
    expect(searchCalls).toHaveLength(0)
  })

  it('a pasted link chip with classified text is not forced either', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      // What the classifier resolves "summarise this" to — it never sees the chip.
      standaloneQuery: 'Summarise this article',
      userSuppliedSource: detectUserSuppliedSource([
        { type: 'data-sourceUrl', data: { url: 'https://example.com/post' } },
        text('summarise this')
      ])
    })
    expect(plan).toEqual({
      turnMode: 'research',
      forcedSearch: false,
      forcedSkip: 'url'
    })
    expect(searchCalls).toHaveLength(0)
  })

  it('an attachment-only message (the classifier invented a query) is not forced', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: 'Describe the attached image',
      userSuppliedSource: detectUserSuppliedSource([photo])
    })
    expect(plan).toEqual({
      turnMode: 'research',
      forcedSearch: false,
      forcedSkip: 'attachment-only'
    })
    expect(searchCalls).toHaveLength(0)
  })

  it('attachment + deictic text ("what is this") is not forced', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: 'What is this?',
      userSuppliedSource: detectUserSuppliedSource([
        photo,
        text('what is this')
      ])
    })
    expect(plan).toEqual({
      turnMode: 'research',
      forcedSearch: false,
      forcedSkip: 'attachment-reference'
    })
    expect(searchCalls).toHaveLength(0)
    expect(toolNamesOf(answeringModels[0])).toContain('search')
  })

  it('attachment + a real question is still forced — every question searches', async () => {
    const q = 'is this mushroom safe to eat?'
    const { plan, stepToolNames } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: 'Is this mushroom safe to eat?',
      userSuppliedSource: detectUserSuppliedSource([photo, text(q)])
    })
    expect(plan).toEqual({ turnMode: 'research', forcedSearch: true })
    expect(searchCalls.map(c => c.query)).toEqual([
      'Is this mushroom safe to eat?'
    ])
    expect(stepToolNames[0]).toEqual(['search'])
  })

  it('a skipSearch turn with an attachment stays direct; no forcedSkip is reported', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: true,
      skipSearch: true,
      standaloneQuery: 'Summarise the pasted text',
      userSuppliedSource: 'attachment-reference'
    })
    expect(plan).toEqual({ turnMode: 'direct', forcedSearch: false })
    expect(plan).not.toHaveProperty('forcedSkip')
  })
})

describe('createResearcher — ALWAYS_SEARCH off (legacy D3 behaviour)', () => {
  beforeEach(() => {
    searchCalls.length = 0
    answeringModels.length = 0
  })

  it('needsSources=false && needsRecent=false is stable-knowledge again, not forced', async () => {
    const { plan, stepToolNames } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: false,
      skipSearch: false,
      needsSources: false,
      needsRecent: false,
      standaloneQuery: 'What is the difference between TCP and UDP?'
    })
    expect(plan).toEqual({ turnMode: 'stable-knowledge', forcedSearch: false })
    expect(searchCalls).toHaveLength(0)
    expect(stepToolNames).toEqual([[]])
    expect(
      JSON.stringify(answeringModels[0].doStreamCalls[0].prompt)
    ).not.toContain('A first web search has already been run')
  })

  it('a research turn is NOT forced — the model decides, exactly as before', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: false,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: 'current Node.js version'
    })
    expect(plan).toEqual({ turnMode: 'research', forcedSearch: false })
    expect(searchCalls).toHaveLength(0)
  })

  it('skipSearch=true is direct', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: false,
      skipSearch: true,
      standaloneQuery: 'hello'
    })
    expect(plan).toEqual({ turnMode: 'direct', forcedSearch: false })
  })

  it('a URL turn is unaffected by userSuppliedSource (nothing is forced when off)', async () => {
    const { plan } = await runTurn({
      model: 'ollama:kimi-k2.6:cloud',
      alwaysSearch: false,
      skipSearch: false,
      needsSources: true,
      standaloneQuery: 'summarise this https://example.com/post',
      userSuppliedSource: 'url'
    })
    expect(plan).toEqual({ turnMode: 'research', forcedSearch: false })
    expect(plan).not.toHaveProperty('forcedSkip')
  })
})

describe('createResearcher — env flag default', () => {
  beforeEach(() => {
    searchCalls.length = 0
    answeringModels.length = 0
  })

  it('reads ALWAYS_SEARCH from the environment when not passed (unset = on, "off" = off)', async () => {
    const original = process.env.ALWAYS_SEARCH
    try {
      delete process.env.ALWAYS_SEARCH
      const on = await runTurn({
        model: 'ollama:kimi-k2.6:cloud',
        needsSources: false,
        standaloneQuery: 'explain closures'
      })
      expect(on.plan).toEqual({ turnMode: 'research', forcedSearch: true })

      process.env.ALWAYS_SEARCH = 'off'
      const off = await runTurn({
        model: 'ollama:kimi-k2.6:cloud',
        needsSources: false,
        standaloneQuery: 'explain closures'
      })
      expect(off.plan).toEqual({
        turnMode: 'stable-knowledge',
        forcedSearch: false
      })
    } finally {
      if (original === undefined) delete process.env.ALWAYS_SEARCH
      else process.env.ALWAYS_SEARCH = original
    }
  })
})
