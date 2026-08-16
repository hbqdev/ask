import { afterEach, describe, expect, it, vi } from 'vitest'

// Cross-encoder prefers any passage containing "answer".
vi.mock('../../utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => true),
  crossEncoderScore: vi.fn(async (_q: string, passages: string[]) =>
    passages.map(p => (/answer/i.test(p) ? 1 : 0))
  )
}))

// Deterministic embeddings: every text is equally "close", so the cosine
// candidate pool is just insertion order and the cross-encoder decides.
vi.mock('../transformers-embedding', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  cosineSimilarity: () => 1,
  getConfiguredModel: () => 'Xenova/all-MiniLM-L6-v2'
}))

// The fetch tool owns the whole extraction chain; url-rag drives its
// generator. Mock it so no network / rescue tiers run.
vi.mock('@/lib/tools/fetch', () => ({
  fetchTool: { execute: vi.fn() }
}))

import { fetchTool } from '@/lib/tools/fetch'

import { retrieveUrlChunks } from '../url-rag'

// Long enough (>512 tokens) that splitText yields several chunks; exactly one
// sentence carries the "answer" marker the mocked cross-encoder rewards.
const FILLER = 'This is a filler sentence about generic unrelated topics here. '
const ANSWER =
  'The special magic answer to the whole question lives right here in this line. '
const PAGE_TEXT = FILLER.repeat(40) + ANSWER + FILLER.repeat(40)

function yieldsResults(results: unknown[]) {
  return async function* () {
    yield { state: 'fetching', url: 'https://example.com/doc' }
    yield { state: 'complete', results, query: '', images: [] }
  }
}

const execMock = fetchTool.execute as unknown as ReturnType<typeof vi.fn>

describe('retrieveUrlChunks', () => {
  afterEach(() => vi.clearAllMocks())

  it('returns the top-K ranked chunks and the page title', async () => {
    execMock.mockImplementation(
      yieldsResults([
        {
          title: 'Doc Title',
          content: PAGE_TEXT,
          url: 'https://example.com/doc'
        }
      ])
    )

    const out = await retrieveUrlChunks(
      'https://example.com/doc',
      'what is the answer',
      2
    )

    expect(out).not.toBeNull()
    expect(out!.title).toBe('Doc Title')
    expect(out!.chunks.length).toBeGreaterThanOrEqual(1)
    expect(out!.chunks.length).toBeLessThanOrEqual(2)
    // Cross-encoder rewarded the answer chunk, so it ranks first.
    expect(out!.chunks[0]).toMatch(/answer/i)
  })

  it('returns null when the fetch tool signals failure (no throw)', async () => {
    execMock.mockImplementation(
      yieldsResults([
        {
          title: 'Fetch failed: https://example.com/doc',
          content:
            'Could not retrieve this page (blocked). Skip this URL and continue with other sources.',
          url: 'https://example.com/doc'
        }
      ])
    )

    await expect(
      retrieveUrlChunks('https://example.com/doc', 'q')
    ).resolves.toBeNull()
  })

  it('returns null (never throws) when extraction throws', async () => {
    execMock.mockImplementation(() => {
      throw new Error('boom')
    })

    await expect(
      retrieveUrlChunks('https://example.com/doc', 'q')
    ).resolves.toBeNull()
  })

  it('returns null when no complete result is produced', async () => {
    execMock.mockImplementation(async function* () {
      yield { state: 'fetching', url: 'https://example.com/doc' }
    })

    await expect(
      retrieveUrlChunks('https://example.com/doc', 'q')
    ).resolves.toBeNull()
  })

  it('returns null when the extracted body is too short to be meaningful', async () => {
    execMock.mockImplementation(
      yieldsResults([
        { title: 'Tiny', content: 'too short', url: 'https://example.com/doc' }
      ])
    )

    await expect(
      retrieveUrlChunks('https://example.com/doc', 'q')
    ).resolves.toBeNull()
  })
})
