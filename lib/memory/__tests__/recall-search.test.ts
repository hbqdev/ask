import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(async () => [new Array(1024).fill(0.1)]),
  getConfiguredModel: vi.fn(() => 'm')
}))
vi.mock('@/lib/db/recall-actions', () => ({
  vectorSearchChunks: vi.fn(async () => []),
  keywordSearchChunks: vi.fn(async () => []),
  isRecallEnabled: vi.fn(async () => true)
}))
vi.mock('@/lib/utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => false),
  crossEncoderScore: vi.fn(async () => []),
  recallRerankerUrl: vi.fn(() => 'http://search-reranker:8787')
}))

import * as db from '@/lib/db/recall-actions'
import {
  crossEncoderScore,
  isCrossEncoderConfigured,
  recallRerankerUrl
} from '@/lib/utils/cross-encoder'

import {
  dedupeByText,
  isQueryEcho,
  prepareRecallCandidates,
  rankRecallCandidates,
  recallSearch,
  recallTextTokens,
  retrieveRecallCandidates,
  selectRerankCandidates
} from '../recall-search'

const row = (over: Partial<any> = {}) => ({
  chunkId: 'k1',
  chatId: 'c1',
  chatTitle: 'Backups',
  role: 'assistant' as const,
  content: '3-2-1 rule',
  createdAt: new Date('2026-07-01'),
  score: 0.9,
  ...over
})

describe('selectRerankCandidates', () => {
  const vec = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      row({ chunkId: `v${i}`, score: 1 - i / 100 })
    )
  const kw = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ chunkId: `k${i}`, score: 0 }))

  it('caps the pool at the requested size', () => {
    expect(selectRerankCandidates(vec(30), kw(30), 20)).toHaveLength(20)
  })

  it('keeps keyword-only hits that a top-N-by-score cut would discard', () => {
    // The regression this guards: keyword-only hits carry score 0, so any
    // "sort the union by score, take the top N" cap drops all of them once
    // the vector arm alone fills N — silently reducing the hybrid to its
    // vector arm. The vector arm returns up to 30, so that is always.
    const picked = selectRerankCandidates(vec(30), kw(30), 20)
    const keywordOnly = picked.filter(h => h.chunkId.startsWith('k'))
    expect(keywordOnly).toHaveLength(5)
    expect(picked.filter(h => h.chunkId.startsWith('v'))).toHaveLength(15)
  })

  it('gives the whole pool to the vector arm when no keyword-only hits exist', () => {
    const picked = selectRerankCandidates(vec(30), [], 20)
    expect(picked).toHaveLength(20)
    expect(picked.every(h => h.chunkId.startsWith('v'))).toBe(true)
  })

  it('does not reserve slots for keyword hits the vector arm already found', () => {
    // Same chunk in both arms is not a "keyword-only" hit — it must not
    // consume reserve, or the pool loses vector candidates for nothing.
    const overlap = [row({ chunkId: 'v0', score: 0 })]
    const picked = selectRerankCandidates(vec(30), overlap, 20)
    expect(picked).toHaveLength(20)
    expect(picked.every(h => h.chunkId.startsWith('v'))).toBe(true)
  })

  it("preserves each arm's ordering (vector by cosine, keyword by recency)", () => {
    const picked = selectRerankCandidates(vec(30), kw(30), 20)
    expect(picked.slice(0, 3).map(h => h.chunkId)).toEqual(['v0', 'v1', 'v2'])
    expect(picked.slice(15).map(h => h.chunkId)).toEqual([
      'k0',
      'k1',
      'k2',
      'k3',
      'k4'
    ])
  })

  it('returns everything when the arms are smaller than the pool', () => {
    expect(selectRerankCandidates(vec(3), kw(2), 20)).toHaveLength(5)
  })
})

describe('recallSearch', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so each test starts from the
    // vi.mock() factory defaults — clearAllMocks only wipes call history,
    // it leaves a prior test's mockResolvedValue() implementation in place,
    // which otherwise leaks stub results (e.g. a stray keyword-arm hit)
    // across unrelated tests.
    vi.resetAllMocks()
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(false)
  })

  it('unions both arms and dedups by chunk id (vector score wins)', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([row({ score: 0.9 })])
    vi.mocked(db.keywordSearchChunks).mockResolvedValue([row({ score: 0 })])
    const hits = await recallSearch('u1', 'backups', {
      topK: 5,
      useRerank: false
    })
    expect(hits).toHaveLength(1)
    expect(hits[0].score).toBe(0.9)
  })

  it('applies minScore as a cosine gate when not reranking', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.5 })
    ])
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: false,
      minScore: 0.75
    })
    expect(hits.map(h => h.chunkId)).toEqual(['a'])
  })

  it('reranks and overwrites score when the cross-encoder is configured', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockResolvedValue([0.1, 0.99])
    const hits = await recallSearch('u1', 'q', { topK: 5, useRerank: true })
    expect(hits.map(h => h.chunkId)).toEqual(['b', 'a'])
    expect(hits[0].score).toBe(0.99)
  })

  it('sends the recall rerank to the recall reranker endpoint', async () => {
    // RECALL_RERANKER_URL (resolved by recallRerankerUrl, falling back to
    // RERANKER_URL) gives recall its own reranker so its 1.5s budget does not
    // queue behind search reranks on the shared one.
    vi.mocked(recallRerankerUrl).mockReturnValue('http://recall-reranker:8789')
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockResolvedValue([0.1, 0.99])
    await recallSearch('u1', 'q', { topK: 5, useRerank: true })
    expect(isCrossEncoderConfigured).toHaveBeenCalledWith(
      'http://recall-reranker:8789'
    )
    const [, , opts] = vi.mocked(crossEncoderScore).mock.calls[0]
    expect(opts).toEqual(
      expect.objectContaining({ baseUrl: 'http://recall-reranker:8789' })
    )
  })

  it('sends the capped candidate set to the reranker, not the full union', async () => {
    // Pins the cost bound: both arms return up to 30 rows each, so an
    // uncapped union would rerank ~60 passages (measured 7.6s against a 10s
    // timeout). RECALL_RERANK_POOL defaults to 10 (see rerankPoolSize).
    vi.mocked(db.vectorSearchChunks).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) =>
        row({ chunkId: `v${i}`, score: 1 - i / 100 })
      )
    )
    vi.mocked(db.keywordSearchChunks).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => row({ chunkId: `k${i}`, score: 0 }))
    )
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockResolvedValue(new Array(10).fill(0.5))

    await recallSearch('u1', 'q', { topK: 2, useRerank: true })

    const [, passages, opts] = vi.mocked(crossEncoderScore).mock.calls[0]
    expect(passages).toHaveLength(10)
    // Rerank cost is linear in passages x tokens — the per-pair budget is
    // part of the latency bound (RECALL_RERANK_MAX_LENGTH, default 384).
    expect(opts).toEqual(expect.objectContaining({ maxLength: 384 }))
  })

  it('honours RECALL_RERANK_POOL / RECALL_RERANK_MAX_LENGTH overrides', async () => {
    vi.stubEnv('RECALL_RERANK_POOL', '4')
    vi.stubEnv('RECALL_RERANK_MAX_LENGTH', '256')
    try {
      vi.mocked(db.vectorSearchChunks).mockResolvedValue(
        Array.from({ length: 30 }, (_, i) =>
          row({ chunkId: `v${i}`, score: 1 - i / 100 })
        )
      )
      vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
      vi.mocked(crossEncoderScore).mockResolvedValue(new Array(4).fill(0.5))
      await recallSearch('u1', 'q', { topK: 2, useRerank: true })
      const [, passages, opts] = vi.mocked(crossEncoderScore).mock.calls[0]
      expect(passages).toHaveLength(4)
      expect(opts).toEqual(expect.objectContaining({ maxLength: 256 }))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not cap the non-rerank path (the cap only bounds rerank cost)', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue(
      Array.from({ length: 30 }, (_, i) =>
        row({ chunkId: `v${i}`, score: 1 - i / 100 })
      )
    )
    const hits = await recallSearch('u1', 'q', { topK: 50, useRerank: false })
    expect(hits).toHaveLength(30)
  })

  it('falls back to cosine order when the reranker throws (no minScore)', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockRejectedValue(new Error('reranker down'))
    const hits = await recallSearch('u1', 'q', { topK: 5, useRerank: true })
    expect(hits.map(h => h.chunkId)).toEqual(['a', 'b'])
  })

  it('filters on the RERANK scale once rerank actually runs', async () => {
    // Cosine-sorted order going into rerank is [a (0.9), b (0.8)].
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    // Rerank inverts the cosine order: 'a' (cosine-favored) scores low on
    // rerank (0.001, below minScore), 'b' scores high (0.2, above) —
    // proves the filter reads the post-rerank score, not the pre-rerank
    // cosine score.
    vi.mocked(crossEncoderScore).mockResolvedValue([0.001, 0.2])
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: true,
      minScore: 0.05
    })
    expect(hits.map(h => h.chunkId)).toEqual(['b'])
  })

  it('fails closed to [] when useRerank+minScore is requested but the cross-encoder is unconfigured', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(false)
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: true,
      minScore: 0.05
    })
    expect(hits).toEqual([])
  })

  it('fails closed to [] when useRerank+minScore is requested but crossEncoderScore throws', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
    vi.mocked(crossEncoderScore).mockRejectedValue(new Error('reranker down'))
    const hits = await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: true,
      minScore: 0.05
    })
    expect(hits).toEqual([])
  })

  it('passes excludeChatId to both arms', async () => {
    await recallSearch('u1', 'q', {
      topK: 5,
      useRerank: false,
      excludeChatId: 'c9'
    })
    expect(db.vectorSearchChunks).toHaveBeenCalledWith(
      'u1',
      expect.anything(),
      30,
      'c9'
    )
    expect(db.keywordSearchChunks).toHaveBeenCalledWith('u1', 'q', 30, 'c9')
  })

  it('is inert when recall is disabled, and never throws on error', async () => {
    vi.mocked(db.isRecallEnabled).mockResolvedValue(false)
    expect(
      await recallSearch('u1', 'q', { topK: 5, useRerank: false })
    ).toEqual([])
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(db.vectorSearchChunks).mockRejectedValue(new Error('db down'))
    await expect(
      recallSearch('u1', 'q', { topK: 5, useRerank: false })
    ).resolves.toEqual([])
  })
})

describe('retrieveRecallCandidates / rankRecallCandidates (split stages)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
  })

  it('retrieval never touches the reranker (safe to run speculatively)', async () => {
    vi.mocked(db.vectorSearchChunks).mockResolvedValue([
      row({ chunkId: 'a', score: 0.9 }),
      row({ chunkId: 'b', score: 0.8 })
    ])
    const c = await retrieveRecallCandidates('u1', 'q', { topK: 2 })
    expect(c?.query).toBe('q')
    expect(c?.vectorHits.map(h => h.chunkId)).toEqual(['a', 'b'])
    expect(crossEncoderScore).not.toHaveBeenCalled()
  })

  it('returns null when recall is disabled', async () => {
    vi.mocked(db.isRecallEnabled).mockResolvedValue(false)
    expect(await retrieveRecallCandidates('u1', 'q', { topK: 2 })).toBeNull()
  })

  it('ranks against the query the candidates were retrieved for', async () => {
    vi.mocked(crossEncoderScore).mockResolvedValue([0.01, 0.9])
    const hits = await rankRecallCandidates(
      {
        query: 'the retrieved query',
        vectorHits: [
          row({ chunkId: 'a', score: 0.9 }),
          row({ chunkId: 'b', score: 0.8 })
        ] as any,
        keywordHits: []
      },
      { topK: 2, useRerank: true, minScore: 0.05 }
    )
    expect(vi.mocked(crossEncoderScore).mock.calls[0][0]).toBe(
      'the retrieved query'
    )
    expect(hits.map(h => h.chunkId)).toEqual(['b'])
  })
})

describe('recallTextTokens (normalization for echo + dedupe)', () => {
  it('folds case, whitespace and punctuation', () => {
    expect(recallTextTokens('  What IS the difference —\n TCP/UDP?! ')).toEqual(
      ['what', 'is', 'the', 'difference', 'tcp', 'udp']
    )
  })

  it("expands contractions, straight or curly, so What's == What is", () => {
    expect(recallTextTokens("What's")).toEqual(['what', 'is'])
    expect(recallTextTokens('What’s')).toEqual(['what', 'is'])
    expect(recallTextTokens("don't")).toEqual(['do', 'not'])
  })

  it('keeps non-Latin letters and digits', () => {
    expect(recallTextTokens('Café 2026: naïve über-日本')).toEqual([
      'café',
      '2026',
      'naïve',
      'über',
      '日本'
    ])
  })
})

describe('isQueryEcho', () => {
  const q =
    "What's the difference between self-drilling screws and structural screws for wood framing?"

  it('catches an exact repeat after normalization', () => {
    expect(
      isQueryEcho(
        'what is the difference between self drilling screws and structural screws for wood framing',
        q
      )
    ).toBe(true)
  })

  it('catches the question plus trivial framing (up to 4 added words)', () => {
    expect(isQueryEcho(`${q} Keep it short.`, q)).toBe(true)
    expect(
      isQueryEcho('In one sentence, what is a stack?', 'what is a stack')
    ).toBe(true)
    expect(
      isQueryEcho(
        'Model label check: reply with just OK.',
        'Reply with just OK.'
      )
    ).toBe(true)
  })

  it('catches the reverse: a past question that is the current one minus framing', () => {
    expect(
      isQueryEcho('what is a stack', 'In one sentence, what is a stack?')
    ).toBe(true)
  })

  it('catches a repeat that dropped a filler word', () => {
    expect(
      isQueryEcho(
        'best budget gpu for plex hardware transcoding 2026',
        'best budget GPU for plex hardware transcoding in 2026'
      )
    ).toBe(true)
  })

  it('does NOT treat a same-template question about another subject as an echo', () => {
    expect(
      isQueryEcho(
        'In one sentence, what is a heap?',
        'In one sentence, what is a stack?'
      )
    ).toBe(false)
    expect(
      isQueryEcho(
        'No need to search the web. In one sentence, what is a prime number?',
        'No need to search the web. In one sentence, what is a composite number?'
      )
    ).toBe(false)
  })

  it('does NOT drop a candidate that adds more than 4 words', () => {
    expect(
      isQueryEcho(
        'what is a stack and how does it differ from a queue',
        'what is a stack'
      )
    ).toBe(false)
  })

  it('does NOT drop an answer that merely contains the question', () => {
    const answer =
      'What is the difference between TCP and UDP? TCP is connection-oriented and guarantees ordered delivery; UDP is connectionless and does not.'
    expect(
      isQueryEcho(answer, 'What is the difference between TCP and UDP?')
    ).toBe(false)
  })

  it('needs an exact match for very short texts (under 3 words)', () => {
    expect(isQueryEcho('docker compose', 'docker')).toBe(false)
    expect(isQueryEcho('Docker!', 'docker')).toBe(true)
  })

  it('is false for an empty query or candidate', () => {
    expect(isQueryEcho('anything at all here', '  ')).toBe(false)
    expect(isQueryEcho('', 'what is a stack')).toBe(false)
  })
})

describe('dedupeByText', () => {
  it('keeps the higher-scored of identical normalized texts, in input order', () => {
    const out = dedupeByText([
      row({ chunkId: 'a', content: 'Hello, world', score: 0.2 }),
      row({ chunkId: 'b', content: 'something else', score: 0.5 }),
      row({ chunkId: 'c', content: 'hello   WORLD!', score: 0.9 })
    ])
    expect(out.map(h => h.chunkId)).toEqual(['b', 'c'])
  })

  it('keeps the first of equal scores', () => {
    const out = dedupeByText([
      row({ chunkId: 'a', content: 'same', score: 0.5 }),
      row({ chunkId: 'b', content: 'same', score: 0.5 })
    ])
    expect(out.map(h => h.chunkId)).toEqual(['a'])
  })
})

describe('prepareRecallCandidates / rankRecallCandidates selection rules', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(db.isRecallEnabled).mockResolvedValue(true)
    vi.mocked(isCrossEncoderConfigured).mockReturnValue(true)
  })

  const Q = 'What is the difference between TCP and UDP?'

  it('drops query echoes BEFORE the rerank, so their pool slots go to real candidates', async () => {
    vi.stubEnv('RECALL_RERANK_POOL', '2')
    try {
      vi.mocked(crossEncoderScore).mockResolvedValue([0.9, 0.8])
      const hits = await rankRecallCandidates(
        {
          query: Q,
          vectorHits: [
            row({ chunkId: 'echo1', role: 'user', content: Q, score: 0.99 }),
            row({
              chunkId: 'echo2',
              role: 'user',
              content: 'what is the difference between tcp and udp',
              score: 0.98
            }),
            row({
              chunkId: 'ans1',
              content: 'TCP is reliable; UDP is not.',
              score: 0.7
            }),
            row({
              chunkId: 'ans2',
              content: 'UDP suits games and VoIP.',
              score: 0.6
            })
          ],
          keywordHits: [
            row({
              chunkId: 'echo3',
              role: 'user',
              content: `${Q} Keep it short.`,
              score: 0
            })
          ]
        },
        { topK: 2, useRerank: true, minScore: 0.05, dropEchoesOf: [Q] }
      )
      const [, passages] = vi.mocked(crossEncoderScore).mock.calls[0]
      expect(passages).toEqual([
        'TCP is reliable; UDP is not.',
        'UDP suits games and VoIP.'
      ])
      expect(hits.map(h => h.chunkId)).toEqual(['ans1', 'ans2'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('drops echoes of every text in dropEchoesOf (the rewrite AND the literal user message)', () => {
    const out = prepareRecallCandidates(
      {
        query: 'Which of Redis or Memcached suits a small home server cache?',
        vectorHits: [
          row({
            chunkId: 'u',
            role: 'user',
            content:
              'which one would you pick for a small home server cache then?'
          }),
          row({ chunkId: 'a', content: 'Redis, for persistence.' })
        ],
        keywordHits: []
      },
      {
        dropEchoesOf: [
          'Which of Redis or Memcached suits a small home server cache?',
          'Which one would you pick for a small home server cache then?'
        ]
      }
    )
    expect(out.vectorHits.map(h => h.chunkId)).toEqual(['a'])
  })

  it('keeps echoes when dropEchoesOf is not set (recall tool, Library)', () => {
    const c = {
      query: Q,
      vectorHits: [row({ chunkId: 'echo', role: 'user' as const, content: Q })],
      keywordHits: []
    }
    expect(prepareRecallCandidates(c, {}).vectorHits).toHaveLength(1)
  })

  it('dedupes identical text across both arms before the rerank (one copy scored)', async () => {
    vi.mocked(crossEncoderScore).mockResolvedValue([0.9, 0.5])
    const hits = await rankRecallCandidates(
      {
        query: 'backups',
        vectorHits: [
          row({ chunkId: 'a1', content: 'Use the 3-2-1 rule.', score: 0.8 }),
          row({ chunkId: 'a2', content: 'use the 3 2 1 rule', score: 0.8 }),
          row({ chunkId: 'b', content: 'Test your restores.', score: 0.7 })
        ],
        keywordHits: [
          // Same text as a vector hit: not "keyword-only", must not take a
          // reserve slot or be scored twice.
          row({ chunkId: 'a3', content: 'USE THE 3-2-1 RULE!', score: 0 })
        ]
      },
      { topK: 5, useRerank: true, dedupe: true }
    )
    const [, passages] = vi.mocked(crossEncoderScore).mock.calls[0]
    expect(passages).toEqual(['Use the 3-2-1 rule.', 'Test your restores.'])
    expect(hits.map(h => h.chunkId)).toEqual(['a1', 'b'])
  })

  it('dedupes on the non-rerank (cosine) path too, keeping the higher score', async () => {
    const hits = await rankRecallCandidates(
      {
        query: 'q',
        vectorHits: [
          row({ chunkId: 'hi', content: 'same text', score: 0.9 }),
          row({ chunkId: 'lo', content: 'Same text.', score: 0.4 })
        ],
        keywordHits: []
      },
      { topK: 5, useRerank: false, dedupe: true }
    )
    expect(hits.map(h => h.chunkId)).toEqual(['hi'])
  })

  it('leaves duplicates alone unless dedupe is requested (Library lists chats)', async () => {
    const hits = await rankRecallCandidates(
      {
        query: 'q',
        vectorHits: [
          row({ chunkId: 'x', chatId: 'c1', content: 'same text', score: 0.9 }),
          row({ chunkId: 'y', chatId: 'c2', content: 'same text', score: 0.9 })
        ],
        keywordHits: []
      },
      { topK: 5, useRerank: false }
    )
    expect(hits.map(h => h.chunkId)).toEqual(['x', 'y'])
  })
})
