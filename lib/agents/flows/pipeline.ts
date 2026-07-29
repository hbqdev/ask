// PIPELINE ARCHITECTURE — retrieval is a system stage, not a model decision.
//
// This is not a variant of the agentic loop; it replaces the loop's control
// structure. The loop asks the model, at every step, "do I have enough or
// should I search again?" That question is why behaviour is not portable
// across models: on an identical probe set kimi-k2.6 answered it 19 times and
// minimax-m3 answered it 3 times. An architecture whose shape depends on which
// model is selected is not an architecture.
//
// So the model is never asked. The system retrieves, once, on a schedule it
// controls; the model gets one call at the end to write the answer with no
// tools available. Two properties follow, and both are the point:
//
//   * MODEL-AGNOSTIC. Step count is fixed by code. Swapping the model in the
//     UI changes prose quality and speed, never the flow.
//   * BOUNDED. One model round trip instead of 3-11. Measured on this stack a
//     round trip is ~10s and turn latency tracks prompt_tokens at r=0.76, so
//     removing round trips is the single largest lever available.
//
// SPECULATIVE START is the other half. Retrieval is fired on the user's RAW
// text before the classifier has returned — it does not wait to be understood.
// Measured preamble before the old first search: classify ~1.2s, recall ~5.0s
// (concurrent), first token ~7.7s. Starting at t=0 takes that off the critical
// path entirely; by the time understanding lands, sources are already in hand.
//
// The cost is searches we might not have needed. That trade is deliberate: a
// SearXNG query is cheap and parallel, a model round trip is ~10s and serial.
// Spending the cheap resource to save the expensive one is the whole idea.

import {
  createSearchProvider,
  type SearchProviderType
} from '@/lib/tools/search/providers'
import type { SearchResults } from '@/lib/types'

/** How many results the single retrieval pass asks for. */
const PIPELINE_MAX_RESULTS = 20

/**
 * Is the pipeline architecture active? Separate from FLOW_VARIANT because the
 * variants are knobs INSIDE the loop, and this removes the loop. Keeping them
 * on different switches stops "pipeline" from being read as one more arm.
 */
export function pipelineArchEnabled(): boolean {
  return process.env.FLOW_ARCH === 'pipeline'
}

export type PipelineRetrieval = {
  query: string
  results: SearchResults | null
  ms: number
  error?: string
}

/**
 * Fire retrieval immediately, on the raw user text.
 *
 * Deliberately NOT awaited by the caller — the returned promise is handed to
 * the researcher, which awaits it only when it is ready to build the prompt.
 * That is what puts retrieval and understanding on the same clock instead of
 * one behind the other.
 *
 * Never rejects. A failed retrieval must degrade to an unsourced answer, not
 * take the turn down: the old loop could at least try another tool, and this
 * architecture has no second chance by construction.
 */
export function startSpeculativeRetrieval(
  rawQuery: string,
  opts: { timeRange?: 'day' | 'week' | 'month' | 'year' } = {}
): Promise<PipelineRetrieval> {
  const query = rawQuery.trim()
  const startedAt = Date.now()

  if (!query) {
    return Promise.resolve({ query, results: null, ms: 0 })
  }

  const searchAPI = (process.env.SEARCH_API || 'searxng') as SearchProviderType
  return createSearchProvider(searchAPI)
    .search(query, PIPELINE_MAX_RESULTS, 'advanced', [], [], {
      time_range: opts.timeRange
    })
    .then(results => {
      const ms = Date.now() - startedAt
      console.log(
        `[pipeline] speculative retrieval: ${results?.results?.length ?? 0} results in ${ms}ms`
      )
      return { query, results, ms }
    })
    .catch((e: unknown) => {
      const ms = Date.now() - startedAt
      const error = e instanceof Error ? e.message : String(e)
      console.log(
        `[pipeline] speculative retrieval FAILED in ${ms}ms: ${error}`
      )
      return { query, results: null, ms, error }
    })
}

/**
 * Render retrieved sources into the system prompt.
 *
 * Numbered because the citation contract downstream is positional — the model
 * cites what it is shown, and inventing an anchor for a source it was not given
 * is the failure mode worth designing against. Content is truncated per source
 * rather than globally so one long page cannot crowd out the rest; turn latency
 * tracks prompt_tokens closely enough that an unbounded context is a latency
 * bug, not just a cost one.
 */
export function buildSourceBlock(retrieval: PipelineRetrieval): string {
  const rows = retrieval.results?.results ?? []
  if (rows.length === 0) {
    return [
      '## Retrieved sources',
      '',
      'No sources were retrieved for this question.',
      'Answer from your own knowledge, and say plainly that you could not consult sources.',
      'Do NOT invent citations.'
    ].join('\n')
  }

  const PER_SOURCE_CHARS = 1200
  const lines = rows.slice(0, PIPELINE_MAX_RESULTS).map((r, i) => {
    const content = (r.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, PER_SOURCE_CHARS)
    return `[${i + 1}] ${r.title || '(untitled)'}\nURL: ${r.url}\n${content}`
  })

  return [
    '## Retrieved sources',
    '',
    `These ${lines.length} sources were retrieved for this question BEFORE you were called.`,
    'They are all you have — you cannot search, and there is no second pass.',
    'Cite them inline as [1], [2] … matching the numbers below. Never cite a number not listed here.',
    'If they do not answer part of the question, say so in one clause rather than guessing.',
    '',
    lines.join('\n\n')
  ].join('\n')
}
