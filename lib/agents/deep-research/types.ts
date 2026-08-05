// Multi-agent deep research (Onyx-style: plan -> parallel sub-agents ->
// synthesize). Built as an A/B alternative to Ask's current single-agent
// deep-research mode; the two are compared on the lab before either wins.

/** One focused, independently-researchable angle of the user's question. */
export interface ResearchSubtask {
  /** Short human-facing label, shown in the streamed plan. */
  title: string
  /** A self-contained standalone search query for this angle's sub-agent. */
  query: string
  /** Why this angle matters — for the plan UI and to steer the sub-agent. */
  rationale: string
}

/** The decomposition the planner produces from the user's question. */
export interface ResearchPlan {
  subtasks: ResearchSubtask[]
  /** True when planning fell back to a single whole-question angle. */
  degraded: boolean
}
