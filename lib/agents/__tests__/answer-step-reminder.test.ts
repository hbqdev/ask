import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart
} from '@ai-sdk/provider'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it, vi } from 'vitest'

import {
  ANSWER_TEXT_CHARS,
  createAnswerStepReminderModel,
  looksLikeAnswerStart
} from '../answer-step-reminder'

const USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined }
}

const REMINDER = 'REMINDER-TEXT'

type Script = LanguageModelV3StreamPart[]

function textParts(...deltas: string[]): Script {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...deltas.map(delta => ({ type: 'text-delta' as const, id: 't', delta })),
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: USAGE
    }
  ]
}

function toolParts(narration?: string): Script {
  return [
    { type: 'stream-start', warnings: [] },
    ...(narration
      ? ([
          { type: 'text-start', id: 'n' },
          { type: 'text-delta', id: 'n', delta: narration },
          { type: 'text-end', id: 'n' }
        ] as Script)
      : []),
    {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'search',
      input: '{"query":"q"}'
    },
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: USAGE
    }
  ]
}

/**
 * A model factory that plays one script per attempt, and records each
 * attempt's call options and whether its signal was aborted.
 */
function harness(scripts: Script[]) {
  const calls: {
    options: LanguageModelV3CallOptions
    signal: AbortSignal
    cancelled: boolean
  }[] = []
  const makeModel = (signal: AbortSignal): LanguageModelV3 =>
    new MockLanguageModelV3({
      doStream: async options => {
        const script = scripts[calls.length]
        const call = { options, signal, cancelled: false }
        calls.push(call)
        let i = 0
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            pull(c) {
              if (i < script.length) c.enqueue(script[i++])
              else c.close()
            },
            cancel() {
              call.cancelled = true
            }
          })
        }
      }
    })
  const onRetry = vi.fn()
  const model = createAnswerStepReminderModel({
    base: makeModel(new AbortController().signal),
    makeModel,
    reminder: REMINDER,
    onRetry
  })
  return { model, calls, onRetry }
}

const PROMPT: LanguageModelV3CallOptions['prompt'] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'text', text: 'question' }] }
]

async function readAll(model: LanguageModelV3) {
  const { stream } = await model.doStream({ prompt: PROMPT })
  const parts: LanguageModelV3StreamPart[] = []
  const reader = stream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

const textOf = (parts: LanguageModelV3StreamPart[]) =>
  parts
    .filter(p => p.type === 'text-delta')
    .map(p => (p as { delta: string }).delta)
    .join('')

describe('looksLikeAnswerStart', () => {
  it('recognises a markdown heading at a line start', () => {
    expect(looksLikeAnswerStart('## Answer')).toBe(true)
    expect(looksLikeAnswerStart('  ### Sub')).toBe(true)
    expect(looksLikeAnswerStart('I have enough.\n\n## Answer')).toBe(true)
  })

  it('does not treat a short narration or a partial heading as the answer', () => {
    expect(looksLikeAnswerStart('Let me search for that.')).toBe(false)
    expect(looksLikeAnswerStart('#')).toBe(false)
    expect(looksLikeAnswerStart('see #42 in the tracker')).toBe(false)
  })

  it('treats a long run of text as the answer', () => {
    expect(looksLikeAnswerStart('x'.repeat(ANSWER_TEXT_CHARS))).toBe(true)
    expect(looksLikeAnswerStart('x'.repeat(ANSWER_TEXT_CHARS - 1))).toBe(false)
  })
})

describe('createAnswerStepReminderModel', () => {
  it('a research step (tool call) passes through untouched, with no re-run', async () => {
    const { model, calls, onRetry } = harness([toolParts()])
    const parts = await readAll(model)
    expect(calls).toHaveLength(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(parts.map(p => p.type)).toEqual([
      'stream-start',
      'tool-call',
      'finish'
    ])
    expect(JSON.stringify(calls[0].options.prompt)).not.toContain(REMINDER)
  })

  it('narration before a tool call is passed through, not mistaken for the answer', async () => {
    const { model, calls } = harness([
      toolParts('Let me check one more source.')
    ])
    const parts = await readAll(model)
    expect(calls).toHaveLength(1)
    expect(textOf(parts)).toBe('Let me check one more source.')
    expect(parts.some(p => p.type === 'tool-call')).toBe(true)
  })

  it('an answer step is aborted and re-run once with the reminder as a trailing user message', async () => {
    const { model, calls, onRetry } = harness([
      textParts('## Draft ', 'answer without citations'),
      textParts('## Final answer. ', '[1](#id)')
    ])
    const parts = await readAll(model)

    expect(calls).toHaveLength(2)
    // First attempt: cut off at the HTTP layer and its stream cancelled.
    expect(calls[0].signal.aborted).toBe(true)
    expect(calls[0].options.abortSignal?.aborted).toBe(true)
    expect(calls[0].cancelled).toBe(true)
    // Second attempt: same prompt plus the reminder, last, as a user message.
    const retryPrompt = calls[1].options.prompt
    expect(retryPrompt.slice(0, PROMPT.length)).toEqual(PROMPT)
    expect(retryPrompt[retryPrompt.length - 1]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: REMINDER }]
    })
    expect(calls[1].signal.aborted).toBe(false)
    // Only the re-run reaches the caller.
    expect(textOf(parts)).toBe('## Final answer. [1](#id)')
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0][0].abortedTextChars).toBeGreaterThan(0)
  })

  it('re-runs at most once, even if the re-run also answers', async () => {
    const { model, calls } = harness([
      textParts('## A'),
      textParts('## B'),
      textParts('## C')
    ])
    const parts = await readAll(model)
    expect(calls).toHaveLength(2)
    expect(textOf(parts)).toBe('## B')
  })

  it('a short answer with no heading that finishes early passes through', async () => {
    const { model, calls, onRetry } = harness([textParts('Yes.')])
    const parts = await readAll(model)
    expect(calls).toHaveLength(1)
    expect(onRetry).not.toHaveBeenCalled()
    expect(textOf(parts)).toBe('Yes.')
  })

  it('keeps the base model identity and forwards doGenerate unguarded', async () => {
    const base = new MockLanguageModelV3({
      provider: 'ollama',
      modelId: 'kimi-k2.6:cloud',
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'generated' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: USAGE,
        warnings: []
      })
    })
    const model = createAnswerStepReminderModel({
      base,
      makeModel: () => base,
      reminder: REMINDER
    })
    expect(model.provider).toBe('ollama')
    expect(model.modelId).toBe('kimi-k2.6:cloud')
    const out = await model.doGenerate({ prompt: PROMPT })
    expect(out.content).toEqual([{ type: 'text', text: 'generated' }])
  })
})
