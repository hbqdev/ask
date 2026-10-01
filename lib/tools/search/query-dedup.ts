// In-turn search-query dedup: decides whether a search the model is about to
// run repeats one it already ran this turn, so the tool can return a short
// "reuse those results" note instead of paying for another fan-out.
//
// Cosine similarity alone (the original rule: skip at >= 0.92) cannot tell a
// rephrasing from a templated query about something else. "Morphic AI search
// engine GitHub features search backend Tavily SearXNG Exa licensing Apache"
// scores 0.958 against the same sentence about Farfalle on
// Qwen3-Embedding-0.6B. Of the 76 skips stored on lab, staging and prod
// (reviewed 2026-10-01), 34 dropped a different search: another product,
// model, version, bit-width, source or facet.
//
// So a skip needs one of two things, neither tied to the answering model:
//   1. exact: the queries are equal once case, punctuation and quotes are
//      ignored. No embedding is needed.
//   2. near: cosine >= threshold, AND the new query adds no content word the
//      earlier one lacks (generic search words like "best", "latest",
//      "review" and "explained" aside), AND it drops no number other than a
//      year. A new name, number, version, year, site or facet word ("price",
//      "mechanism") makes it a different search, however close the
//      embeddings are. Dropping a model number or version ("Insignia ... 14.0
//      cu ft ... 6444379 lowest price history" -> "Insignia 14.0 cu ft ...")
//      broadens the question. Dropping words is otherwise allowed: a
//      restatement with fewer words ("PostgreSQL 18 features" after
//      "PostgreSQL 18 new features release notes") is covered by the earlier
//      results. The cosine gate stops bare generalisations ("Wells Fargo
//      complaints" after "Wells Fargo account closure complaints", 0.886) from
//      counting as repeats.
// On 446 labelled query pairs from those turns, this skips 61 of the 245 true
// repeats and no different search. Cosine-only at 0.92 skips 195 true repeats
// and 137 different searches.

import { cosineSimilarity } from '@/lib/embeddings/transformers-embedding'

export interface PriorQuery {
  mode: string
  query: string
  // null when the embedding failed: the prior can still match exactly.
  embedding: number[] | null
}

export interface DuplicateMatch {
  index: number
  reason: 'exact' | 'near'
  similarity?: number
}

// A search the embedding alone would have skipped but the word check keeps.
// Reported so the caller can log it as evidence for tuning.
export interface NearMiss {
  index: number
  similarity: number
  why: string
}

export interface DedupDecision {
  duplicate: DuplicateMatch | null
  nearMiss: NearMiss | null
}

// Cosine gate for the "near" rule. With the word check, no labelled pair is
// wrongly skipped at 0.90 (nor at 0.89). Lower, broadened queries get through
// ("Wells Fargo complaints" at 0.886, "OpenClaw" after "OpenClaw vs Hermes
// agent comparison" at 0.855).
export const DEFAULT_DEDUP_THRESHOLD = 0.9
// The cosine-only rule's cut-off, used when the word check is switched off
// (SEARCH_DEDUP_TOKEN_GUARD=off restores the pre-2026-10 behaviour exactly).
export const LEGACY_DEDUP_THRESHOLD = 0.92

// A kept search at or above this cosine gets a log line: everything the old
// rule would have skipped stays visible.
const NEAR_MISS_LOG_FLOOR = LEGACY_DEDUP_THRESHOLD

export function resolveDedupThreshold(
  raw: string | undefined,
  tokenGuard = true
): number {
  const fallback = tokenGuard ? DEFAULT_DEDUP_THRESHOLD : LEGACY_DEDUP_THRESHOLD
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback
}

// English function words. Function words of other languages count as
// content. That can only make a skip less likely.
const STOPWORDS = new Set(
  (
    'a an the and or of for to in on at by with from about as into via is are ' +
    'was were be been being do does did it its this that these those there ' +
    'their them they he she we you your our my me i what which who whom whose ' +
    'when where why how can could should would will shall may might must not ' +
    'no than then so if but also just any all some more most very much many ' +
    'per each other such own same only both either neither nor too up down ' +
    'out over under again further once here off between through during ' +
    'before after above below until while because'
  ).split(' ')
)

// Generic search words. A query may add these to an earlier one and still be
// a repeat. Kept short on purpose: facet words (price, specs, features,
// benchmark, license, reddit) are not here.
const GENERIC_SEARCH_WORDS = new Set(
  (
    'best top latest new newest current recent today now review guide ' +
    'tutorial explained explanation explain overview compare comparison ' +
    'compared difference vs versus list official documentation docs info ' +
    'information detail example summary introduction intro basics'
  ).split(' ')
)

// Words whose arguments are ordered: "USD to EUR" is not "EUR to USD", and
// "X faster than Y" is not "Y faster than X". The content words on either
// side of one must not appear in the opposite order in the other query.
const DIRECTIONAL_WORDS = new Set([
  'to',
  'from',
  'into',
  'than',
  'before',
  'after',
  'over'
])

// Han ideographs and Japanese kana have no spaces between words, so they are
// compared as overlapping character bigrams.
const CJK_CHARS = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff'
const CJK_CHAR = new RegExp(`[${CJK_CHARS}]`, 'u')
const CJK_SPLIT = new RegExp(`[${CJK_CHARS}]+|[^${CJK_CHARS}]+`, 'gu')

// A word is a run of letters, marks and digits. Internal dots and apostrophes
// are kept, so a version ("5.5", "14.0"), a domain ("docs.podman.io") or
// "node.js" stays one token. Hyphens and everything else split words
// ("self-hosted" -> self, hosted).
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’.][\p{L}\p{M}\p{N}]+)*/gu
const YEAR = /^(?:19|20)\d\d$/
const HAS_DIGIT = /\p{N}/u

function stem(word: string): string {
  // Strip a possessive, then fold plurals of letter-only words.
  const w = word.replace(/['’]s$/u, '')
  if (!/^\p{L}+$/u.test(w)) return w
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) {
    return w.slice(0, -1)
  }
  return w
}

function lowerWords(query: string): string[] {
  return query.normalize('NFKC').toLowerCase().match(WORD) ?? []
}

/** Case, punctuation, quotes and spacing ignored; word order kept. */
export function normalizeQueryText(query: string): string {
  return lowerWords(query).join(' ')
}

/**
 * Content tokens in first-occurrence order. Stopwords are dropped, plurals
 * folded, and CJK text becomes bigrams.
 */
export function queryContentTokens(query: string): Set<string> {
  const out = new Set<string>()
  const add = (w: string) => {
    if (!STOPWORDS.has(w)) out.add(stem(w))
  }
  for (const word of lowerWords(query)) {
    if (!CJK_CHAR.test(word)) {
      add(word)
      continue
    }
    for (const piece of word.match(CJK_SPLIT) ?? []) {
      if (!CJK_CHAR.test(piece)) add(piece)
      else if (piece.length === 1) out.add(piece)
      else {
        for (let i = 0; i < piece.length - 1; i++) {
          out.add(piece.slice(i, i + 2))
        }
      }
    }
  }
  return out
}

/** Content tokens of `query` missing from `prior`, generic words aside. */
export function novelContentTokens(query: string, prior: string): string[] {
  const priorTokens = queryContentTokens(prior)
  return [...queryContentTokens(query)].filter(
    t => !priorTokens.has(t) && !GENERIC_SEARCH_WORDS.has(t)
  )
}

// (left, right) content-word pairs around each directional word, e.g.
// "USD to EUR" -> [usd, eur]; "how to choose X" has no left word, so none.
function directionalPairs(query: string): [string, string][] {
  const words = lowerWords(query)
  const tokens = words.map(w => [...queryContentTokens(w)])
  const pairs: [string, string][] = []
  words.forEach((word, i) => {
    if (!DIRECTIONAL_WORDS.has(word)) return
    let left: string | undefined
    let right: string | undefined
    for (let j = i - 1; j >= 0 && left === undefined; j--) {
      left = tokens[j].at(-1)
    }
    for (let j = i + 1; j < words.length && right === undefined; j++) {
      right = tokens[j][0]
    }
    if (left && right && left !== right) pairs.push([left, right])
  })
  return pairs
}

function reversesDirection(query: string, prior: string): boolean {
  const flipped = (pairs: [string, string][], other: string) => {
    const order = [...queryContentTokens(other)]
    return pairs.some(([left, right]) => {
      const l = order.indexOf(left)
      const r = order.indexOf(right)
      return l !== -1 && r !== -1 && l > r
    })
  }
  return (
    flipped(directionalPairs(prior), query) ||
    flipped(directionalPairs(query), prior)
  )
}

// Why `query` is a different search from `prior` although their embeddings
// are close, or null when nothing distinguishes them.
function distinguishingDifference(query: string, prior: string): string | null {
  const novel = novelContentTokens(query, prior)
  if (novel.length > 0) return `adds: ${novel.join(', ')}`
  const droppedNumbers = novelContentTokens(prior, query).filter(
    t => HAS_DIGIT.test(t) && !YEAR.test(t)
  )
  if (droppedNumbers.length > 0) return `drops: ${droppedNumbers.join(', ')}`
  if (reversesDirection(query, prior)) return 'reverses word order'
  return null
}

/**
 * Decide whether `query` repeats one of `priors` (queries already run this
 * turn in the same search mode). `embedding` may be null when the embedder is
 * down, and then only the exact rule applies. With `tokenGuard: false` the
 * decision is the legacy one: cosine >= threshold alone.
 */
export function findDuplicateQuery(
  query: string,
  embedding: number[] | null,
  priors: PriorQuery[],
  opts: { threshold: number; tokenGuard?: boolean }
): DedupDecision {
  const tokenGuard = opts.tokenGuard !== false
  const key = normalizeQueryText(query)
  if (tokenGuard && key) {
    const exact = priors.findIndex(p => normalizeQueryText(p.query) === key)
    if (exact !== -1) {
      return { duplicate: { index: exact, reason: 'exact' }, nearMiss: null }
    }
  }
  if (!embedding) return { duplicate: null, nearMiss: null }

  let nearMiss: NearMiss | null = null
  for (let i = 0; i < priors.length; i++) {
    const prior = priors[i]
    if (!prior.embedding) continue
    const similarity = cosineSimilarity(embedding, prior.embedding)
    const why =
      tokenGuard && similarity >= Math.min(opts.threshold, NEAR_MISS_LOG_FLOOR)
        ? distinguishingDifference(query, prior.query)
        : null
    if (similarity >= opts.threshold && why === null) {
      return {
        duplicate: { index: i, reason: 'near', similarity },
        nearMiss: null
      }
    }
    if (
      why !== null &&
      similarity >= NEAR_MISS_LOG_FLOOR &&
      (!nearMiss || similarity > nearMiss.similarity)
    ) {
      nearMiss = { index: i, similarity, why }
    }
  }
  return { duplicate: null, nearMiss }
}
