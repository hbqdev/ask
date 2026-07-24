import { promises as fs } from 'node:fs'
import path from 'node:path'

import { classifyQuery } from '@/lib/agents/query-classifier'

import { CASES } from './classifier-cases'

const BASELINE = path.join(__dirname, 'classifier-baseline.json')

type Result = {
  skipSearch: boolean
  standaloneQuery: string
  needsRecent: boolean
  intent: string
}

async function run(): Promise<Record<string, Result>> {
  const out: Record<string, Result> = {}
  for (const c of CASES) {
    const r = await classifyQuery({ messages: c.messages })
    out[c.name] = {
      skipSearch: r.skipSearch,
      standaloneQuery: r.standaloneQuery,
      needsRecent: r.needsRecent,
      intent: r.intent
    }
    console.log(
      `  ${c.name}: skip=${r.skipSearch} recent=${r.needsRecent} intent=${r.intent} q="${r.standaloneQuery}"`
    )
  }
  return out
}

async function main() {
  const mode = process.argv[2]
  if (mode === '--capture') {
    const results = await run()
    await fs.writeFile(BASELINE, JSON.stringify(results, null, 2) + '\n')
    console.log(`\nBaseline written: ${BASELINE}`)
    return
  }
  if (mode === '--check') {
    const baseline: Record<string, Result> = JSON.parse(
      await fs.readFile(BASELINE, 'utf8')
    )
    const now = await run()
    let failed = 0
    console.log('\n=== parity vs baseline ===')
    for (const c of CASES) {
      const b = baseline[c.name]
      const n = now[c.name]
      const decisionOk =
        b.skipSearch === n.skipSearch &&
        b.needsRecent === n.needsRecent &&
        b.intent === n.intent
      const queryOk = b.standaloneQuery === n.standaloneQuery
      if (decisionOk && queryOk) {
        console.log(`  PASS ${c.name}`)
      } else {
        failed++
        console.log(
          `  FAIL ${c.name}: decision=${decisionOk} query=${queryOk}\n    baseline: ${JSON.stringify(b)}\n    now:      ${JSON.stringify(n)}`
        )
      }
    }
    if (failed > 0) {
      console.error(`\n${failed} case(s) drifted — DO NOT SHIP.`)
      process.exit(1)
    }
    console.log('\nAll cases parity-clean.')
    return
  }
  console.error('usage: classifier-eval.ts --capture | --check')
  process.exit(2)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
