import { db } from '@/lib/db'
import { messagesWithoutChunks } from '@/lib/db/recall-actions'
import { chats } from '@/lib/db/schema'

import { indexMessage } from './recall-index'

/**
 * Index every message of this user that has no chunks yet. Idempotent and
 * resumable (the query itself skips already-indexed messages), batched so a
 * large history does not peg the CPU. Never throws.
 */
export async function backfillUser(
  userId: string,
  opts: { batchSize?: number; maxBatches?: number } = {}
): Promise<{ messages: number; chunks: number }> {
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
  }
  return { messages, chunks }
}

/** Cron sweep: backfill every user who has chats. Non-RLS user-id read only. */
export async function backfillAllUsers(): Promise<{
  users: number
  messages: number
  chunks: number
}> {
  let messages = 0
  let chunks = 0
  const rows = await db.selectDistinct({ userId: chats.userId }).from(chats)
  for (const { userId } of rows) {
    const r = await backfillUser(userId)
    messages += r.messages
    chunks += r.chunks
  }
  return { users: rows.length, messages, chunks }
}
