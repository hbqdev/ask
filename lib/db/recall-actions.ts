import { and, desc, eq, ilike, ne, sql } from 'drizzle-orm'

import type { IndexablePart } from '../memory/extract-indexable-text'

import { chats, conversationChunks, messages, userSettings } from './schema'
import { withOptionalRLS } from './with-rls'
import { db } from '.'

const toVec = (v: number[]) => sql`${JSON.stringify(v)}::vector`

export interface ChunkSearchRow {
  chunkId: string
  chatId: string
  chatTitle: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
  score: number
}

export interface NewChunk {
  chatId: string
  messageId: string
  role: 'user' | 'assistant'
  content: string
  chunkIndex: number
  embedding: number[]
}

export async function insertChunks(userId: string, rows: NewChunk[]) {
  if (rows.length === 0) return
  await withOptionalRLS(userId, async tx => {
    await tx
      .insert(conversationChunks)
      .values(rows.map(r => ({ ...r, userId })))
  })
}

export async function deleteChunksForMessage(
  userId: string,
  messageId: string
) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .delete(conversationChunks)
      .where(
        and(
          eq(conversationChunks.userId, userId),
          eq(conversationChunks.messageId, messageId)
        )
      )
  })
}

/** Vector arm: cosine similarity, nearest first. `score` is cosine in [0,1]. */
export async function vectorSearchChunks(
  userId: string,
  embedding: number[],
  n: number,
  excludeChatId?: string
): Promise<ChunkSearchRow[]> {
  return withOptionalRLS(userId, async tx => {
    const conds = [eq(conversationChunks.userId, userId)]
    if (excludeChatId) conds.push(ne(conversationChunks.chatId, excludeChatId))
    return tx
      .select({
        chunkId: conversationChunks.id,
        chatId: conversationChunks.chatId,
        chatTitle: chats.title,
        role: conversationChunks.role,
        content: conversationChunks.content,
        createdAt: conversationChunks.createdAt,
        score: sql<number>`1 - (${conversationChunks.embedding} <=> ${toVec(embedding)})`
      })
      .from(conversationChunks)
      .innerJoin(chats, eq(chats.id, conversationChunks.chatId))
      .where(and(...conds))
      .orderBy(sql`${conversationChunks.embedding} <=> ${toVec(embedding)}`)
      .limit(n) as Promise<ChunkSearchRow[]>
  })
}

/** Keyword arm: ILIKE. Keyword-only hits carry score 0 (see recall-search). */
export async function keywordSearchChunks(
  userId: string,
  term: string,
  n: number,
  excludeChatId?: string
): Promise<ChunkSearchRow[]> {
  return withOptionalRLS(userId, async tx => {
    const conds = [
      eq(conversationChunks.userId, userId),
      ilike(conversationChunks.content, `%${term}%`)
    ]
    if (excludeChatId) conds.push(ne(conversationChunks.chatId, excludeChatId))
    return tx
      .select({
        chunkId: conversationChunks.id,
        chatId: conversationChunks.chatId,
        chatTitle: chats.title,
        role: conversationChunks.role,
        content: conversationChunks.content,
        createdAt: conversationChunks.createdAt,
        score: sql<number>`0`
      })
      .from(conversationChunks)
      .innerJoin(chats, eq(chats.id, conversationChunks.chatId))
      .where(and(...conds))
      .orderBy(desc(conversationChunks.createdAt))
      .limit(n) as Promise<ChunkSearchRow[]>
  })
}

/** Real index status for the settings UI. */
export async function countChunks(
  userId: string
): Promise<{ chunks: number; chats: number }> {
  return withOptionalRLS(userId, async tx => {
    const rows = await tx
      .select({
        chunks: sql<number>`count(*)::int`,
        chats: sql<number>`count(distinct ${conversationChunks.chatId})::int`
      })
      .from(conversationChunks)
      .where(eq(conversationChunks.userId, userId))
    return { chunks: rows[0]?.chunks ?? 0, chats: rows[0]?.chats ?? 0 }
  })
}

export async function clearChunks(userId: string) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .delete(conversationChunks)
      .where(eq(conversationChunks.userId, userId))
  })
}

/**
 * Backfill driver: the user's messages that have no chunks yet, with their
 * ordered parts (type + text) so the caller can apply the same
 * final-answer-only extraction rule (extractIndexableText) that the live
 * path uses — a naive text-parts-only aggregate here would re-pollute every
 * backfilled assistant message with inter-step narration. Resumable — call
 * until it returns [].
 *
 * `excludeIds` lets a single backfill run skip messages it already
 * attempted in an earlier batch of the SAME run: extractIndexableText can
 * legitimately reduce a message to '' (e.g. an assistant message whose only
 * text is narration before the last tool call), which yields 0 chunks and
 * would otherwise satisfy `NOT EXISTS (... conversation_chunks ...)`
 * forever — reselecting the same message on every subsequent call.
 */
export async function messagesWithoutChunks(
  userId: string,
  limit = 25,
  excludeIds: string[] = []
): Promise<
  {
    messageId: string
    chatId: string
    role: 'user' | 'assistant'
    parts: IndexablePart[]
  }[]
> {
  return withOptionalRLS(userId, async tx => {
    // Parameterized explicitly as `NOT IN ($1, $2, ...)`, never
    // `sql\`<> ANY(${jsArray})\`` — that form renders a single array
    // parameter into an invalid row-tuple (see recall-actions-sql.test.ts).
    // sql.join binds each id as its own placeholder.
    const excludeClause =
      excludeIds.length > 0
        ? sql`AND m.id NOT IN (${sql.join(
            excludeIds.map(id => sql`${id}`),
            sql`, `
          )})`
        : sql``

    // Postgres's trim()/btrim() strips SPACES ONLY — not tabs or newlines
    // (verified live against pg17: trim(E'\t') <> '' and trim(E'\n') <> ''
    // are both true). recall-index.ts's indexMessage() guards with the JS
    // `!text.trim()`, and JS's String.prototype.trim() strips ALL
    // whitespace. A message whose text collapses to just a tab or newline
    // would pass a trim()-based HAVING here, get selected, then get
    // rejected by the JS guard with 0 chunks — reselected on every future
    // call, forever. The HAVING predicate below instead tests "at least one
    // text part contains a non-whitespace character" via regex (bool_or
    // over all joined parts, since the join can no longer be restricted to
    // type = 'text' — we need every part type to reconstruct the
    // extraction order), which agrees with the JS guard's semantics rather
    // than Postgres's space-only trim().
    const res = await tx.execute(sql`
      SELECT m.id AS "messageId",
             m.chat_id AS "chatId",
             m.role AS "role",
             json_agg(
               json_build_object('type', p.type, 'text', p.text_text)
               ORDER BY p."order"
             ) AS "parts"
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      JOIN parts p ON p.message_id = m.id
      WHERE c.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM conversation_chunks cc WHERE cc.message_id = m.id
        )
        ${excludeClause}
      GROUP BY m.id, m.chat_id, m.role
      HAVING bool_or(p.type = 'text' AND p.text_text ~ '[^[:space:]]')
      ORDER BY m.created_at ASC
      LIMIT ${limit}
    `)
    const rows =
      (res as unknown as { rows?: any[] }).rows ?? (res as unknown as any[])
    return rows.map(r => ({
      messageId: r.messageId,
      chatId: r.chatId,
      role: r.role,
      parts: (r.parts ?? []) as IndexablePart[]
    }))
  })
}

/** Global kill switch first, then the per-user toggle (default on). */
export async function isRecallEnabled(userId: string): Promise<boolean> {
  if (process.env.RECALL_ENABLED === 'off') return false
  return withOptionalRLS(userId, async tx => {
    const rows = await tx
      .select({ enabled: userSettings.recallEnabled })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)
    return rows[0]?.enabled ?? true
  })
}

export async function setRecallEnabled(userId: string, on: boolean) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .insert(userSettings)
      .values({ userId, recallEnabled: on })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { recallEnabled: on, updatedAt: new Date() }
      })
  })
}
