import { db } from '@/lib/db'
import { isRecallEnabled, messagesWithoutChunks } from '@/lib/db/recall-actions'
import { chats } from '@/lib/db/schema'

import { extractIndexableText } from './extract-indexable-text'
import { indexMessage } from './recall-index'

export interface BackfillUserResult {
  messages: number
  chunks: number
  ok: boolean
  /**
   * Only present when `ok` is false. Distinguishes "recall is off for this
   * user, so a rebuild can never make progress" (`'disabled'`) from "a real
   * error was caught mid-batch" (`'error'`). Both are honestly `ok: false`
   * (neither may be read as "already up to date") — `reason` exists purely
   * so an aggregator (backfillAllUsers) can tell an expected per-user
   * no-op apart from an actual failure, without ever turning a real error
   * into a false success.
   */
  reason?: 'disabled' | 'error'
}

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
): Promise<BackfillUserResult> {
  // With recall disabled, indexMessage (recall-index.ts) short-circuits to 0
  // for every message, so a rebuild here can NEVER make progress — it would
  // just burn a round-trip per message (up to maxBatches * batchSize of
  // them) before the caller's no-progress breaker finally fires with a
  // misleading diagnosis. Fail fast instead.
  if (!(await isRecallEnabled(userId))) {
    return { messages: 0, chunks: 0, ok: false, reason: 'disabled' }
  }

  const batchSize = opts.batchSize ?? 25
  const maxBatches = opts.maxBatches ?? 400
  let messages = 0
  let chunks = 0
  // Message ids attempted within THIS run, regardless of whether they
  // produced a chunk. extractIndexableText can legitimately reduce a
  // message to '' (e.g. an assistant message whose only text is narration
  // before the last tool call) — indexMessage then returns 0 and writes no
  // chunk, so messagesWithoutChunks' `NOT EXISTS (... conversation_chunks
  // ...)` would keep re-selecting that same message on every subsequent
  // internal batch, blocking the drain loop from ever reaching the messages
  // behind it. Excluding already-attempted ids keeps each batch call moving
  // forward through the backlog instead of getting stuck re-fetching a
  // message that can never gain a chunk.
  const attemptedIds: string[] = []
  try {
    for (let i = 0; i < maxBatches; i++) {
      // Pass a copy — messagesWithoutChunks only reads it, but handing over
      // the live array would let a caller's later mutation of it appear to
      // change an already-recorded call's arguments.
      const batch = await messagesWithoutChunks(userId, batchSize, [
        ...attemptedIds
      ])
      if (batch.length === 0) break
      for (const m of batch) {
        const text = extractIndexableText(m.role, m.parts)
        chunks += await indexMessage(
          userId,
          m.chatId,
          m.messageId,
          m.role,
          text
        )
        messages++
        attemptedIds.push(m.messageId)
      }
    }
  } catch (error) {
    console.error('[recall] backfill failed for', userId, error)
    return { messages, chunks, ok: false, reason: 'error' }
  }
  return { messages, chunks, ok: true }
}

export interface BackfillAllUsersResult {
  users: number
  messages: number
  chunks: number
  /**
   * Reflects REAL failures only (`reason === 'error'` from at least one
   * user's backfillUser call) — never flipped false merely because some
   * users have recall disabled, since that's an expected, non-error
   * per-user outcome. A cron consumer can therefore treat `ok: false` here
   * as "something actually broke," not "some user happens to have recall
   * off." See `skipped`/`failed` for the breakdown.
   */
  ok: boolean
  /** Users skipped because recall is disabled for them (not an error). */
  skipped: number
  /** Users whose backfill hit a real error. */
  failed: number
}

/** Cron sweep: backfill every user who has chats. Non-RLS user-id read only. */
export async function backfillAllUsers(): Promise<BackfillAllUsersResult> {
  let messages = 0
  let chunks = 0
  let skipped = 0
  let failed = 0
  const rows = await db.selectDistinct({ userId: chats.userId }).from(chats)
  for (const { userId } of rows) {
    const r = await backfillUser(userId)
    messages += r.messages
    chunks += r.chunks
    if (!r.ok) {
      if (r.reason === 'disabled') skipped++
      else failed++
    }
  }
  return {
    users: rows.length,
    messages,
    chunks,
    ok: failed === 0,
    skipped,
    failed
  }
}
