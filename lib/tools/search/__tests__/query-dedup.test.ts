import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DEDUP_THRESHOLD,
  findDuplicateQuery,
  LEGACY_DEDUP_THRESHOLD,
  normalizeQueryText,
  novelContentTokens,
  queryContentTokens,
  resolveDedupThreshold
} from '../query-dedup'

// Two unit vectors whose cosine is exactly `similarity`, standing in for the
// embedder. Pairs taken from stored turns use the cosine Qwen3-Embedding-0.6B
// actually gave them (replayed 2026-10-01), so these pin real decisions.
function embeddingsAt(similarity: number): [number[], number[]] {
  return [
    [1, 0],
    [similarity, Math.sqrt(1 - similarity * similarity)]
  ]
}

function decide(
  prior: string,
  query: string,
  similarity: number,
  opts: { threshold?: number; tokenGuard?: boolean } = {}
) {
  const [priorEmbedding, queryEmbedding] = embeddingsAt(similarity)
  return findDuplicateQuery(
    query,
    queryEmbedding,
    [{ mode: 'web', query: prior, embedding: priorEmbedding }],
    { threshold: opts.threshold ?? DEFAULT_DEDUP_THRESHOLD, ...opts }
  )
}

const isDuplicate = (prior: string, query: string, similarity: number) =>
  decide(prior, query, similarity).duplicate !== null

describe('findDuplicateQuery: templated queries about different things', () => {
  // The six false skips of the 2026-09-29/30 lab quality runs: each query
  // shares a template with an earlier one but is about another project.
  it.each([
    [
      'Morphic AI search engine GitHub features search backends model support license 2026',
      'Scira AI search engine GitHub stars license features search backends model support',
      0.929
    ],
    [
      'Vane Perplexica self-hosted AI search engine GitHub features Ollama SearXNG MIT license',
      'Farfalle self-hosted AI search engine GitHub Docker Apache license features local LLM',
      0.923
    ],
    [
      'Morphic AI search engine GitHub open source Tavily SearXNG Vercel features self-hosted',
      'Tavily AI search API features pricing LLM search backend 2026',
      0.937
    ],
    [
      'Vane Perplexica self-hosted AI search engine GitHub features Ollama SearXNG MIT license',
      'Exa AI web search API features neural search 2026',
      0.925
    ],
    [
      'Farfalle AI search engine GitHub features search backend Tavily SearXNG licensing',
      'Morphic AI search engine GitHub features search backend Tavily SearXNG Exa licensing Apache',
      0.958
    ],
    [
      'Farfalle AI search engine GitHub features search backend Tavily SearXNG licensing',
      'Morphic AI search engine GitHub miurla features Exa neural search licensing',
      0.929
    ]
  ])('runs "%s" -> "%s" (cos %s)', (prior, query, similarity) => {
    expect(isDuplicate(prior, query, similarity)).toBe(false)
  })

  it('runs a one-name template swap however close the embeddings are', () => {
    expect(
      isDuplicate(
        'Farfalle GitHub features license',
        'Morphic GitHub features license',
        0.99
      )
    ).toBe(false)
  })

  it('runs a new product or facet added to the same subject', () => {
    // Labelled different searches that the cosine-only rule skipped.
    expect(
      isDuplicate(
        'Enphase IQ Battery 5P specs capacity power output chemistry efficiency California 2026',
        'Enphase IQ Battery 10C vs 5P California 2026 price specs continuous power',
        0.947
      )
    ).toBe(false)
    expect(
      isDuplicate(
        'TensorRT-LLM throughput vs vLLM continuous batching comparison benchmarks',
        'TensorRT-LLM in-flight batching vs vLLM continuous batching mechanism',
        0.944
      )
    ).toBe(false)
    expect(
      isDuplicate(
        'RTX 5090 RTX 5080 RTX 5070 Ti memory bandwidth VRAM capacity TDP specifications specs',
        'site:techpowerup.com RTX 5090 RTX 5080 RTX 5070 Ti specs',
        0.927
      )
    ).toBe(false)
  })

  it('reports what made a close query different (for the log)', () => {
    const { duplicate, nearMiss } = decide(
      'Farfalle AI search engine GitHub features search backend Tavily SearXNG licensing',
      'Morphic AI search engine GitHub features search backend Tavily SearXNG Exa licensing Apache',
      0.958
    )
    expect(duplicate).toBeNull()
    expect(nearMiss).toEqual({
      index: 0,
      similarity: expect.closeTo(0.958, 6),
      why: 'adds: morphic, exa, apache'
    })
  })

  it('reports no near miss below the old 0.92 cut-off', () => {
    expect(
      decide(
        'Wells Fargo account closure complaints',
        'Wells Fargo complaints',
        0.886
      ).nearMiss
    ).toBeNull()
  })
})

describe('findDuplicateQuery: true repeats are still skipped', () => {
  it.each([
    // A restatement with fewer words.
    [
      'PostgreSQL 18 new features release notes',
      'PostgreSQL 18 features',
      0.956
    ],
    // Same words, reordered.
    [
      'Radarr custom format regex exclude specific release group negative lookahead',
      'Radarr custom format regex negative lookahead exclude specific release group',
      0.983
    ],
    // Quotes added, filler dropped.
    [
      'Jellyfin QSV hardware transcoding fail Alder Lake software decode works',
      '"Alder Lake" Jellyfin QSV "software decode" "hardware transcoding" fail',
      0.945
    ],
    // A year dropped.
    ['latest Node.js LTS version 2026', 'Node.js latest LTS version', 0.941],
    // Plural folding.
    ['capital city of Australia', 'capital of Australia', 0.966],
    // Only generic search words added.
    [
      'WireGuard cryptokey routing how it works tutorial',
      '"cryptokey routing" WireGuard explained',
      0.909
    ]
  ])('skips "%s" -> "%s" (cos %s)', (prior, query, similarity) => {
    const { duplicate } = decide(prior, query, similarity)
    expect(duplicate).toEqual({
      index: 0,
      reason: 'near',
      similarity: expect.closeTo(similarity, 6)
    })
  })

  it('needs the cosine gate: a bare generalisation is not a repeat', () => {
    expect(
      isDuplicate(
        'Wells Fargo account closure complaints',
        'Wells Fargo complaints',
        0.886
      )
    ).toBe(false)
    expect(
      isDuplicate('OpenClaw vs Hermes agent comparison', 'OpenClaw', 0.855)
    ).toBe(false)
  })

  it('returns the index of the matching prior', () => {
    const [priorEmbedding, queryEmbedding] = embeddingsAt(0.95)
    const decision = findDuplicateQuery(
      'PostgreSQL 18 features',
      queryEmbedding,
      [
        { mode: 'web', query: 'Kidde CO alarm beeping', embedding: [0, 1] },
        {
          mode: 'web',
          query: 'PostgreSQL 18 new features release notes',
          embedding: priorEmbedding
        }
      ],
      { threshold: DEFAULT_DEDUP_THRESHOLD }
    )
    expect(decision.duplicate?.index).toBe(1)
  })
})

describe('findDuplicateQuery: exact repeats', () => {
  it('skips a repeat that differs only in case, punctuation and quotes', () => {
    const { duplicate } = decide(
      'Wells Fargo "account closed" no-warning complaints',
      'wells fargo account closed no warning complaints!',
      0.1
    )
    expect(duplicate).toEqual({ index: 0, reason: 'exact' })
  })

  it('still catches an exact repeat when the embedder is down', () => {
    const decision = findDuplicateQuery(
      'Comcast customer service problems',
      null,
      [
        {
          mode: 'web',
          query: 'Comcast Customer Service Problems',
          embedding: null
        }
      ],
      { threshold: DEFAULT_DEDUP_THRESHOLD }
    )
    expect(decision.duplicate).toEqual({ index: 0, reason: 'exact' })
  })

  it('never skips a non-identical query without an embedding', () => {
    const decision = findDuplicateQuery(
      'PostgreSQL 18 features',
      null,
      [
        {
          mode: 'web',
          query: 'PostgreSQL 18 new features release notes',
          embedding: null
        }
      ],
      { threshold: DEFAULT_DEDUP_THRESHOLD }
    )
    expect(decision).toEqual({ duplicate: null, nearMiss: null })
  })
})

describe('findDuplicateQuery: years, versions and numbers', () => {
  it.each([
    ['best laptops for programming 2025', 'best laptops for programming 2026'],
    ['PostgreSQL 17 new features', 'PostgreSQL 18 new features'],
    ['GPT-5.5 API pricing per token', 'GPT-5.6 API pricing per token'],
    ['iPhone 15 Pro battery life test', 'iPhone 16 Pro battery life test'],
    // A year added to a query without one.
    ['Node.js LTS version', 'Node.js LTS version 2026']
  ])('runs "%s" -> "%s" even at cos 0.98', (prior, query) => {
    expect(isDuplicate(prior, query, 0.98)).toBe(false)
  })

  it('runs a query that drops a model number (it broadens the question)', () => {
    const { duplicate, nearMiss } = decide(
      'Insignia 14.0 cu ft garage ready chest freezer 6444379 lowest price history',
      'Insignia 14.0 Cu Ft Garage-Ready Chest Freezer',
      0.951
    )
    expect(duplicate).toBeNull()
    expect(nearMiss?.why).toBe('drops: 6444379')
  })

  it('keeps a version number as one token', () => {
    expect(queryContentTokens('GPT-5.5 vs GPT-5.6')).toEqual(
      new Set(['gpt', '5.5', 'vs', '5.6'])
    )
  })
})

describe('findDuplicateQuery: word order with directional words', () => {
  it('runs a reversed conversion or route', () => {
    expect(
      isDuplicate(
        'USD to EUR exchange rate today',
        'EUR to USD exchange rate today',
        0.98
      )
    ).toBe(false)
    expect(
      isDuplicate(
        'cheap flights from Seattle to Tokyo',
        'cheap flights from Tokyo to Seattle',
        0.98
      )
    ).toBe(false)
    expect(decide('USD to EUR', 'EUR to USD', 0.98).nearMiss?.why).toBe(
      'reverses word order'
    )
  })

  it('still skips a reorder that keeps the direction', () => {
    expect(
      isDuplicate(
        'how to choose UPS for NAS home server AVR sine wave runtime sizing graceful shutdown NUT',
        'how to choose UPS for NAS home server sine wave AVR graceful shutdown',
        0.962
      )
    ).toBe(true)
    expect(
      isDuplicate(
        'why are race conditions in multithreaded code so hard to debug',
        'why race conditions hard to debug multithreaded code',
        0.981
      )
    ).toBe(true)
  })
})

describe('findDuplicateQuery: other languages', () => {
  it('compares CJK text as character bigrams', () => {
    // Stored prod pair: the second query names factions the first did not.
    expect(
      isDuplicate(
        '吞噬星空2 起源大陆 原住民 设定 本土修士',
        '吞噬星空2 起源大陆 势力 炎风古国 雷霆古国 原住民 外来者',
        0.922
      )
    ).toBe(false)
    expect(
      isDuplicate(
        '择日飞升 宅猪 修炼体系 境界划分',
        '宅猪 择日飞升 境界划分 修炼体系',
        0.97
      )
    ).toBe(true)
    expect(queryContentTokens('修炼体系')).toEqual(
      new Set(['修炼', '炼体', '体系'])
    )
  })

  it('handles accented Latin scripts', () => {
    expect(
      isDuplicate('giá iPhone 16 tại Việt Nam', 'iPhone 16 giá Việt Nam', 0.95)
    ).toBe(true)
    expect(
      isDuplicate(
        'giá iPhone 16 tại Việt Nam',
        'giá Samsung S24 tại Việt Nam',
        0.95
      )
    ).toBe(false)
    expect(
      isDuplicate(
        'mejores portátiles para programar',
        'portátiles mejores programar',
        0.95
      )
    ).toBe(true)
    expect(
      isDuplicate(
        'Wärmepumpe Kosten Einbau',
        'Wärmepumpe Förderung Einbau',
        0.95
      )
    ).toBe(false)
  })
})

describe('findDuplicateQuery: legacy mode (token guard off)', () => {
  it('is cosine-only, as before 2026-10', () => {
    const prior =
      'Farfalle AI search engine GitHub features search backend Tavily SearXNG licensing'
    const query =
      'Morphic AI search engine GitHub features search backend Tavily SearXNG Exa licensing Apache'
    expect(
      decide(prior, query, 0.958, {
        threshold: LEGACY_DEDUP_THRESHOLD,
        tokenGuard: false
      }).duplicate
    ).toEqual({
      index: 0,
      reason: 'near',
      similarity: expect.closeTo(0.958, 6)
    })
    expect(
      decide(prior, query, 0.91, {
        threshold: LEGACY_DEDUP_THRESHOLD,
        tokenGuard: false
      }).duplicate
    ).toBeNull()
  })
})

describe('token helpers', () => {
  it('normalizeQueryText ignores case, quotes and punctuation, not order', () => {
    expect(normalizeQueryText('"Alder Lake" QSV, fail!')).toBe(
      'alder lake qsv fail'
    )
    expect(normalizeQueryText('a b')).not.toBe(normalizeQueryText('b a'))
  })

  it('novelContentTokens ignores stopwords, plurals and generic words', () => {
    expect(
      novelContentTokens(
        'the best guide to PostgreSQL 18 features',
        'PostgreSQL 18 feature'
      )
    ).toEqual([])
    expect(
      novelContentTokens(
        'PostgreSQL 18 features pricing',
        'PostgreSQL 18 features'
      )
    ).toEqual(['pricing'])
  })

  it('splits hyphens but keeps domains and dotted names whole', () => {
    expect(
      queryContentTokens('self-hosted node.js site:docs.podman.io')
    ).toEqual(new Set(['self', 'hosted', 'node.js', 'site', 'docs.podman.io']))
  })
})

describe('resolveDedupThreshold', () => {
  it('defaults to 0.90 with the token guard and 0.92 without', () => {
    expect(resolveDedupThreshold(undefined)).toBe(0.9)
    expect(resolveDedupThreshold('')).toBe(0.9)
    expect(resolveDedupThreshold(undefined, false)).toBe(0.92)
  })

  it('takes a valid override and ignores junk', () => {
    expect(resolveDedupThreshold('0.95')).toBe(0.95)
    expect(resolveDedupThreshold('abc')).toBe(0.9)
    expect(resolveDedupThreshold('1.5')).toBe(0.9)
    expect(resolveDedupThreshold('0')).toBe(0.9)
  })
})

describe('novelContentTokens: folding vs the generic-word list', () => {
  it('"news" is a new facet, not the generic word "new"', () => {
    expect(
      novelContentTokens('Tesla Powerwall news', 'Tesla Powerwall')
    ).toEqual(['news'])
  })

  it('still treats "new" itself as generic', () => {
    expect(
      novelContentTokens('new Tesla Powerwall', 'Tesla Powerwall')
    ).toEqual([])
  })

  it('matches -s generic words after folding (versus, docs, basics)', () => {
    expect(novelContentTokens('Podman versus Docker', 'Podman Docker')).toEqual(
      []
    )
    expect(novelContentTokens('Podman docs', 'Podman')).toEqual([])
    expect(novelContentTokens('Podman basics', 'Podman')).toEqual([])
  })
})
