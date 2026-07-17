import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('ai', () => ({ generateText: vi.fn() }))
vi.mock('../../utils/registry', () => ({ getModel: vi.fn(() => 'model') }))
vi.mock('../../utils/telemetry', () => ({ isTracingEnabled: vi.fn(() => false) }))

import { generateText } from 'ai'

import { generateChatTitle } from '../title-generator'

const gen = (text: string) =>
  vi.mocked(generateText).mockResolvedValue({ text } as any)

const call = (userMessageContent: string) =>
  generateChatTitle({ userMessageContent, modelId: 'm' })

describe('generateChatTitle', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns a normal short title unchanged', async () => {
    gen('Firecrawl Alternatives')
    await expect(call('give me a list of providers like firecrawl')).resolves.toBe(
      'Firecrawl Alternatives'
    )
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
    const title = await call('give me a list of all providers like firecrawl, comprehensive')
    expect(title).toBe('give me a list of all providers like firecrawl, comprehensive')
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
