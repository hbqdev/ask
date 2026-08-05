import type { Model } from '../../types/models'
import type { SearchMode, SearchSources } from '../../types/search'
import { mapWithConcurrency } from '../../utils/map-with-concurrency'

import { planResearch } from './planner'
import { runSubAgent, type SubAgentResult } from './sub-agent'
import type { ResearchPlan } from './types'

// Sub-agents are full researcher runs (each crawls + reranks), so N of them in
// parallel is the real cost of multi-agent depth. Cap concurrency to keep the
// crawler and the model host from thrashing; failed angles are dropped, not
// fatal.
const SUBAGENT_CONCURRENCY = 3

export interface DeepResearchRunResult {
  plan: ResearchPlan
  /** Successful sub-agent reports; failed angles are omitted. */
  subResults: SubAgentResult[]
}

/**
 * Orchestrate multi-agent deep research: decompose the question, run the angles
 * as parallel sub-researchers, and collect their reports. Synthesis into a
 * single cited answer is a later slice; this returns the raw material.
 */
export async function runDeepResearch({
  question,
  modelId,
  modelConfig,
  sources = ['web'],
  subSearchMode,
  abortSignal,
  onPlan
}: {
  question: string
  modelId: string
  modelConfig?: Model
  sources?: SearchSources
  subSearchMode?: SearchMode
  abortSignal?: AbortSignal
  /** Called once the plan is ready — for streaming it to the UI. */
  onPlan?: (plan: ResearchPlan) => void
}): Promise<DeepResearchRunResult> {
  const plan = await planResearch({ question, modelId, abortSignal })
  onPlan?.(plan)

  const settled = await mapWithConcurrency(
    plan.subtasks,
    SUBAGENT_CONCURRENCY,
    subtask =>
      runSubAgent({
        subtask,
        modelId,
        modelConfig,
        sources,
        subSearchMode,
        abortSignal
      })
  )

  const subResults = settled.filter(
    (r): r is SubAgentResult => !(r instanceof Error)
  )

  return { plan, subResults }
}
