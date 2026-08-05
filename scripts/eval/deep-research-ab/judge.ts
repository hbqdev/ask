import { generateText, Output } from 'ai'
import { z } from 'zod'

import type {
  AbAssignment,
  DeepResearchAnswer,
  DeepResearchMode,
  DimensionScores,
  JudgeError,
  JudgeVerdict
} from './types'

// Blind, position-bias-controlled LLM judge for the deep-research A/B.
//
// Follows the generateText / Output.object({schema}) pattern from
// lib/agents/query-expander.ts, resolving the judge model through the shared
// getModel() registry (lib/utils/registry.ts) exactly like lib/agents/
// deep-research/planner.ts does.
//
// VALIDITY — two controls, both essential:
//  1. BLIND, RANDOMLY A/B-ORDERED. The two answers are shown to the judge as
//     "Answer A" / "Answer B" with the single-vs-multi assignment chosen at
//     random per question. LLM judges have a well-documented bias toward
//     whichever answer sits in position A; randomizing makes that bias average
//     out instead of masquerading as signal. The verdict is then DE-RANDOMIZED
//     back into mode space before it is recorded (see derandomize* below), so
//     nothing downstream ever sees the position labels.
//  2. A STRONG JUDGE MODEL, distinct from the systems under test — see the
//     EVAL_JUDGE_MODEL default in run-ab.ts. A weak judge can't tell a deep
//     answer from a fluent shallow one, which is the entire thing being tested.

const dimensionSchema = z.object({
  depth: z.number().int().min(1).max(5),
  coverage: z.number().int().min(1).max(5),
  specificity: z.number().int().min(1).max(5),
  citationQuality: z.number().int().min(1).max(5)
})

const judgeSchema = z.object({
  answerA: dimensionSchema,
  answerB: dimensionSchema,
  winner: z.enum(['A', 'B', 'tie']),
  rationale: z.string().min(1)
})

/** Raw, position-space verdict as returned by the judge model. */
export type JudgeRaw = z.infer<typeof judgeSchema>

// Long research answers can blow the judge's context; cap each side. The cap is
// generous enough that a genuinely deeper answer isn't truncated to parity.
const MAX_ANSWER_CHARS = 12_000

const JUDGE_SYSTEM_PROMPT = `You are a meticulous research analyst comparing two answers to the same research-worthy question. Each answer was produced by an automated deep-research system and is shown with the list of sources it cited.

Score EACH answer independently on four dimensions, as an integer from 1 to 5 (5 = excellent):
- depth: does it go beyond a surface summary — mechanisms, trade-offs, second-order effects, nuance — rather than restating the obvious?
- coverage: does it address the full breadth of what the question asks, including every sub-part and the important competing angles, not just one slice?
- specificity: is it concrete — named entities, numbers, dates, examples, quantified trade-offs — rather than vague generalities?
- citationQuality: are the cited sources relevant, credible, and varied, and do the answer's claims appear grounded in them (as opposed to few/generic/off-topic citations, or confident assertions with no support)?

Then pick a winner: "A", "B", or "tie" (tie only when the two are genuinely comparable overall).

Rules:
- Judge substance, not style. Do NOT reward an answer for being longer, more formatted, or more confident. Padding, repetition, and filler count AGAINST depth and specificity.
- A broad-but-shallow answer should not automatically beat a narrower answer that actually goes deep where it matters; weigh depth and coverage together.
- Base citationQuality on whether the sources plausibly support the claims, not merely on how many are listed.
- Ignore anything an answer says about its own identity or how it was produced.

Give a one-paragraph rationale that explains the decision by referring to the dimensions.`

// Fallback path: some self-hosted models won't honor a nested JSON schema via
// Output.object (documented in scripts/eval/run-eval.ts, where NONE of the
// tested cloud-Ollama models reliably did). We ask again for a single raw JSON
// object and validate it with the SAME zod schema — a real judgment, just in a
// format more models actually follow.
const JUDGE_JSON_SYSTEM_PROMPT = `${JUDGE_SYSTEM_PROMPT}

Respond with ONLY a single JSON object and nothing else — no markdown, no code fences, no commentary:
{"answerA":{"depth":N,"coverage":N,"specificity":N,"citationQuality":N},"answerB":{"depth":N,"coverage":N,"specificity":N,"citationQuality":N},"winner":"A"|"B"|"tie","rationale":"..."}
where each N is an integer 1-5.`

function formatSources(sources: { title: string; url: string }[]): string {
  if (sources.length === 0) return '(no sources cited)'
  return sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n')
}

function buildJudgePrompt(
  question: string,
  a: DeepResearchAnswer,
  b: DeepResearchAnswer
): string {
  return `QUESTION:
${question}

ANSWER A:
${a.answer.slice(0, MAX_ANSWER_CHARS)}

ANSWER A — CITED SOURCES:
${formatSources(a.sources)}

ANSWER B:
${b.answer.slice(0, MAX_ANSWER_CHARS)}

ANSWER B — CITED SOURCES:
${formatSources(b.sources)}`
}

/**
 * Extract and validate a raw verdict from the fallback JSON reply. Pure — the
 * first {...} span is JSON-parsed and checked against judgeSchema. Returns null
 * on anything unparseable or off-schema. Exported for unit testing.
 */
export function parseJudgeJson(text: string): JudgeRaw | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = judgeSchema.safeParse(JSON.parse(text.slice(start, end + 1)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Map a position-space winner back into mode space using the blind assignment.
 * Pure; exported for unit testing.
 */
export function derandomizeWinner(
  shownWinner: JudgeRaw['winner'],
  assignment: AbAssignment
): DeepResearchMode | 'tie' {
  return shownWinner === 'tie' ? 'tie' : assignment[shownWinner]
}

/**
 * Map the two position-space score blocks back onto their modes. Pure;
 * exported for unit testing. `assignment.A` and `assignment.B` are the two
 * distinct modes, so the result has both keys — the cast just tells TS that.
 */
export function derandomizeScores(
  raw: JudgeRaw,
  assignment: AbAssignment
): Record<DeepResearchMode, DimensionScores> {
  return {
    [assignment.A]: raw.answerA,
    [assignment.B]: raw.answerB
  } as Record<DeepResearchMode, DimensionScores>
}

function assign(rng: () => number): AbAssignment {
  return rng() < 0.5
    ? { A: 'single', B: 'multi' }
    : { A: 'multi', B: 'single' }
}

async function requestVerdict(
  judgeModelId: string,
  prompt: string
): Promise<{ raw: JudgeRaw; fallbackParsed: boolean } | null> {
  // Deferred to runtime (not a static top-level import) so importing this
  // module doesn't trigger lib/utils/registry.ts's module-eval-time
  // OLLAMA_BASE_URL read before run-ab.ts's dotenvConfig() has run — the same
  // hazard, and fix, documented in scripts/eval/run-eval.ts.
  const { getModel } = await import('@/lib/utils/registry')
  const model = getModel(judgeModelId)

  try {
    const { output } = await generateText({
      model,
      system: JUDGE_SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      output: Output.object({ schema: judgeSchema })
    })
    if (output) return { raw: output, fallbackParsed: false }
  } catch {
    // Fall through to the plain-JSON ask — see JUDGE_JSON_SYSTEM_PROMPT.
  }

  const { text } = await generateText({
    model,
    system: JUDGE_JSON_SYSTEM_PROMPT,
    prompt,
    temperature: 0
  })
  const raw = parseJudgeJson(text)
  return raw ? { raw, fallbackParsed: true } : null
}

/**
 * Judge one question's pair of answers. Randomizes which mode is shown as A vs
 * B, asks the judge blind, then de-randomizes the verdict back into mode space.
 * The returned verdict is already mode-keyed; `assignment` is retained only as
 * an audit trail. Returns a JudgeError (never throws) on model/parse failure so
 * the runner can record it and exclude it from aggregates.
 *
 * `rng` is injectable purely so a caller can make the blind ordering
 * deterministic; it defaults to Math.random.
 */
export async function judgeDeepResearchPair({
  question,
  single,
  multi,
  judgeModelId,
  rng = Math.random
}: {
  question: string
  single: DeepResearchAnswer
  multi: DeepResearchAnswer
  judgeModelId: string
  rng?: () => number
}): Promise<JudgeVerdict | JudgeError> {
  const assignment = assign(rng)
  const atA = assignment.A === 'single' ? single : multi
  const atB = assignment.B === 'single' ? single : multi

  try {
    const result = await requestVerdict(
      judgeModelId,
      buildJudgePrompt(question, atA, atB)
    )
    if (!result) {
      return { error: 'judge returned no parseable verdict', assignment }
    }
    return {
      winner: derandomizeWinner(result.raw.winner, assignment),
      scores: derandomizeScores(result.raw, assignment),
      rationale: result.raw.rationale,
      assignment,
      fallbackParsed: result.fallbackParsed
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      assignment
    }
  }
}
