import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi
} from 'vitest'

// End-to-end routing through the REAL cross-encoder client (only fetch is
// stubbed): memory recall goes to RECALL_RERANKER_URL when set and falls back
// to RERANKER_URL when not; search reranking, the snippet gate and upload/URL
// RAG (rankChunks) always stay on RERANKER_URL.

vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  cosineSimilarity: () => 1,
  getConfiguredModel: () => 'm'
}))
vi.mock('@/lib/db/recall-actions', () => ({
  vectorSearchChunks: vi.fn(async () => []),
  keywordSearchChunks: vi.fn(async () => []),
  isRecallEnabled: vi.fn(async () => true)
}))

import { rerankByCrossEncoder } from '@/lib/embeddings/rerank'
import { rankChunks } from '@/lib/embeddings/upload-rag'
import { rankRecallCandidates } from '@/lib/memory/recall-search'
import { runSnippetGate } from '@/lib/search/snippet-gate'

const SEARCH = 'http://search-reranker.test:8787'
const RECALL = 'http://recall-reranker.test:8789'

const hit = (chunkId: string, score: number) => ({
  chunkId,
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: `passage ${chunkId}`,
  createdAt: new Date('2026-07-01'),
  score
})

let fetchSpy: MockInstance<typeof fetch>

function rerankUrls(): string[] {
  return fetchSpy.mock.calls.map(([url]) => String(url))
}

async function recallOnce() {
  return rankRecallCandidates(
    { query: 'q', vectorHits: [hit('a', 0.9), hit('b', 0.8)], keywordHits: [] },
    { topK: 2, useRerank: true }
  )
}

describe('reranker routing', () => {
  beforeEach(() => {
    vi.stubEnv('RERANKER_URL', SEARCH)
    vi.stubEnv('RERANKER_API_TOKEN', 'tok')
    vi.stubEnv('SEARCH_SNIPPET_GATE', 'shadow')
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        const { passages } = JSON.parse(String(init?.body))
        return new Response(
          JSON.stringify({ scores: passages.map(() => 0.5) }),
          { status: 200 }
        )
      })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('recall uses RECALL_RERANKER_URL when it is set', async () => {
    vi.stubEnv('RECALL_RERANKER_URL', RECALL)
    const hits = await recallOnce()
    expect(hits.length).toBeGreaterThan(0)
    expect(rerankUrls()).toEqual([`${RECALL}/rerank`])
  })

  it('recall falls back to RERANKER_URL when RECALL_RERANKER_URL is unset', async () => {
    vi.stubEnv('RECALL_RERANKER_URL', undefined as unknown as string)
    const hits = await recallOnce()
    expect(hits.length).toBeGreaterThan(0)
    expect(rerankUrls()).toEqual([`${SEARCH}/rerank`])
  })

  it('search, snippet gate and upload/URL RAG never use RECALL_RERANKER_URL', async () => {
    vi.stubEnv('RECALL_RERANKER_URL', RECALL)

    await rerankByCrossEncoder(
      [{ content: 'a page about qubits', id: 'x' }],
      'quantum',
      1
    )
    await runSnippetGate(
      'quantum',
      [{ url: 'https://a.test', title: 't', content: 'body' }],
      new Set()
    )
    await rankChunks(
      'quantum',
      [
        { content: 'chunk one', embedding: [1, 0] },
        { content: 'chunk two', embedding: [1, 0] }
      ],
      [1, 0]
    )

    const urls = rerankUrls()
    expect(urls.length).toBe(3)
    expect(urls.every(u => u === `${SEARCH}/rerank`)).toBe(true)
  })
})
