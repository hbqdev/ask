import { describe, expect, test } from 'vitest'

import { aggregate } from '../aggregate'
import {
  derandomizeScores,
  derandomizeWinner,
  parseJudgeJson
} from '../judge'
import type {
  AbAssignment,
  DimensionScores,
  JudgeVerdict
} from '../types'

const dims = (
  depth: number,
  coverage: number,
  specificity: number,
  citationQuality: number
): DimensionScores => ({ depth, coverage, specificity, citationQuality })

const verdict = (
  winner: JudgeVerdict['winner'],
  single: DimensionScores,
  multi: DimensionScores
): JudgeVerdict => ({
  winner,
  scores: { single, multi },
  rationale: 'r',
  assignment: { A: 'single', B: 'multi' }
})

describe('derandomizeWinner', () => {
  test('maps position A/B to the mode shown there', () => {
    const asg: AbAssignment = { A: 'multi', B: 'single' }
    expect(derandomizeWinner('A', asg)).toBe('multi')
    expect(derandomizeWinner('B', asg)).toBe('single')
  })

  test('maps the mirrored assignment the other way', () => {
    const asg: AbAssignment = { A: 'single', B: 'multi' }
    expect(derandomizeWinner('A', asg)).toBe('single')
    expect(derandomizeWinner('B', asg)).toBe('multi')
  })

  test('passes a tie through unchanged', () => {
    expect(derandomizeWinner('tie', { A: 'multi', B: 'single' })).toBe('tie')
  })
})

describe('derandomizeScores', () => {
  test('routes position scores to the mode that occupied that position', () => {
    const raw = {
      answerA: dims(5, 4, 5, 3),
      answerB: dims(2, 2, 1, 2),
      winner: 'A' as const,
      rationale: 'r'
    }
    // multi was shown at A, single at B — scores must follow the modes.
    const out = derandomizeScores(raw, { A: 'multi', B: 'single' })
    expect(out.multi).toEqual(dims(5, 4, 5, 3))
    expect(out.single).toEqual(dims(2, 2, 1, 2))
  })
})

describe('parseJudgeJson', () => {
  test('parses and validates a clean JSON verdict', () => {
    const text =
      '{"answerA":{"depth":5,"coverage":4,"specificity":5,"citationQuality":4},' +
      '"answerB":{"depth":2,"coverage":3,"specificity":2,"citationQuality":2},' +
      '"winner":"A","rationale":"A goes deeper"}'
    const parsed = parseJudgeJson(text)
    expect(parsed?.winner).toBe('A')
    expect(parsed?.answerA.depth).toBe(5)
  })

  test('extracts the JSON object from surrounding prose/code fences', () => {
    const text =
      'Here is my verdict:\n```json\n' +
      '{"answerA":{"depth":3,"coverage":3,"specificity":3,"citationQuality":3},' +
      '"answerB":{"depth":3,"coverage":3,"specificity":3,"citationQuality":3},' +
      '"winner":"tie","rationale":"comparable"}\n```\n'
    expect(parseJudgeJson(text)?.winner).toBe('tie')
  })

  test('returns null for out-of-range scores or missing fields', () => {
    expect(
      parseJudgeJson(
        '{"answerA":{"depth":7,"coverage":3,"specificity":3,"citationQuality":3},' +
          '"answerB":{"depth":3,"coverage":3,"specificity":3,"citationQuality":3},' +
          '"winner":"A","rationale":"x"}'
      )
    ).toBeNull()
    expect(parseJudgeJson('no json here')).toBeNull()
  })
})

describe('aggregate', () => {
  test('counts wins/ties, computes rates, and averages per-dimension scores', () => {
    const verdicts = [
      verdict('multi', dims(2, 2, 2, 2), dims(4, 4, 4, 4)),
      verdict('multi', dims(3, 3, 3, 3), dims(5, 5, 5, 5)),
      verdict('single', dims(4, 4, 4, 4), dims(2, 2, 2, 2)),
      verdict('tie', dims(3, 3, 3, 3), dims(3, 3, 3, 3))
    ]
    const agg = aggregate(verdicts)

    expect(agg.total).toBe(4)
    expect(agg.judged).toBe(4)
    expect(agg.multiWins).toBe(2)
    expect(agg.singleWins).toBe(1)
    expect(agg.ties).toBe(1)
    expect(agg.multiWinRate).toBe(50)
    expect(agg.singleWinRate).toBe(25)
    expect(agg.tieRate).toBe(25)
    // multi depth mean = (4+5+2+3)/4 = 3.5
    expect(agg.avgScores?.multi.depth).toBeCloseTo(3.5)
    // single depth mean = (2+3+4+3)/4 = 3.0
    expect(agg.avgScores?.single.depth).toBeCloseTo(3.0)
  })

  test('counts errored and skipped verdicts but excludes them from rates/averages', () => {
    const agg = aggregate([
      verdict('multi', dims(4, 4, 4, 4), dims(5, 5, 5, 5)),
      { error: 'boom', assignment: { A: 'single', B: 'multi' } },
      null
    ])
    expect(agg.total).toBe(3)
    expect(agg.judged).toBe(1)
    expect(agg.errored).toBe(1)
    expect(agg.skipped).toBe(1)
    expect(agg.multiWins).toBe(1)
    expect(agg.multiWinRate).toBe(100)
    expect(agg.avgScores?.multi.depth).toBe(5)
  })

  test('returns null rates and null avgScores when nothing was judged', () => {
    const agg = aggregate([null, { error: 'x', assignment: { A: 'multi', B: 'single' } }])
    expect(agg.judged).toBe(0)
    expect(agg.multiWinRate).toBeNull()
    expect(agg.avgScores).toBeNull()
  })
})
