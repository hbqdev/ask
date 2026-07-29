import { describe, expect, it } from 'vitest'

import {
  ANSWER_DEADLINE_MS,
  ANSWER_NOW_NOTE,
  applyAnswerDeadline
} from '../answer-deadline'

const SYS = 'BASE PROMPT WITH CITATION RULES'

// Measured on 80 balanced-mode turns: two ran to route.ts's 300s ceiling at
// 17-18 steps and persisted NOTHING, and four more landed between 245s and
// 276s. maxSteps is a step budget with no awareness of the clock, so a turn
// that searches 17 times runs out of wall time long before it runs out of
// steps — and the route's abort saves nothing at all.
describe('applyAnswerDeadline', () => {
  it('leaves a turn alone while it still has time', () => {
    expect(
      applyAnswerDeadline({}, { elapsedMs: 30_000, systemPrompt: SYS })
    ).toEqual({})
    expect(
      applyAnswerDeadline(
        {},
        { elapsedMs: ANSWER_DEADLINE_MS - 1, systemPrompt: SYS }
      )
    ).toEqual({})
  })

  it('removes the tools once the deadline passes', () => {
    const out = applyAnswerDeadline<{ activeTools?: string[] }>(
      {},
      { elapsedMs: ANSWER_DEADLINE_MS, systemPrompt: SYS }
    )
    expect(out.activeTools).toEqual([])
  })

  it('tells the model to answer rather than only taking the tools away', () => {
    // Removing tools silently is not enough — a model prevented from calling a
    // tool will spend the step reasoning about retrying and emit no prose. It
    // does not infer that it should now answer.
    const out = applyAnswerDeadline<{ system?: string }>(
      {},
      { elapsedMs: ANSWER_DEADLINE_MS + 1, systemPrompt: SYS }
    )
    expect(out.system).toContain('TIME TO ANSWER')
    expect(out.system).toMatch(/do NOT propose further searches/i)
  })

  it('keeps the whole prompt, because `system` replaces rather than appends', () => {
    // Sending only the note would discard every prompt rule with it, including
    // the citation contract — the answer would lose its attribution on the very
    // step that writes it.
    const out = applyAnswerDeadline<{ system?: string }>(
      {},
      { elapsedMs: ANSWER_DEADLINE_MS, systemPrompt: SYS }
    )
    expect(out.system?.startsWith(SYS)).toBe(true)
    expect(out.system).toBe(`${SYS}${ANSWER_NOW_NOTE}`)
  })

  it('overrides a variant that would hand tools back', () => {
    // Applied last: which tools are visible mid-loop is a variant's
    // preference, having a step left to answer in is not. A variant that
    // replaced the prompt keeps its replacement.
    const out = applyAnswerDeadline(
      { activeTools: ['search', 'fetch'], system: 'variant prompt' },
      { elapsedMs: ANSWER_DEADLINE_MS, systemPrompt: SYS }
    )
    expect(out.activeTools).toEqual([])
    expect(out.system?.startsWith('variant prompt')).toBe(true)
    expect(out.system).not.toContain(SYS)
  })

  it('leaves real time to write in', () => {
    // route.ts aborts the whole turn at GENERATION_TIMEOUT_MS (300s). A
    // deadline near that ceiling would be no deadline at all: the reserve only
    // helps if the answer can actually finish streaming afterwards.
    expect(ANSWER_DEADLINE_MS).toBeLessThanOrEqual(300_000 - 90_000)
  })

  it('does not fire before a legitimate multi-search turn can finish', () => {
    // Turns that DID answer ran up to 276s with 9-17 steps. The deadline must
    // sit above ordinary research, or it truncates good turns to prevent a rare
    // bad one. Asserted as a floor so tightening it has to confront that.
    expect(ANSWER_DEADLINE_MS).toBeGreaterThan(120_000)
  })

  it('is a pure function of elapsed time, not of a hidden clock', () => {
    // The same inputs must always give the same answer — the researcher passes
    // Date.now() - turnStartedAt, and nothing here reads a clock of its own.
    const a = applyAnswerDeadline({}, { elapsedMs: 250_000, systemPrompt: SYS })
    const b = applyAnswerDeadline({}, { elapsedMs: 250_000, systemPrompt: SYS })
    expect(a).toEqual(b)
  })
})
