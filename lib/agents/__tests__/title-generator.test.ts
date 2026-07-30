import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('../../utils/registry', () => ({ getModel: vi.fn(() => 'model') }))
vi.mock('../../utils/telemetry', () => ({
  isTracingEnabled: vi.fn(() => false)
}))
// The local provider. Returns a tagged marker so a test can assert WHICH model
// generateText was handed — the whole point of moving titles off the chat model
// is that the expensive one is no longer called.
vi.mock('ai-sdk-ollama', () => ({
  createOllama: vi.fn(() => (id: string) => `local:${id}`)
}))

import { generateText } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

import { getModel } from '../../utils/registry'
import { generateChatTitle } from '../title-generator'

const gen = (text: string) =>
  vi.mocked(generateText).mockResolvedValue({ text } as any)

const call = (userMessageContent: string) =>
  generateChatTitle({ userMessageContent, modelId: 'm' })

describe('generateChatTitle', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns a normal short title unchanged', async () => {
    gen('Firecrawl Alternatives')
    await expect(
      call('give me a list of providers like firecrawl')
    ).resolves.toBe('Firecrawl Alternatives')
  })

  it('falls back when the model ANSWERS instead of titling', async () => {
    // The prod bug: the user's first message is handed to the title model as
    // the prompt and usually IS a question, so the model answers it. Four
    // prod chats ended up titled with entire answers, longest 4,832 chars.
    // The fallback (the user's own opening words) is a better title than any
    // slice of the answer, so we must NOT truncate the answer into a title.
    const answer =
      'Here is a comprehensive breakdown of providers and tools similar to Firecrawl, grouped by how closely they match its core function (crawling/scraping websites).'
    gen(answer)
    const title = await call(
      'give me a list of all providers like firecrawl, comprehensive'
    )
    expect(title).toBe(
      'give me a list of all providers like firecrawl, comprehensive'
    )
    expect(title).not.toContain('Here is a comprehensive')
    expect(title.length).toBeLessThanOrEqual(75)
  })

  it('salvages the first line when the model titles then keeps talking', async () => {
    gen('Firecrawl Alternatives\n\nHere is why you might want each of them...')
    await expect(call('firecrawl alternatives?')).resolves.toBe(
      'Firecrawl Alternatives'
    )
  })

  it('falls back when even the first line is an answer, not a title', async () => {
    gen(
      'Here is a comprehensive breakdown of every provider similar to Firecrawl and how they compare in detail today.\n\n### Section'
    )
    await expect(call('firecrawl alternatives?')).resolves.toBe(
      'firecrawl alternatives?'
    )
  })

  it('strips surrounding quotes', async () => {
    gen('"Firecrawl Alternatives"')
    await expect(call('q')).resolves.toBe('Firecrawl Alternatives')
  })

  it('falls back on an empty generation', async () => {
    gen('   ')
    await expect(call('how do I back up my server?')).resolves.toBe(
      'how do I back up my server?'
    )
  })

  it('falls back to "New Chat" when there is no user content to fall back on', async () => {
    gen('')
    await expect(call('')).resolves.toBe('New Chat')
  })

  it('falls back when the model throws', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('model down'))
    await expect(call('what is kubernetes')).resolves.toBe('what is kubernetes')
  })
})

// Titling is a 3-5 word transformation of one sentence, and it was spending a
// frontier cloud call per new chat — 523 chats in a week, ~13% of that week's
// kimi-k2.6 volume, to produce a sidebar label. These assert WHICH model is
// asked, because that is the entire change; the title text is unaffected.
describe('generateChatTitle — model selection', () => {
  const ENV = { ...process.env }
  beforeEach(() => {
    vi.resetAllMocks()
    process.env = { ...ENV }
    delete process.env.LOCAL_LLM_BASE_URL
    delete process.env.TITLE_USE_CHAT_MODEL
    delete process.env.TITLE_MODEL_ID
  })
  afterEach(() => {
    process.env = ENV
  })

  it('uses the LOCAL model and never the chat model when a local host exists', async () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://local:11434'
    gen('Closures In JavaScript')

    await expect(call('explain closures in javascript')).resolves.toBe(
      'Closures In JavaScript'
    )

    expect(createOllama).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://local:11434' })
    )
    // The saving only exists if the expensive path is genuinely not taken.
    expect(getModel).not.toHaveBeenCalled()
    expect(vi.mocked(generateText).mock.calls[0][0].model).toBe(
      'local:granite4.1:8b'
    )
  })

  it('honours TITLE_MODEL_ID', async () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://local:11434'
    process.env.TITLE_MODEL_ID = 'qwen3-vl:4b'
    gen('Some Title')
    await call('hello there')
    expect(vi.mocked(generateText).mock.calls[0][0].model).toBe(
      'local:qwen3-vl:4b'
    )
  })

  it('falls back to the chat model when NO local host is configured', async () => {
    // A deployment without a local Ollama must keep getting titles rather than
    // silently losing them to an unreachable host.
    delete process.env.LOCAL_LLM_BASE_URL
    delete process.env.OLLAMA_BASE_URL
    delete process.env.CLASSIFIER_OLLAMA_BASE_URL
    gen('Some Title')
    await call('hello there')
    expect(getModel).toHaveBeenCalled()
    expect(createOllama).not.toHaveBeenCalled()
  })

  it('TITLE_USE_CHAT_MODEL=true restores the old behaviour without a redeploy', async () => {
    process.env.LOCAL_LLM_BASE_URL = 'http://local:11434'
    process.env.TITLE_USE_CHAT_MODEL = 'true'
    gen('Some Title')
    await call('hello there')
    expect(getModel).toHaveBeenCalled()
    expect(createOllama).not.toHaveBeenCalled()
  })

  it('degrades to the user opening words when the local host is down', async () => {
    // The pre-existing fallback already covered a cloud failure; moving to a
    // local model must not turn a miss into a broken chat.
    process.env.LOCAL_LLM_BASE_URL = 'http://local:11434'
    vi.mocked(generateText).mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(call('what is the tallest mountain in Japan')).resolves.toBe(
      'what is the tallest mountain in Japan'
    )
  })
})
