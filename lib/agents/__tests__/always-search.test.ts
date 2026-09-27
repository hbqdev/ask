import { stepCountIs, streamText, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { searchSchema, strictSearchSchema } from '@/lib/schema/search'

import {
  buildForcedSearchInput,
  createForcedSearchModel,
  detectUserSuppliedSource,
  FORCED_SEARCH_PROMPT_ADDENDUM,
  FORCED_SEARCH_PROVIDER,
  FORCED_SEARCH_QUERY_MAX_CHARS,
  isAlwaysSearchEnabled,
  isAttachmentReferenceOnly,
  resolveForcedSearchQuery
} from '../always-search'

const ZERO_USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
}

/**
 * A stand-in for the answering model that NEVER calls a tool — the failure
 * this feature exists to remove: a model deciding to answer from memory. It
 * ignores toolChoice exactly as ai-sdk-ollama does.
 */
function makeAnswerOnlyModel(answer = 'Answer from the model.') {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 't1' })
          controller.enqueue({ type: 'text-delta', id: 't1', delta: answer })
          controller.enqueue({ type: 'text-end', id: 't1' })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: ZERO_USAGE
          })
          controller.close()
        }
      })
    })
  })
}

function makeSearchTool() {
  const calls: { query: string }[] = []
  const searchTool = tool({
    description: 'search',
    inputSchema: searchSchema,
    execute: async ({ query }) => {
      calls.push({ query })
      return {
        state: 'complete' as const,
        query,
        results: [
          {
            title: 'Result',
            url: 'https://example.com/r',
            content: 'SEARCH-RESULT-CONTENT'
          }
        ]
      }
    }
  })
  return { searchTool, calls }
}

async function readStream(stream: ReadableStream<unknown>) {
  const parts: any[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

describe('FORCED_SEARCH_PROMPT_ADDENDUM', () => {
  // Prod 2026-09-27: the old wording ("search again only if those results leave
  // a specific gap you can name") cut research turns from a median of 3
  // searches/fetches to 1 — models stopped after the forced search, and it
  // overrode quality mode's own multi-search protocol.
  it('frames the forced search as the first search, not the only one', () => {
    expect(FORCED_SEARCH_PROMPT_ADDENDUM).toContain(
      'FIRST search, not your only one'
    )
    expect(FORCED_SEARCH_PROMPT_ADDENDUM).toContain(
      'search again with different queries'
    )
    expect(FORCED_SEARCH_PROMPT_ADDENDUM).not.toMatch(/only if those results/i)
    expect(FORCED_SEARCH_PROMPT_ADDENDUM).not.toMatch(
      /answer from what you know/i
    )
  })
})

describe('isAlwaysSearchEnabled', () => {
  it('is ON when unset or empty — the default', () => {
    expect(isAlwaysSearchEnabled({})).toBe(true)
    expect(isAlwaysSearchEnabled({ ALWAYS_SEARCH: '' })).toBe(true)
  })

  it('is ON for any value other than the literal "off"', () => {
    for (const v of ['on', 'true', 'false', '0', 'OFF', ' off']) {
      expect(isAlwaysSearchEnabled({ ALWAYS_SEARCH: v })).toBe(true)
    }
  })

  it('is OFF only for the literal "off" (the RECALL_ENABLED convention)', () => {
    expect(isAlwaysSearchEnabled({ ALWAYS_SEARCH: 'off' })).toBe(false)
  })
})

describe('resolveForcedSearchQuery', () => {
  it('passes a standalone query through, whitespace-normalised', () => {
    expect(
      resolveForcedSearchQuery('  Should a game server use   TCP or UDP? ')
    ).toBe('Should a game server use TCP or UDP?')
  })

  it('strips URLs but keeps the question around them', () => {
    expect(
      resolveForcedSearchQuery(
        'what does https://example.com/post say about caching'
      )
    ).toBe('what does say about caching')
  })

  it('returns null when nothing searchable remains (URL-only, empty, attachment-only)', () => {
    expect(resolveForcedSearchQuery('https://example.com/a')).toBeNull()
    expect(resolveForcedSearchQuery('   ')).toBeNull()
    expect(resolveForcedSearchQuery('')).toBeNull()
    expect(resolveForcedSearchQuery(undefined)).toBeNull()
  })

  it('clips a pasted wall of text at a word boundary', () => {
    const long = 'word '.repeat(500)
    const q = resolveForcedSearchQuery(long)!
    expect(q.length).toBeLessThanOrEqual(FORCED_SEARCH_QUERY_MAX_CHARS)
    expect(q.endsWith('word')).toBe(true)
  })
})

// UI parts as the composer sends them (components/chat-panel.tsx).
const text = (t: string) => ({ type: 'text', text: t })
const image = {
  type: 'file',
  url: 'https://ask.example/uploads/photo.jpg',
  mediaType: 'image/jpeg',
  filename: 'photo.jpg'
}
const pdf = {
  type: 'file',
  url: 'https://ask.example/uploads/report.pdf',
  mediaType: 'application/pdf',
  filename: 'report.pdf'
}
const linkChip = (url: string) => ({ type: 'data-sourceUrl', data: { url } })
const pastedCard = { type: 'data-pastedContent', data: { text: 'long text' } }
const quotedPassage = {
  type: 'data-quotedContext',
  data: { text: 'a passage of the previous answer' }
}

describe('detectUserSuppliedSource', () => {
  it('a URL typed or pasted inline in the text → url', () => {
    expect(
      detectUserSuppliedSource([
        text(
          'summarise this https://en.wikipedia.org/wiki/User_Datagram_Protocol'
        )
      ])
    ).toBe('url')
    expect(
      detectUserSuppliedSource([text('is http://example.com/a legit?')])
    ).toBe('url')
  })

  it('a pasted link chip (data-sourceUrl) → url, with or without text', () => {
    expect(
      detectUserSuppliedSource([
        linkChip('https://example.com/post'),
        text('summarise this')
      ])
    ).toBe('url')
    expect(
      detectUserSuppliedSource([linkChip('https://example.com/post')])
    ).toBe('url')
  })

  it('an empty link chip is not a URL', () => {
    expect(detectUserSuppliedSource([linkChip(''), text('hello')])).toBeNull()
  })

  it('a URL wins over an attachment', () => {
    expect(
      detectUserSuppliedSource([
        image,
        text('compare this with https://example.com/spec')
      ])
    ).toBe('url')
  })

  it('an attachment with no typed text → attachment-only (file, pasted card, quoted passage)', () => {
    expect(detectUserSuppliedSource([image])).toBe('attachment-only')
    expect(detectUserSuppliedSource([pdf, text('   ')])).toBe('attachment-only')
    expect(detectUserSuppliedSource([pastedCard])).toBe('attachment-only')
    expect(detectUserSuppliedSource([quotedPassage])).toBe('attachment-only')
  })

  it('an attachment whose text only points at it → attachment-reference', () => {
    expect(detectUserSuppliedSource([image, text('what is this')])).toBe(
      'attachment-reference'
    )
    expect(
      detectUserSuppliedSource([image, text("What's in this picture?")])
    ).toBe('attachment-reference')
    expect(detectUserSuppliedSource([pdf, text('read this')])).toBe(
      'attachment-reference'
    )
    expect(detectUserSuppliedSource([pdf, text('summarise this file')])).toBe(
      'attachment-reference'
    )
    expect(
      detectUserSuppliedSource([quotedPassage, text('explain this')])
    ).toBe('attachment-reference')
  })

  it('an attachment with a real question → null (the forced search applies)', () => {
    expect(
      detectUserSuppliedSource([image, text('is this mushroom safe to eat?')])
    ).toBeNull()
    expect(
      detectUserSuppliedSource([
        pdf,
        text('what is the current EU VAT rate for e-books?')
      ])
    ).toBeNull()
  })

  it('no attachment and no URL → null, whatever the text says', () => {
    // "what is this" with no attachment refers to the conversation, which the
    // classifier resolves into its standaloneQuery.
    expect(detectUserSuppliedSource([text('what is this')])).toBeNull()
    expect(
      detectUserSuppliedSource([text('what is the capital of Germany')])
    ).toBeNull()
  })

  it('tolerates missing or malformed parts', () => {
    expect(detectUserSuppliedSource(undefined)).toBeNull()
    expect(detectUserSuppliedSource(null)).toBeNull()
    expect(detectUserSuppliedSource([])).toBeNull()
    expect(
      detectUserSuppliedSource([{ type: 'text', text: 42 }, { type: 'step' }])
    ).toBeNull()
  })
})

describe('isAttachmentReferenceOnly', () => {
  it.each([
    'what is this',
    'What is this?',
    "what's in this picture?",
    'What’s this',
    'who is this',
    'read this',
    'summarise this file',
    'Summarize this PDF please',
    'can you describe this image',
    'what does it say',
    'what does this mean?',
    'explain',
    'transcribe the text in this screenshot',
    'tell me about this document',
    "what's going on here",
    'look at this',
    '?',
    ''
  ])('%j only points at the attachment', t => {
    expect(isAttachmentReferenceOnly(t)).toBe(true)
  })

  it.each([
    // a subject word makes it a question in its own right
    'what is this plant',
    'is this mushroom safe to eat?',
    'how much does this cost',
    'who painted this',
    'what year was this photo taken',
    'is this true',
    'translate this into Spanish',
    'what is the capital of France',
    // another language is not recognised, so it keeps its search
    '¿qué es esto?',
    // every word is a reference word, but too long to be a mere pointer
    'can you please just read this file and tell me what is in it'
  ])('%j is a question, not a mere pointer', t => {
    expect(isAttachmentReferenceOnly(t)).toBe(false)
  })
})

describe('buildForcedSearchInput', () => {
  it('validates against both the standard and the strict search schema', () => {
    const input = buildForcedSearchInput('tcp vs udp', 'advanced')
    expect(searchSchema.safeParse(input).success).toBe(true)
    expect(strictSearchSchema.safeParse(input).success).toBe(true)
    expect(input).toMatchObject({
      query: 'tcp vs udp',
      search_depth: 'advanced',
      type: 'optimized',
      search_mode: 'web'
    })
  })
})

describe('createForcedSearchModel', () => {
  it('streams exactly one search tool-call, mirroring ai-sdk-ollama', async () => {
    const model = createForcedSearchModel({
      input: buildForcedSearchInput('q', 'basic'),
      toolCallId: 'fixed-id'
    })
    expect(model.provider).toBe(FORCED_SEARCH_PROVIDER)
    const { stream } = await model.doStream({ prompt: [] } as any)
    const parts = await readStream(stream)
    expect(parts.map(p => p.type)).toEqual([
      'stream-start',
      'tool-call',
      'finish'
    ])
    const call = parts[1]
    expect(call).toMatchObject({ toolCallId: 'fixed-id', toolName: 'search' })
    expect(JSON.parse(call.input).query).toBe('q')
    expect(parts[2].finishReason.unified).toBe('tool-calls')
  })

  it('gives each turn a fresh UUID toolCallId (citable, like a real call)', () => {
    const a = createForcedSearchModel({ input: {} })
    const b = createForcedSearchModel({ input: {} })
    const idOf = async (m: typeof a) =>
      (await readStream((await m.doStream({ prompt: [] } as any)).stream))[1]
        .toolCallId
    return Promise.all([idOf(a), idOf(b)]).then(([x, y]) => {
      expect(x).toMatch(/^[0-9a-f-]{36}$/)
      expect(x).not.toBe(y)
    })
  })

  it('also answers doGenerate with the same single call', async () => {
    const model = createForcedSearchModel({ input: { query: 'q' } })
    const result = await model.doGenerate({ prompt: [] } as any)
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'search'
    })
  })
})

// The mechanism end to end through the real AI SDK loop: a model that would
// never search, and a prepareStep that hands step 0 to the forced model.
describe('forced first step through streamText', () => {
  it('CONTROL: an answering model that does not volunteer a call never searches', async () => {
    const { searchTool, calls } = makeSearchTool()
    const result = streamText({
      model: makeAnswerOnlyModel(),
      tools: { search: searchTool },
      // What a toolChoice-based fix would send. The mock, like ai-sdk-ollama,
      // ignores it — so it cannot guarantee anything.
      toolChoice: { type: 'tool', toolName: 'search' },
      prompt: 'What is the difference between TCP and UDP?',
      stopWhen: stepCountIs(5)
    })
    await result.consumeStream()
    expect(calls).toHaveLength(0)
    expect(await result.text).toBe('Answer from the model.')
  })

  it('step 0 executes the search tool, then the real model answers with the result in context', async () => {
    const { searchTool, calls } = makeSearchTool()
    const realModel = makeAnswerOnlyModel('Grounded answer.')
    const forced = createForcedSearchModel({
      input: buildForcedSearchInput(
        'Should a multiplayer game server use TCP or UDP?',
        'advanced'
      )
    })

    const result = streamText({
      model: realModel,
      tools: { search: searchTool },
      prompt: 'So which one should I use for a multiplayer game server?',
      stopWhen: stepCountIs(5),
      prepareStep: ({ stepNumber }) =>
        stepNumber === 0 ? { model: forced } : {}
    })
    const uiParts = await readStream(result.toUIMessageStream())

    // The search ran exactly once, with the resolved standalone query.
    expect(calls).toEqual([
      { query: 'Should a multiplayer game server use TCP or UDP?' }
    ])

    // The real model was called once — for step 1 — and saw the tool result.
    expect(realModel.doStreamCalls).toHaveLength(1)
    const promptText = JSON.stringify(realModel.doStreamCalls[0].prompt)
    expect(promptText).toContain('SEARCH-RESULT-CONTENT')
    expect(promptText).toContain('tool-result')

    const steps = await result.steps
    expect(steps).toHaveLength(2)
    expect(steps[0].toolCalls.map(c => c.toolName)).toEqual(['search'])
    expect(steps[1].text).toBe('Grounded answer.')

    // The UI sees an ordinary search tool part (what the latency tracker
    // counts as a tool call and what persistence stores).
    const types = uiParts.map(p => p.type)
    expect(types).toContain('tool-input-available')
    expect(types).toContain('tool-output-available')
    const available = uiParts.find(p => p.type === 'tool-input-available')
    expect(available.toolName).toBe('search')
  })

  it('a forced call with input the tool rejects surfaces as a tool error and the loop continues', async () => {
    const strictTool = tool({
      description: 'search',
      inputSchema: z.object({ query: z.string().min(1000) }),
      execute: async () => ({ ok: true })
    })
    const realModel = makeAnswerOnlyModel('Recovered.')
    const result = streamText({
      model: realModel,
      tools: { search: strictTool },
      prompt: 'q',
      stopWhen: stepCountIs(5),
      prepareStep: ({ stepNumber }) =>
        stepNumber === 0
          ? { model: createForcedSearchModel({ input: { query: 'short' } }) }
          : {}
    })
    await result.consumeStream()
    // Never a dead turn: the real model still gets its step.
    expect(realModel.doStreamCalls).toHaveLength(1)
    expect(await result.text).toBe('Recovered.')
  })
})
