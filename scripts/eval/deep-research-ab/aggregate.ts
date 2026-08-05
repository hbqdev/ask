import type {
  DeepResearchMode,
  DimensionScores,
  JudgeError,
  JudgeVerdict
} from './types'

// Pure aggregation over the per-question verdicts. Kept side-effect-free and in
// its own module so the runner's live entrypoint doesn't run when a test
// imports this. Errored and skipped (null) verdicts are counted but excluded
// from win-rate and score averages — never guessed, never silently dropped,
// matching scripts/eval/run-eval.ts.

export interface AbAggregate {
  /** Total verdict slots, including skipped and errored. */
  total: number
  /** Verdicts that produced a decision (the denominator for rates/averages). */
  judged: number
  /** Judgings that failed (model/parse error). */
  errored: number
  /** Questions where a mode failed to run, so judging was skipped. */
  skipped: number
  multiWins: number
  singleWins: number
  ties: number
  /** Percentages over `judged`; null when nothing was judged. */
  multiWinRate: number | null
  singleWinRate: number | null
  tieRate: number | null
  /** Mean per-dimension score for each mode over `judged`; null when none. */
  avgScores: Record<DeepResearchMode, DimensionScores> | null
}

function isVerdict(
  v: JudgeVerdict | JudgeError | null
): v is JudgeVerdict {
  return v !== null && 'winner' in v
}

function meanDimensions(scores: DimensionScores[]): DimensionScores {
  const n = scores.length
  const sum = (key: keyof DimensionScores): number =>
    scores.reduce((acc, s) => acc + s[key], 0)
  return {
    depth: sum('depth') / n,
    coverage: sum('coverage') / n,
    specificity: sum('specificity') / n,
    citationQuality: sum('citationQuality') / n
  }
}

export function aggregate(
  verdicts: (JudgeVerdict | JudgeError | null)[]
): AbAggregate {
  const skipped = verdicts.filter(v => v === null).length
  const errored = verdicts.filter(v => v !== null && 'error' in v).length
  const decided = verdicts.filter(isVerdict)
  const judged = decided.length

  const multiWins = decided.filter(v => v.winner === 'multi').length
  const singleWins = decided.filter(v => v.winner === 'single').length
  const ties = decided.filter(v => v.winner === 'tie').length

  const rate = (n: number): number | null =>
    judged > 0 ? (n / judged) * 100 : null

  const avgScores =
    judged > 0
      ? {
          single: meanDimensions(decided.map(v => v.scores.single)),
          multi: meanDimensions(decided.map(v => v.scores.multi))
        }
      : null

  return {
    total: verdicts.length,
    judged,
    errored,
    skipped,
    multiWins,
    singleWins,
    ties,
    multiWinRate: rate(multiWins),
    singleWinRate: rate(singleWins),
    tieRate: rate(ties),
    avgScores
  }
}
