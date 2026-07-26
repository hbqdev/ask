import { afterEach, describe, expect, it } from 'vitest'

import { passagesPerDocForBudget } from '../passage-budget'

afterEach(() => {
  delete process.env.RERANK_PASSAGE_BUDGET
})

// Relaxing the quality gate took usable docs from 18 to 50, which took the
// cross-encoder from 195 passages (8.3s) to 499 (20.0s) — exactly its 20s
// timeout. The call failed and the turn silently degraded to the weaker
// bi-encoder. Measured cost is linear at ~40ms/passage, so a TOTAL passage
// budget bounds rerank time predictably.
//
// Critically this trims passages PER DOC, never the doc list: every document
// keeps at least one passage, so it still gets a score and can still be
// returned. Sources are preserved; only the depth of evidence per source is
// reduced, and only when there are many of them.
describe('passagesPerDocForBudget', () => {
  it('leaves the per-doc cap alone when few docs make the budget irrelevant', () => {
    // 18 docs x 12 = 216 passages, comfortably inside the budget.
    expect(passagesPerDocForBudget(18, 12)).toBe(12)
  })

  it('trims per-doc depth when many docs would blow the budget', () => {
    // 50 docs against a 320 budget -> 6 each = 300 passages ~ 12s.
    expect(passagesPerDocForBudget(50, 12)).toBe(6)
  })

  it('never returns zero — every doc must stay scoreable', () => {
    // 500 docs would mathematically warrant 0; that would silently drop
    // sources, which is the one thing this must not do.
    expect(passagesPerDocForBudget(500, 12)).toBe(1)
  })

  it('never exceeds the per-doc maximum', () => {
    expect(passagesPerDocForBudget(1, 12)).toBe(12)
  })

  it('honours an explicit budget override', () => {
    process.env.RERANK_PASSAGE_BUDGET = '100'
    expect(passagesPerDocForBudget(50, 12)).toBe(2)
  })

  it('falls back to the default budget when the override is nonsense', () => {
    process.env.RERANK_PASSAGE_BUDGET = 'lots'
    expect(passagesPerDocForBudget(50, 12)).toBe(6)
  })

  it('handles zero docs without dividing by zero', () => {
    expect(passagesPerDocForBudget(0, 12)).toBe(12)
  })
})
