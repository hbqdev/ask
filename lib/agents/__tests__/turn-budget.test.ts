import { describe, expect, it } from 'vitest'

import {
  ANSWER_DEADLINE_MS,
  ANSWER_NOW_DIRECTIVE,
  GENERATION_TIMEOUT_MS,
  retrievalBudgetSpent
} from '../turn-budget'

describe('turn budget', () => {
  it('leaves real time to write after retrieval stops', () => {
    // The invariant that matters. If the deadline creeps up against the hard
    // abort, the loop stops retrieving but still gets killed before it can
    // finish a sentence — which is the exact failure this module exists to
    // prevent, just moved later.
    const writingWindow = GENERATION_TIMEOUT_MS - ANSWER_DEADLINE_MS
    expect(writingWindow).toBeGreaterThanOrEqual(60_000)
  })

  it('fires strictly before the hard abort', () => {
    expect(ANSWER_DEADLINE_MS).toBeLessThan(GENERATION_TIMEOUT_MS)
  })

  it('is not spent at the start of a turn', () => {
    const t0 = 1_000_000
    expect(retrievalBudgetSpent(t0, t0)).toBe(false)
  })

  it('is not spent one millisecond before the deadline', () => {
    const t0 = 1_000_000
    expect(retrievalBudgetSpent(t0, t0 + ANSWER_DEADLINE_MS - 1)).toBe(false)
  })

  it('is spent exactly at the deadline', () => {
    const t0 = 1_000_000
    expect(retrievalBudgetSpent(t0, t0 + ANSWER_DEADLINE_MS)).toBe(true)
  })

  it('stays spent afterwards — it must never flip back mid-turn', () => {
    const t0 = 1_000_000
    expect(retrievalBudgetSpent(t0, t0 + GENERATION_TIMEOUT_MS * 2)).toBe(true)
  })

  it('tells the model to answer rather than only forbidding tools', () => {
    // A model told just "no tools" tends to apologise for being unable to
    // search instead of answering from what it already retrieved.
    expect(ANSWER_NOW_DIRECTIVE).toMatch(/answer/i)
    expect(ANSWER_NOW_DIRECTIVE).toMatch(/do not call any further tools/i)
  })
})
