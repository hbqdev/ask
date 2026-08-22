/**
 * Gate rate measured on REAL conversations, replayed with their actual history.
 *
 * WHY THIS EXISTS. Every gate rate quoted during this work — 61%, 75%, 77% —
 * was measured by handing the classifier a BARE QUESTION with no conversation.
 * That is the condition most favourable to the gate firing, and it overstated
 * the rate by roughly 4-5x. On two real 11-turn threads the gate fired on 3 of
 * 22 turns (14%), because in a real thread two things intervene that a bare
 * question cannot show:
 *
 *   - skipSearch catches referential follow-ups first, so they never reach the
 *     gate at all;
 *   - accumulated context pushes the classifier toward needsSources=true.
 *
 * So this replays turns from chats that actually happened. For each assistant
 * turn it rebuilds the message list exactly as the live path would have — the
 * user message plus everything before it — and classifies that. It never sends
 * a chat turn or generates an answer; the only cost is one classifier call per
 * turn replayed.
 *
 * Reads from the STAGING database by default, which runs the same code as prod.
 *
 * Usage:
 *   bun scripts/eval/gate-rate-live.ts [maxChats] [reps]
 */
import { execFileSync } from 'node:child_process'

import { classifyQuery } from '@/lib/agents/query-classifier'

const MAX_CHATS = Number(process.argv[2] ?? 12)
const REPS = Number(process.argv[3] ?? 1)
const PG = process.env.EVAL_PG ?? 'ask-postgres-admin-feature'

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', PG, 'psql', '-U', 'morphic', '-d', 'morphic', '-tAc', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
}

type Msg = { role: string; text: string }

/**
 * Real chats, longest first — a multi-turn thread is the whole point, and a
 * one-turn chat replays as a bare question, which is the bias being corrected.
 * Benchmark chats are excluded: ab_/cmp_ ids are harness output, not traffic.
 */
function pickChats(): string[] {
  const raw = psql(`
    SELECT c.id FROM chats c
    JOIN messages m ON m.chat_id = c.id AND m.role = 'user'
    WHERE c.id NOT LIKE 'ab\\_%' AND c.id NOT LIKE 'cmp\\_%'
    GROUP BY c.id HAVING COUNT(*) >= 3
    ORDER BY COUNT(*) DESC LIMIT ${MAX_CHATS};`)
  return raw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
}

function loadMessages(chatId: string): Msg[] {
  const raw = psql(`
    SELECT COALESCE(json_agg(json_build_object('role', t.role, 'text', t.txt)
             ORDER BY t.created_at ASC, t.ord ASC), '[]') FROM (
      SELECT m.role, m.created_at, p."order" AS ord, COALESCE(p.text_text,'') AS txt
      FROM messages m JOIN parts p ON p.message_id = m.id
      WHERE m.chat_id = '${chatId}' AND p.type = 'text' AND p.text_text IS NOT NULL
    ) t;`)
  try {
    return JSON.parse(raw || '[]')
  } catch {
    return []
  }
}

const toUI = (msgs: Msg[]) =>
  msgs.map((m, i) => ({
    id: String(i),
    role: m.role,
    parts: [{ type: 'text', text: m.text }]
  })) as never

async function main() {
  const chats = pickChats()
  console.log(`replaying ${chats.length} real chats from ${PG}, reps=${REPS}\n`)

  let gated = 0
  let total = 0
  let firstTurn = { gated: 0, total: 0 }
  let followUp = { gated: 0, total: 0 }
  const bySkip = { skip: 0, stable: 0, research: 0 }

  for (const chatId of chats) {
    const msgs = loadMessages(chatId)
    // Replay each USER message with exactly the history that preceded it.
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role !== 'user') continue
      const history = msgs.slice(0, i + 1)
      for (let r = 0; r < REPS; r++) {
        const c = await classifyQuery({ messages: toUI(history) })
        const isGated = !c.skipSearch && !c.needsSources && !c.needsRecent
        total++
        if (isGated) gated++
        if (c.skipSearch) bySkip.skip++
        else if (isGated) bySkip.stable++
        else bySkip.research++
        const bucket = i === 0 ? firstTurn : followUp
        bucket.total++
        if (isGated) bucket.gated++
      }
    }
  }

  const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(0) : '0')
  console.log(`turns replayed:      ${total}`)
  console.log(`GATE FIRED:          ${gated}/${total}  ${pct(gated, total)}%`)
  console.log(
    `  first turn:        ${firstTurn.gated}/${firstTurn.total}  ${pct(firstTurn.gated, firstTurn.total)}%`
  )
  console.log(
    `  follow-up turns:   ${followUp.gated}/${followUp.total}  ${pct(followUp.gated, followUp.total)}%`
  )
  console.log(`\nmode split:`)
  console.log(
    `  direct (skipSearch) ${bySkip.skip}  ${pct(bySkip.skip, total)}%`
  )
  console.log(
    `  stable-knowledge    ${bySkip.stable}  ${pct(bySkip.stable, total)}%`
  )
  console.log(
    `  research            ${bySkip.research}  ${pct(bySkip.research, total)}%`
  )
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
