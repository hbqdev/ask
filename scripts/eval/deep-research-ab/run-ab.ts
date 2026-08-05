#!/usr/bin/env bun
/**
 * A/B runner: does the NEW multi-agent deep-research mode produce genuinely
 * DEEPER answers than the CURRENT single-agent mode?
 *
 * For each curated question it runs BOTH modes, has a blind, position-bias-
 * controlled LLM judge score them on depth / coverage / specificity / citation
 * quality (see judge.ts), and records the de-randomized verdict. It then prints
 * a summary — multi-vs-single win rate and average per-dimension scores — and
 * writes one JSONL line per question to scripts/eval/results/.
 *
 * This runner does NOT know how to invoke either mode. That is the one seam the
 * lead wires: replace the `invokeDeepResearch` stub below. Until then, running
 * this records a run-error per question (it will not crash) and the summary
 * shows nothing judged.
 *
 * Usage (once invokeDeepResearch is implemented):
 *   bun run scripts/eval/deep-research-ab/run-ab.ts
 *   bun run scripts/eval/deep-research-ab/run-ab.ts --limit 3
 *   bun run scripts/eval/deep-research-ab/run-ab.ts --out my-run.jsonl
 *   EVAL_JUDGE_MODEL=ollama:glm-5.2:cloud bun run scripts/eval/deep-research-ab/run-ab.ts
 */
import { config as dotenvConfig } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Load real config before anything imports lib/utils/registry.ts (which reads
// OLLAMA_BASE_URL at module-eval time). override:true so this wins over any
// ambient env — same rationale as scripts/eval/run-eval.ts.
dotenvConfig({ path: '.env', override: true })

import { aggregate, type AbAggregate } from './aggregate'
import { judgeDeepResearchPair } from './judge'
import { DEEP_RESEARCH_QUESTIONS, type DeepResearchQuestion } from './questions'
import type {
  AbRecord,
  DeepResearchAnswer,
  InvokeDeepResearch
} from './types'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = path.join(SCRIPT_DIR, '..', 'results')

// Strong judge, distinct from the systems under test. Shares the env var and
// default with scripts/eval/run-eval.ts so an already-configured lab picks it
// up unchanged; override per run with EVAL_JUDGE_MODEL.
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || 'ollama:qwen3.5:397b:cloud'

// ---------------------------------------------------------------------------
// THE ONE INTERFACE THE LEAD MUST IMPLEMENT.
//
// Wire this to run each deep-research mode for real and return its final answer
// text plus the sources it cited:
//   mode 'single' -> Ask's CURRENT single-agent deep research
//                    (>=15 searches + a todo list + one report).
//   mode 'multi'  -> the NEW orchestrator: lib/agents/deep-research
//                    runDeepResearch(...) followed by synthesis into one cited
//                    answer.
// Keep both arms on the SAME answering model and sources so the only variable
// is single-vs-multi. Return an empty answer (do NOT throw) for a normal empty
// research run; throw only when a mode cannot run at all.
// ---------------------------------------------------------------------------
export const invokeDeepResearch: InvokeDeepResearch = async (
  _question,
  _mode
) => {
  throw new Error(
    'invokeDeepResearch is not implemented — wire it (see ' +
      'scripts/eval/deep-research-ab/README.md) before running the A/B.'
  )
}

interface RunOptions {
  limit: number
  outName?: string
}

function parseArgs(argv: string[]): RunOptions {
  let limit = DEEP_RESEARCH_QUESTIONS.length
  let outName: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit') limit = Number(argv[++i])
    else if (argv[i] === '--out') outName = argv[++i]
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    limit = DEEP_RESEARCH_QUESTIONS.length
  }
  return { limit, outName }
}

async function settle(
  p: Promise<DeepResearchAnswer>
): Promise<DeepResearchAnswer | { error: string }> {
  try {
    return await p
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function runQuestion(
  question: DeepResearchQuestion,
  invoke: InvokeDeepResearch
): Promise<AbRecord> {
  // Run the two modes; a thrown mode is recorded as an error, not fatal.
  const single = await settle(invoke(question.text, 'single'))
  const multi = await settle(invoke(question.text, 'multi'))

  let verdict: AbRecord['verdict'] = null
  if (!('error' in single) && !('error' in multi)) {
    verdict = await judgeDeepResearchPair({
      question: question.text,
      single,
      multi,
      judgeModelId: JUDGE_MODEL
    })
  }

  return {
    questionId: question.id,
    question: question.text,
    domain: question.domain,
    single,
    multi,
    verdict,
    recordedAt: new Date().toISOString()
  }
}

function verdictLabel(verdict: AbRecord['verdict']): string {
  if (verdict === null) return 'skipped (a mode failed to run)'
  if ('error' in verdict) return `judge error: ${verdict.error}`
  const s = verdict.scores
  return (
    `${verdict.winner}` +
    `  [single d${s.single.depth}/c${s.single.coverage}/s${s.single.specificity}/q${s.single.citationQuality}` +
    ` | multi d${s.multi.depth}/c${s.multi.coverage}/s${s.multi.specificity}/q${s.multi.citationQuality}]`
  )
}

function fmt(n: number | null, digits = 1): string {
  return n === null ? 'n/a' : n.toFixed(digits)
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  )
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(line(header))
  console.log(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of rows) console.log(line(row))
}

function printSummary(agg: AbAggregate): void {
  console.log('\n=== Deep-research A/B: multi vs single ===\n')
  console.log(`judge model:  ${JUDGE_MODEL}`)
  console.log(
    `questions: ${agg.total}   judged: ${agg.judged}   ` +
      `errored: ${agg.errored}   skipped: ${agg.skipped}`
  )

  console.log('\nWinner (of judged):')
  console.log(`  multi wins : ${agg.multiWins}  (${fmt(agg.multiWinRate)}%)`)
  console.log(`  single wins: ${agg.singleWins}  (${fmt(agg.singleWinRate)}%)`)
  console.log(`  ties       : ${agg.ties}  (${fmt(agg.tieRate)}%)`)

  if (agg.avgScores) {
    console.log('\nAverage per-dimension score (1-5):\n')
    printTable(
      ['mode', 'depth', 'coverage', 'specificity', 'citation'],
      (['single', 'multi'] as const).map(m => [
        m,
        fmt(agg.avgScores![m].depth, 2),
        fmt(agg.avgScores![m].coverage, 2),
        fmt(agg.avgScores![m].specificity, 2),
        fmt(agg.avgScores![m].citationQuality, 2)
      ])
    )
  } else {
    console.log('\n(no questions judged — nothing to average)')
  }
}

async function main(): Promise<void> {
  const { limit, outName } = parseArgs(process.argv.slice(2))
  const questions = DEEP_RESEARCH_QUESTIONS.slice(0, limit)

  console.log(
    `Running deep-research A/B over ${questions.length} question(s)  ` +
      `judge=${JUDGE_MODEL}\n`
  )

  const records: AbRecord[] = []
  for (const [i, q] of questions.entries()) {
    console.log(`[${i + 1}/${questions.length}] ${q.id} (${q.domain})`)
    const record = await runQuestion(q, invokeDeepResearch)
    records.push(record)
    console.log(`  -> ${verdictLabel(record.verdict)}`)
  }

  mkdirSync(RESULTS_DIR, { recursive: true })
  const filename =
    outName ??
    `deep-research-ab-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  const outPath = path.join(RESULTS_DIR, filename)
  writeFileSync(outPath, records.map(r => JSON.stringify(r)).join('\n') + '\n')

  printSummary(aggregate(records.map(r => r.verdict)))
  console.log(`\nPer-question JSONL: ${outPath}`)
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
