import { promises as fs } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => true),
  crossEncoderScore: vi.fn(async (_q: string, passages: string[]) =>
    // Prefer the chunk containing "answer".
    passages.map(p => (/answer/i.test(p) ? 1 : 0))
  )
}))

// Make cosine retrieval deterministic: every chunk equally "close" so the
// candidate pool is just insertion order, and the cross-encoder decides.
vi.mock('../transformers-embedding', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  cosineSimilarity: () => 1,
  getConfiguredModel: () => 'Xenova/all-MiniLM-L6-v2'
}))

import { queryFileChunks } from '../upload-rag'

describe('queryFileChunks with cross-encoder', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reranks the cosine candidate pool with the cross-encoder', async () => {
    const stored = {
      filename: 'doc.pdf',
      model: 'Xenova/all-MiniLM-L6-v2',
      chunks: [
        { content: 'irrelevant preamble one', embedding: [1, 0] },
        { content: 'the answer you want is here', embedding: [1, 0] },
        { content: 'irrelevant preamble two', embedding: [1, 0] }
      ]
    }
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(stored) as never)

    const out = await queryFileChunks('/uploads/doc.pdf', 'what is the answer', 1)
    expect(out).not.toBeNull()
    expect(out!.chunks[0]).toContain('answer')
  })
})
