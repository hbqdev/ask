/**
 * Measure how STABLE the needsSources gate is, per question, by repetition.
 *
 * WHY THIS RUNS BEFORE ANY A/B. A live turn recorded needsSources=true for
 * "Explain what a closure is in JavaScript" while two direct probes of the same
 * prompt returned false. The gate is deterministic on unambiguous questions
 * (the 12-case parity harness is 12/12 stable) and NOT on borderline ones — and
 * borderline is exactly where the gate's decision is contested.
 *
 * Two consequences, both of which this script exists to quantify:
 *
 *   1. A question that flips cannot be A/B'd. Running it on two arms measures
 *      the coin, not the arms. Only questions that classify consistently are
 *      admissible evidence, and this is what decides which those are.
 *
 *   2. The 13W-2L the whole gate rests on was a SINGLE run. If borderline
 *      questions flip at a material rate, some of those 18 turns would classify
 *      differently on a rerun, and the margin is softer than it reads.
 *
 * Run it against BOTH arms' prompts. lab's classifier emits subQuestions and
 * staging's does not, which is a second variable between the arms; if the two
 * prompts produce different gate rates on the same questions, the A/B is
 * confounded and has to be fixed before it is worth running.
 *
 * Usage:  bun scripts/eval/gate-stability.ts [reps]
 */
import { classifyQuery } from '@/lib/agents/query-classifier'

const REPS = Number(process.argv[2] ?? 5)

const u = (t: string) =>
  [{ id: '1', role: 'user', parts: [{ type: 'text', text: t }] }] as never

type Case = {
  name: string
  text: string
  kind: 'concept' | 'operational' | 'research'
}

const CASES: Case[] = [
  // CONCEPT — the 13-win shape. The gate SHOULD suppress these, and the
  // treatment must not break them. Any drift here is the expensive kind.
  {
    name: 'tcp-udp',
    kind: 'concept',
    text: 'What is the difference between TCP and UDP?'
  },
  {
    name: 'closures',
    kind: 'concept',
    text: 'Explain what a closure is in JavaScript.'
  },
  {
    name: 'solid',
    kind: 'concept',
    text: 'what does SOLID stand for in software design'
  },
  {
    name: 'bloom-filter',
    kind: 'concept',
    text: 'how does a bloom filter avoid false negatives'
  },

  // OPERATIONAL — the measured blind spot: the QUESTION names nothing
  // specific, the ANSWER must name tools and versions. This is the shape that
  // went 0W-2L-1T on the run the gate is justified by.
  {
    name: 'battery-sizing',
    kind: 'operational',
    text: 'How do I size a home battery for a 6kW solar array?'
  },
  {
    name: 'pg-cutover',
    kind: 'operational',
    text: 'I want to move a Postgres database to a new server with minimal downtime — what are the options, what breaks, and how do people usually verify the cutover'
  },
  {
    name: 'zero-downtime-migr',
    kind: 'operational',
    text: 'what is the best way to do zero-downtime schema migrations'
  },
  {
    name: 'k8s-move',
    kind: 'operational',
    text: 'I need to move workloads to a new Kubernetes node pool — what are my options, what breaks, and how do I verify it worked'
  },
  {
    name: 'cicd-setup',
    kind: 'operational',
    text: 'set up CI/CD for a Next.js app — what are the options and what usually goes wrong'
  },
  {
    name: 'backup-strategy',
    kind: 'operational',
    text: 'what backup strategy should I use for a self-hosted Postgres database'
  },

  // RESEARCH — unambiguously needs sources. A sanity floor: if these ever
  // classify false, the gate is broken in a way no prompt tuning will fix.
  {
    name: 'pg-version',
    kind: 'research',
    text: 'What is the current stable version of PostgreSQL?'
  },
  {
    name: 'ev-sales',
    kind: 'research',
    text: 'What are the latest reported figures for global EV sales?'
  }
]

async function main() {
  console.log(`reps=${REPS}  cases=${CASES.length}\n`)
  console.log(
    'case                 kind         needsSources over reps        gate-fires  STABLE?'
  )
  const unstable: string[] = []
  for (const c of CASES) {
    const seen: boolean[] = []
    for (let i = 0; i < REPS; i++) {
      const r = await classifyQuery({ messages: u(c.text) })
      // The gate fires only when BOTH are false (resolveTurnMode).
      seen.push(Boolean(r.needsSources) || Boolean(r.needsRecent))
    }
    // `false` here means "gate suppresses retrieval on this turn".
    const fires = seen.filter(x => !x).length
    const stable = fires === 0 || fires === REPS
    if (!stable) unstable.push(c.name)
    console.log(
      `${c.name.padEnd(20)} ${c.kind.padEnd(12)} ` +
        `${seen
          .map(x => (x ? 'search' : 'GATED'))
          .join(' ')
          .padEnd(29)} ` +
        `${String(fires).padStart(2)}/${REPS}       ${stable ? 'yes' : 'NO — flips'}`
    )
  }
  console.log(
    `\n${unstable.length} of ${CASES.length} unstable` +
      (unstable.length ? `: ${unstable.join(', ')}` : '')
  )
  console.log(
    'Only STABLE cases are admissible in the A/B — an unstable one measures the coin, not the arms.'
  )
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
