import { and, desc, eq, ilike, inArray, ne, sql } from 'drizzle-orm'

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
 * text assembled from ordered text parts. Resumable — call until it returns [].
 */
export async function messagesWithoutChunks(
  userId: string,
  limit = 25
): Promise<
  {
    messageId: string
    chatId: string
    role: 'user' | 'assistant'
    text: string
  }[]
> {
  return withOptionalRLS(userId, async tx => {
    const res = await tx.execute(sql`
      SELECT m.id AS "messageId",
             m.chat_id AS "chatId",
             m.role AS "role",
             string_agg(p.text_text, ' ' ORDER BY p."order") AS "text"
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      JOIN parts p ON p.message_id = m.id AND p.type = 'text'
      WHERE c.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM conversation_chunks cc WHERE cc.message_id = m.id
        )
      GROUP BY m.id, m.chat_id, m.role
      HAVING string_agg(p.text_text, ' ' ORDER BY p."order") <> ''
      ORDER BY m.created_at ASC
      LIMIT ${limit}
    `)
    return (
      (res as unknown as { rows?: any[] }).rows ?? (res as unknown as any[])
    )
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
