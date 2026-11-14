import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ai', () => ({ generateText: vi.fn() }))
// The provider returns a tagged object so a test can assert which model id and
// options generateText was handed.
vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => (id: string, opts: unknown) => ({ id, opts }))
}))

import { generateText } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

import { generateFollowups, parseFollowups } from '../followup-generator'

describe('parseFollowups', () => {
  it('parses a JSON array', () => {
    expect(parseFollowups('["A?","B?","C?"]', [])).toEqual(['A?', 'B?', 'C?'])
  })

  it('parses a fenced or prose-wrapped array', () => {
    expect(parseFollowups('Sure:\n```json\n["A?","B?"]\n```', [])).toEqual([
      'A?',
      'B?'
    ])
  })

  it('caps at 3', () => {
    expect(parseFollowups('["A?","B?","C?","D?","E?"]', [])).toEqual([
      'A?',
      'B?',
      'C?'
    ])
  })

  it('drops empties, non-strings and over-long items', () => {
    expect(
      parseFollowups('["", 7, "' + 'x'.repeat(151) + '", "Ok?"]', [])
    ).toEqual(['Ok?'])
  })

  it('drops echoes of asked questions', () => {
    expect(
      parseFollowups('["What is X?","How does Y work?"]', ['what is x?'])
    ).toEqual(['How does Y work?'])
  })

  it('dedupes case-insensitively', () => {
    expect(parseFollowups('["Why?","why?"]', [])).toEqual(['Why?'])
  })

  it('returns [] for an empty array or no array', () => {
    expect(parseFollowups('[]', [])).toEqual([])
    expect(parseFollowups('no idea', [])).toEqual([])
  })
})

describe('generateFollowups', () => {
  const ENV = { ...process.env }
  const gen = (text: string) =>
    vi.mocked(generateText).mockResolvedValue({ text } as any)
  const call = (over: Partial<Parameters<typeof generateFollowups>[0]> = {}) =>
    generateFollowups({
      question: 'What is X?',
      answer: 'X is a thing.',
      previousQuestions: [],
      ...over
    })
  const modelArg = () =>
    vi.mocked(generateText).mock.calls[0][0].model as unknown as {
      id: string
      opts: Record<string, unknown>
    }

  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(createOllama).mockImplementation(
      () => ((id: string, opts: unknown) => ({ id, opts })) as any
    )
    process.env = { ...ENV }
    delete process.env.FOLLOWUP_MODEL_ID
    delete process.env.CLASSIFIER_MODEL_ID
    delete process.env.FOLLOWUP_TIMEOUT_MS
    delete process.env.OLLAMA_BASE_URL
    process.env.CLASSIFIER_OLLAMA_BASE_URL = 'http://classifier:11434'
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => {
    process.env = ENV
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses FOLLOWUP_MODEL_ID, then CLASSIFIER_MODEL_ID, then deepseek-v4-pro:cloud', async () => {
    gen('["A?"]')
    await call()
    expect(modelArg().id).toBe('deepseek-v4-pro:cloud')

    vi.mocked(generateText).mockClear()
    process.env.CLASSIFIER_MODEL_ID = 'gemma4:12b'
    await call()
    expect(modelArg().id).toBe('gemma4:12b')

    vi.mocked(generateText).mockClear()
    process.env.FOLLOWUP_MODEL_ID = 'glm-5.2:cloud'
    const r = await call()
    expect(modelArg().id).toBe('glm-5.2:cloud')
    expect(r.model).toBe('glm-5.2:cloud')
  })

  it('uses CLASSIFIER_OLLAMA_BASE_URL, else OLLAMA_BASE_URL', async () => {
    gen('["A?"]')
    process.env.OLLAMA_BASE_URL = 'http://main:11434'
    await call()
    expect(createOllama).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseURL: 'http://classifier:11434' })
    )

    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
    await call()
    expect(createOllama).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseURL: 'http://main:11434' })
    )
  })

  it('returns error without calling the model when no Ollama host is configured', async () => {
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
    const r = await call()
    expect(r.outcome).toBe('error')
    expect(r.questions).toEqual([])
    expect(generateText).not.toHaveBeenCalled()
  })

  it('passes think:false', async () => {
    gen('["A?"]')
    await call()
    expect(modelArg().opts).toEqual(expect.objectContaining({ think: false }))
  })

  it('returns ok with parsed questions', async () => {
    gen('["A?","B?","C?"]')
    const r = await call()
    expect(r).toEqual(
      expect.objectContaining({ outcome: 'ok', questions: ['A?', 'B?', 'C?'] })
    )
    expect(typeof r.ms).toBe('number')
  })

  it('drops echoes of the question and earlier questions', async () => {
    gen('["what is x?","Earlier?","New?"]')
    const r = await call({ previousQuestions: ['earlier?'] })
    expect(r.questions).toEqual(['New?'])
  })

  it('returns skip when the model returns []', async () => {
    gen('[]')
    const r = await call()
    expect(r).toEqual(
      expect.objectContaining({ outcome: 'skip', questions: [] })
    )
  })

  const hangUntilAbort = () =>
    vi.mocked(generateText).mockImplementation(
      ({ abortSignal }: any) =>
        new Promise((_, reject) => {
          abortSignal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        }) as any
    )

  it('returns timeout on abort after FOLLOWUP_TIMEOUT_MS (default 6000)', async () => {
    vi.useFakeTimers()
    hangUntilAbort()
    let settled = false
    const p = call().then(r => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(5999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const r = await p
    expect(r).toEqual(
      expect.objectContaining({ outcome: 'timeout', questions: [] })
    )
  })

  it('honours FOLLOWUP_TIMEOUT_MS', async () => {
    vi.useFakeTimers()
    process.env.FOLLOWUP_TIMEOUT_MS = '1000'
    hangUntilAbort()
    const p = call()
    await vi.advanceTimersByTimeAsync(1000)
    expect((await p).outcome).toBe('timeout')
  })

  it('returns error, never throws, when generateText rejects', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('model down'))
    const r = await call()
    expect(r).toEqual(
      expect.objectContaining({ outcome: 'error', questions: [] })
    )
  })

  it('prompt contains the question, the answer cut to 6000 chars, and the earlier questions', async () => {
    gen('["A?"]')
    await call({
      question: 'How do tides work?',
      answer: 'a'.repeat(7000) + 'TAIL',
      previousQuestions: ['What is the moon made of?']
    })
    const { prompt, system } = vi.mocked(generateText).mock.calls[0][0] as any
    expect(prompt).toContain('How do tides work?')
    expect(prompt).toContain('a'.repeat(6000))
    expect(prompt).not.toContain('a'.repeat(6001))
    expect(prompt).not.toContain('TAIL')
    expect(prompt).toContain('What is the moon made of?')
    expect(system).toMatch(/JSON array/i)
    expect(system).toMatch(/exactly 3/i)
  })

  it('logs one [followups] line with model, ms, outcome, n', async () => {
    gen('["A?","B?"]')
    await call()
    const lines = vi
      .mocked(console.info)
      .mock.calls.map(c => String(c[0]))
      .filter(l => l.startsWith('[followups]'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /model=deepseek-v4-pro:cloud ms=\d+ outcome=ok n=2/
    )
  })

  const followupLine = () => {
    const lines = vi
      .mocked(console.info)
      .mock.calls.map(c => String(c[0]))
      .filter(l => l.startsWith('[followups]'))
    expect(lines).toHaveLength(1)
    return lines[0]
  }

  it('logs the error name and message on error', async () => {
    vi.mocked(generateText).mockRejectedValue(new TypeError('model down'))
    await call()
    expect(followupLine()).toMatch(
      /outcome=error n=0 err=TypeError:model down$/
    )
  })

  it('cuts the logged error message to 120 chars on one line', async () => {
    vi.mocked(generateText).mockRejectedValue(
      new Error('line one\nline two ' + 'x'.repeat(200))
    )
    await call()
    const line = followupLine()
    const message = line.slice(line.indexOf('err=Error:') + 'err=Error:'.length)
    expect(message).toHaveLength(120)
    expect(message.startsWith('line one line two x')).toBe(true)
    expect(line).not.toContain('\n')
  })

  it('logs something usable when a non-Error is thrown', async () => {
    vi.mocked(generateText).mockRejectedValue('plain string')
    await call()
    expect(followupLine()).toMatch(/err=string:plain string$/)
  })

  it.each([
    ['prose with no array', 'Sorry, I cannot help.'],
    ['an array that is not JSON', '[What next?, Why?]']
  ])(
    'keeps skip but logs parse=fail when the reply holds %s',
    async (_n, text) => {
      gen(text)
      const r = await call()
      expect(r.outcome).toBe('skip')
      expect(followupLine()).toMatch(/outcome=skip n=0 parse=fail$/)
    }
  )

  it.each([
    ['ok', '["A?"]', /outcome=ok n=1 parse=ok$/],
    ['skip', '[]', /outcome=skip n=0 parse=ok$/],
    ['skip', '["What is X?"]', /outcome=skip n=0 parse=ok$/]
  ])(
    'logs parse=ok when a JSON array was read (outcome %s from %s)',
    async (_o, text, line) => {
      gen(text)
      await call()
      expect(followupLine()).toMatch(line)
    }
  )

  it('logs neither err= nor parse= on timeout', async () => {
    vi.useFakeTimers()
    hangUntilAbort()
    const p = call()
    await vi.advanceTimersByTimeAsync(6000)
    await p
    expect(followupLine()).toMatch(/outcome=timeout n=0$/)
  })
})
