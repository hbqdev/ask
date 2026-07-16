import { db } from '@/lib/db'
import { isRecallEnabled, messagesWithoutChunks } from '@/lib/db/recall-actions'
import { chats } from '@/lib/db/schema'

import { indexMessage } from './recall-index'

/**
 * Index every message of this user that has no chunks yet. Idempotent and
 * resumable (the query itself skips already-indexed messages), batched so a
 * large history does not peg the CPU. Never throws.
 *
 * `ok` is the honesty signal the caller relies on: `false` means either the
 * short-circuit below fired (recall is off, so a rebuild cannot possibly
 * work) or the try/catch below caught a real error — both are "nothing was
 * indexed AND that's not because the index is already up to date". Only
 * `true` may be read as "genuinely nothing left to do".
 */
export async function backfillUser(
  userId: string,
  opts: { batchSize?: number; maxBatches?: number } = {}
): Promise<{ messages: number; chunks: number; ok: boolean }> {
  // With recall disabled, indexMessage (recall-index.ts) short-circuits to 0
  // for every message, so a rebuild here can NEVER make progress — it would
  // just burn a round-trip per message (up to maxBatches * batchSize of
  // them) before the caller's no-progress breaker finally fires with a
  // misleading diagnosis. Fail fast instead.
  if (!(await isRecallEnabled(userId))) {
    return { messages: 0, chunks: 0, ok: false }
  }

  const batchSize = opts.batchSize ?? 25
  const maxBatches = opts.maxBatches ?? 400
  let messages = 0
  let chunks = 0
  try {
    for (let i = 0; i < maxBatches; i++) {
      const batch = await messagesWithoutChunks(userId, batchSize)
      if (batch.length === 0) break
      for (const m of batch) {
        chunks += await indexMessage(
          userId,
          m.chatId,
          m.messageId,
          m.role,
          m.text
        )
        messages++
      }
    }
  } catch (error) {
    console.error('[recall] backfill failed for', userId, error)
    return { messages, chunks, ok: false }
  }
  return { messages, chunks, ok: true }
}

/** Cron sweep: backfill every user who has chats. Non-RLS user-id read only. */
export async function backfillAllUsers(): Promise<{
  users: number
  messages: number
  chunks: number
  ok: boolean
}> {
  let messages = 0
  let chunks = 0
  let ok = true
  const rows = await db.selectDistinct({ userId: chats.userId }).from(chats)
  for (const { userId } of rows) {
    const r = await backfillUser(userId)
    messages += r.messages
    chunks += r.chunks
    if (!r.ok) ok = false
  }
  return { users: rows.length, messages, chunks, ok }
}
