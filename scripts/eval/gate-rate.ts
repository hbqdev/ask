/**
 * Pooled gate RATE by question class, with and without gate confirmation.
 *
 * WHY NOT gate-stability.ts. That script asks "does this question classify the
 * same way every time", which is binary per question and needs a near-perfect
 * process to ever read "stable". Confirmation does not make the classifier
 * deterministic — it cannot, the nondeterminism is server-side — it lowers the
 * PROBABILITY of gating a question the model is unsure about, from p to
 * roughly p squared. A binary stability check cannot see that: a question that
 * gated 3/5 and now gates 1/5 is "unstable" both times, while the behaviour
 * that matters has changed completely.
 *
 * So this pools reps ACROSS questions within a class and reports the rate. The
 * hypothesis is specific and falsifiable:
 *
 *   concept     — should be UNCHANGED and near 100% gated. These are the turns
 *                 the gate exists for, and the 13W-2L came from them. If
 *                 confirmation drops this, it costs the feature.
 *   operational — should DROP. This is the class the model has no stable
 *                 opinion about, and where an unconfirmed gate silently
 *                 suppresses retrieval a real answer needed.
 *   research    — should stay at 0% gated either way. A floor: if these ever
 *                 gate, something is broken that confirmation will not fix.
 *
 * Usage:  bun scripts/eval/gate-rate.ts [reps]
 *         CLASSIFIER_CONFIRM_GATE=off bun scripts/eval/gate-rate.ts [reps]
 */
import { classifyQuery } from '@/lib/agents/query-classifier'

const REPS = Number(process.argv[2] ?? 6)
// Optional class filter, so the expensive high-rep runs can target the one
// class in question instead of paying for all three.
const ONLY = process.argv[3]

const u = (t: string) =>
  [{ id: '1', role: 'user', parts: [{ type: 'text', text: t }] }] as never

const CASES: { kind: string; text: string }[] = [
  { kind: 'concept', text: 'What is the difference between TCP and UDP?' },
  { kind: 'concept', text: 'Explain what a closure is in JavaScript.' },
  { kind: 'concept', text: 'what does SOLID stand for in software design' },
  { kind: 'concept', text: 'how does a bloom filter avoid false negatives' },

  {
    kind: 'operational',
    text: 'How do I size a home battery for a 6kW solar array?'
  },
  {
    kind: 'operational',
    text: 'I want to move a Postgres database to a new server with minimal downtime — what are the options, what breaks, and how do people usually verify the cutover'
  },
  {
    kind: 'operational',
    text: 'what is the best way to do zero-downtime schema migrations'
  },
  {
    kind: 'operational',
    text: 'I need to move workloads to a new Kubernetes node pool — what are my options, what breaks, and how do I verify it worked'
  },
  {
    kind: 'operational',
    text: 'set up CI/CD for a Next.js app — what are the options and what usually goes wrong'
  },
  {
    kind: 'operational',
    text: 'what backup strategy should I use for a self-hosted Postgres database'
  },

  {
    kind: 'research',
    text: 'What is the current stable version of PostgreSQL?'
  },
  {
    kind: 'research',
    text: 'What are the latest reported figures for global EV sales?'
  }
]

async function main() {
  const on = process.env.CLASSIFIER_CONFIRM_GATE !== 'off'
  const tally: Record<string, { gated: number; total: number }> = {}
  // Per QUESTION as well as per class. An aggregate hides the case that
  // matters: 88% concept could be three questions at 100% and one at 50%,
  // which is a different problem with a different fix.
  const perQ: { text: string; kind: string; gated: number }[] = []
  for (const c of CASES.filter(c => !ONLY || c.kind === ONLY)) {
    tally[c.kind] ??= { gated: 0, total: 0 }
    let qGated = 0
    for (let i = 0; i < REPS; i++) {
      const r = await classifyQuery({ messages: u(c.text) })
      // The gate fires only when both are false — see resolveTurnMode.
      const gated =
        !r.needsSources && !r.needsRecent && !r.operationalTask && !r.skipSearch
      tally[c.kind].total++
      if (gated) {
        tally[c.kind].gated++
        qGated++
      }
    }
    perQ.push({ text: c.text, kind: c.kind, gated: qGated })
  }
  console.log(`\nconfirmation=${on ? 'ON' : 'off'}  reps=${REPS}`)
  console.log('per question:')
  for (const q of perQ) {
    console.log(
      `  ${String(q.gated).padStart(3)}/${REPS}  ${((q.gated / REPS) * 100).toFixed(0).padStart(4)}%  ${q.kind.padEnd(12)} ${q.text.slice(0, 52)}`
    )
  }
  console.log('\nclass          gated / total     rate')
  for (const k of ['concept', 'operational', 'research']) {
    const t = tally[k]
    if (!t) continue
    console.log(
      `${k.padEnd(14)} ${String(t.gated).padStart(3)} / ${String(t.total).padEnd(6)} ${((t.gated / t.total) * 100).toFixed(0).padStart(6)}%`
    )
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
