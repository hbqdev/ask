// Shared types for the deep-research A/B harness. Mirrors the
// folder-with-a-types.ts convention of lib/agents/deep-research/.
//
// The harness compares two deep-research MODES on the same question:
//   'single' — Ask's CURRENT single-agent deep research (>=15 searches + a
//              todo list + one report).
//   'multi'  — the NEW multi-agent orchestrator in lib/agents/deep-research
//              (planner -> parallel sub-agents -> synthesize).
// It never invokes either mode itself; the lead injects that (see
// InvokeDeepResearch) so the SAME judging/aggregation runs over both.

/** Which deep-research mode produced an answer. */
export type DeepResearchMode = 'single' | 'multi'

/** One mode's final output for a question: the answer plus the sources it cited. */
export interface DeepResearchAnswer {
  answer: string
  sources: { title: string; url: string }[]
}

/**
 * The single seam the lead wires to run the harness for real. Given a question
 * and a mode, produce that mode's final answer + cited sources. It must NOT
 * throw for a normal empty/failed research run — return an empty answer and let
 * the runner record it; throwing is reserved for "this mode could not run at
 * all", which the runner catches and records as an error.
 */
export type InvokeDeepResearch = (
  question: string,
  mode: DeepResearchMode
) => Promise<DeepResearchAnswer>

/** The four quality dimensions the judge scores, 1-5 each. */
export interface DimensionScores {
  /** Beyond a surface summary: mechanisms, trade-offs, second-order effects. */
  depth: number
  /** Breadth — every sub-part and competing angle the question asks for. */
  coverage: number
  /** Concreteness — named entities, numbers, dates, quantified trade-offs. */
  specificity: number
  /** Sources relevant/credible/varied and claims actually grounded in them. */
  citationQuality: number
}

/**
 * Which mode was shown at each blind position for one judging. The judge only
 * ever sees "Answer A"/"Answer B"; this records the random mapping so the
 * verdict can be de-randomized back into mode space. See judge.ts.
 */
export interface AbAssignment {
  A: DeepResearchMode
  B: DeepResearchMode
}

/** A de-randomized verdict: already remapped from A/B positions into modes. */
export interface JudgeVerdict {
  /** The mode judged better overall, or 'tie'. */
  winner: DeepResearchMode | 'tie'
  /** Per-dimension scores for each mode. */
  scores: Record<DeepResearchMode, DimensionScores>
  /** One-paragraph justification from the judge. */
  rationale: string
  /** The blind ordering used, kept for auditability. */
  assignment: AbAssignment
  /** True when the structured-output call failed and the JSON fallback parsed. */
  fallbackParsed?: boolean
}

/** A judging that could not produce a verdict (model/parse failure). */
export interface JudgeError {
  error: string
  assignment: AbAssignment
}

/** One question's full A/B record — one line per question in the JSONL output. */
export interface AbRecord {
  questionId: string
  question: string
  domain: string
  single: DeepResearchAnswer | { error: string }
  multi: DeepResearchAnswer | { error: string }
  /** null when one side failed to run and judging was skipped. */
  verdict: JudgeVerdict | JudgeError | null
  recordedAt: string
}
