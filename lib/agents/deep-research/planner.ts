import { generateText, Output } from 'ai'
import { z } from 'zod'

import { getModel } from '../../utils/registry'

import type { ResearchPlan, ResearchSubtask } from './types'

// Decompose a question into a small set of focused, non-overlapping research
// angles. Each angle becomes an independent web-research sub-agent, so the
// decomposition — not "search more times" — is where multi-agent depth comes
// from. This runs on the SAME answering model the user picked (planning quality
// matters), via the shared model registry.

const MIN_SUBTASKS = 1
const MAX_SUBTASKS = 5

const plannerSchema = z.object({
  subtasks: z
    .array(
      z.object({
        title: z.string().min(1),
        query: z.string().min(1),
        rationale: z.string().min(1)
      })
    )
    .min(MIN_SUBTASKS)
    .max(MAX_SUBTASKS)
})

const PLANNER_SYSTEM = `You are the planner for a deep-research system. Given a user's question, break it into a small set of FOCUSED, NON-OVERLAPPING research angles that together comprehensively answer it.

Each angle becomes an independent web-research sub-agent, so each MUST be:
- Self-contained: a standalone search query that does not depend on the others.
- Distinct: two angles should not chase the same sources or restate each other.
- Jointly exhaustive: together the angles must cover everything a thorough, well-rounded answer needs — background, competing views, specifics/numbers, recency, caveats.

Rules:
- Prefer 3-4 angles. Use fewer (even 1) for narrow questions; never more than ${MAX_SUBTASKS}.
- Do NOT create angles that are trivially answerable without research.
- Each 'query' is a real search query, not a restatement of the question.
- 'title' is a short label; 'rationale' is one clause on why the angle matters.`

/**
 * Plan the research: question -> focused, independently-researchable subtasks.
 * Fails OPEN — on any error (or a model that won't produce a valid plan) it
 * returns a single whole-question angle with `degraded: true`, so the caller
 * can still run (and, if it chooses, fall back to single-agent research).
 */
export async function planResearch({
  question,
  modelId,
  abortSignal
}: {
  question: string
  modelId: string
  abortSignal?: AbortSignal
}): Promise<ResearchPlan> {
  const fallback = (): ResearchPlan => ({
    subtasks: [
      {
        title: 'Overall',
        query: question,
        rationale: 'Whole-question research (planner unavailable).'
      }
    ],
    degraded: true
  })

  const q = question.trim()
  if (!q) return fallback()

  try {
    const { output } = await generateText({
      model: getModel(modelId, abortSignal),
      system: PLANNER_SYSTEM,
      prompt: `Question: "${q}"`,
      temperature: 0,
      abortSignal,
      output: Output.object({ schema: plannerSchema })
    })

    const subtasks: ResearchSubtask[] = (output?.subtasks ?? [])
      .map(s => ({
        title: s.title.trim(),
        query: s.query.trim(),
        rationale: s.rationale.trim()
      }))
      .filter(s => s.query.length > 0)
      .slice(0, MAX_SUBTASKS)

    if (subtasks.length === 0) return fallback()
    return { subtasks, degraded: false }
  } catch {
    return fallback()
  }
}
