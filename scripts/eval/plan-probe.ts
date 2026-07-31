/**
 * Inspect the classifier's retrieval plan (subQuestions) across the spectrum.
 *
 * Answers the question increment 1a exists for, and which parity cannot answer:
 * parity proves the five existing decisions did not drift, this shows whether
 * the SIXTH output is worth consuming. A plan that is always length 1, or that
 * quietly re-emits rephrasings of one need, would look perfectly healthy in
 * every other check and be useless.
 *
 * The expectations below are what the design requires, not what the model
 * happens to do — a case that misses is a finding, not a test to soften.
 */
import { classifyQuery } from '@/lib/agents/query-classifier'

const u = (text: string) =>
  [{ id: '1', role: 'user', parts: [{ type: 'text', text }] }] as never

const CASES: { name: string; text: string; expect: string }[] = [
  // Nothing to look up — the needsSources gate already handles these, and a
  // plan here would contradict it.
  { name: 'casual', text: 'hey how is it going', expect: '0' },
  {
    name: 'stable-concept',
    text: 'what is the difference between TCP and UDP',
    expect: '0'
  },
  // Exactly one thing to look up. The failure mode to watch for is padding:
  // three rephrasings dressed up as three needs.
  {
    name: 'single-fact',
    text: 'what is the current stable version of PostgreSQL',
    expect: '1'
  },
  {
    name: 'single-price',
    text: 'how much does a Framework Laptop 16 cost right now',
    expect: '1'
  },
  // Genuinely several distinct needs. This is the case the whole design rests
  // on: if these come back as 1, planned retrieval cannot beat the model's
  // runtime decomposition and the architecture is not worth building.
  {
    name: 'multi-facet-comparison',
    text: 'compare Anker and Ugreen USB-C chargers on warranty, GaN efficiency, reliability complaints and price',
    expect: 'several'
  },
  {
    name: 'multi-part-research',
    text: 'I want to move a Postgres database to a new server with minimal downtime — what are the options, what breaks, and how do people usually verify the cutover',
    expect: 'several'
  },
  // Current events: one topic, but several angles a good answer needs.
  {
    name: 'current-events',
    text: 'what are the biggest technology stories this week',
    expect: '1-3'
  }
]

async function main() {
  console.log('name                    expect  size  plan')
  for (const c of CASES) {
    const r = await classifyQuery({ messages: u(c.text) })
    const plan = r.subQuestions ?? []
    console.log(
      `${c.name.padEnd(23)} ${c.expect.padEnd(7)} ${String(plan.length).padEnd(5)} ` +
        `skip=${r.skipSearch} sources=${r.needsSources}`
    )
    for (const q of plan) console.log(`    - ${q}`)
    if (plan.length === 0) console.log('    (empty)')
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
