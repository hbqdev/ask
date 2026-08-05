import type { SearchResultItem } from '../../types'
import type { Model } from '../../types/models'
import type { SearchSources } from '../../types/search'

import { runDeepResearch } from './orchestrator'
import { runResearcherCollected, type SubAgentResult } from './sub-agent'
import { type SynthesisResult,synthesizeReport } from './synthesize'
import type { ResearchPlan } from './types'

export type { SubAgentResult } from './sub-agent'
export type { ResearchPlan, ResearchSubtask } from './types'

export interface DeepResearchAnswer extends SynthesisResult {
  plan: ResearchPlan
}

interface CommonOpts {
  question: string
  modelId: string
  modelConfig?: Model
  sources?: SearchSources
  abortSignal?: AbortSignal
}

/**
 * Multi-agent deep research (the new arm): decompose the question, research each
 * angle with a parallel sub-agent, then synthesize one cited report.
 */
export async function runMultiAgentDeepResearch({
  question,
  modelId,
  modelConfig,
  sources = ['web'],
  abortSignal,
  onPlan
}: CommonOpts & {
  onPlan?: (plan: ResearchPlan) => void
}): Promise<DeepResearchAnswer> {
  const { plan, subResults }: { plan: ResearchPlan; subResults: SubAgentResult[] } =
    await runDeepResearch({
      question,
      modelId,
      modelConfig,
      sources,
      abortSignal,
      onPlan
    })
  const synth = await synthesizeReport({
    question,
    subResults,
    modelId,
    abortSignal
  })
  return { ...synth, plan }
}

/**
 * Single-agent deep research (the baseline arm): today's production behavior —
 * one researcher run at deep-research depth. Returns the same shape as the
 * multi-agent arm so an A/B harness can compare them apples-to-apples.
 */
export async function runSingleAgentDeepResearch({
  question,
  modelId,
  modelConfig,
  sources = ['web'],
  abortSignal
}: CommonOpts): Promise<{
  report: string
  sources: SearchResultItem[]
}> {
  const collected = await runResearcherCollected({
    query: question,
    modelId,
    modelConfig,
    // 'quality' is Ask's deep-research protocol (search-mode-prompts.ts:442) —
    // exactly what production runs today when a user picks deep research.
    searchMode: 'quality',
    sources,
    abortSignal
  })

  // Flatten the per-tool-call citation maps into one deduped source list.
  const seen = new Set<string>()
  const flat: SearchResultItem[] = []
  for (const map of Object.values(collected.citationMaps)) {
    for (const source of Object.values(map)) {
      if (source?.url && !seen.has(source.url)) {
        seen.add(source.url)
        flat.push(source)
      }
    }
  }

  return { report: collected.report, sources: flat }
}
