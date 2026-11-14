import { MockLanguageModelV3 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createResearcher } from '../researcher'

const NO_FOLLOWUP_LINE =
  'Do NOT end your answer with follow-up suggestions or questions to the user (e.g. "Want me to…?"); suggested follow-ups are shown separately.'

// Follow-up questions come from a separate endpoint now, so no answering
// system prompt may ask the model to append its own "Related" spec block.
// The direct-answer and stable-knowledge prompts are private to the
// researcher, so this drives the real createResearcher with a stub model that
// answers at once and records the system prompt it was given.

const state = vi.hoisted(() => ({
  systems: [] as string[]
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
          for (const m of prompt as Array<{ role: string; content: unknown }>)
            if (m.role === 'system') state.systems.push(String(m.content))
          return {
            stream: new ReadableStream({
              start(c) {
                c.enqueue({ type: 'stream-start', warnings: [] })
                c.enqueue({ type: 'text-start', id: 't' })
                c.enqueue({ type: 'text-delta', id: 't', delta: 'Answer.' })
                c.enqueue({ type: 'text-end', id: 't' })
                c.enqueue({
                  type: 'finish',
                  finishReason: { unified: 'stop', raw: 'stop' },
                  usage: USAGE
                })
                c.close()
              }
            })
          }
        }
      })
  )
}))

async function systemPromptFor(flags: {
  skipSearch: boolean
  needsSources: boolean
  searchMode?: 'speed' | 'balanced' | 'quality'
}) {
  state.systems.length = 0
  const agent = await createResearcher({
    model: 'ollama:kimi-k2.6:cloud',
    searchMode: flags.searchMode ?? 'balanced',
    alwaysSearch: false,
    skipSearch: flags.skipSearch,
    needsSources: flags.needsSources,
    currentChatId: 'chat-no-related-test'
  })
  const result = await agent.stream({
    messages: [{ role: 'user', content: 'the user question' }]
  })
  await result.consumeStream()
  expect(state.systems.length).toBeGreaterThan(0)
  return state.systems.join('\n')
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('createResearcher — no in-answer Related block', () => {
  it.each([
    ['direct', { skipSearch: true, needsSources: true }],
    ['stable-knowledge', { skipSearch: false, needsSources: false }],
    [
      'research (speed)',
      { skipSearch: false, needsSources: true, searchMode: 'speed' as const }
    ],
    ['research (balanced)', { skipSearch: false, needsSources: true }],
    [
      'research (quality)',
      { skipSearch: false, needsSources: true, searchMode: 'quality' as const }
    ]
  ])(
    '%s system prompt has no related-questions instruction',
    async (_n, flags) => {
      const system = await systemPromptFor(flags)

      expect(system).not.toContain('RELATED QUESTIONS')
      expect(system).not.toContain('submitQuery')
    }
  )

  // The model's own "Want me to…?" closers would sit right above the
  // suggested follow-ups the UI shows, so every answering prompt forbids them,
  // exactly once (later duplicates only waste tokens).
  it.each([
    ['direct', { skipSearch: true, needsSources: true }],
    ['stable-knowledge', { skipSearch: false, needsSources: false }],
    [
      'research (speed)',
      { skipSearch: false, needsSources: true, searchMode: 'speed' as const }
    ],
    ['research (balanced)', { skipSearch: false, needsSources: true }],
    [
      'research (quality)',
      { skipSearch: false, needsSources: true, searchMode: 'quality' as const }
    ]
  ])(
    '%s system prompt forbids trailing follow-up suggestions, once',
    async (_n, flags) => {
      const system = await systemPromptFor(flags)

      expect(system.split(NO_FOLLOWUP_LINE).length - 1).toBe(1)
    }
  )
})
