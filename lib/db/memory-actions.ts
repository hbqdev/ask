import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import {
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'

import { userMemories, userSettings } from './schema'
import { withOptionalRLS } from './with-rls'

const toVec = (v: number[]) => sql`${JSON.stringify(v)}::vector`

/** Nearest existing memory to a candidate embedding, by cosine similarity. */
export async function nearestMemory(
  userId: string,
  embedding: number[]
): Promise<{
  id: string
  content: string
  status: 'candidate' | 'confirmed'
  sightings: number
  similarity: number
} | null> {
  return withOptionalRLS(userId, async tx => {
    const rows = await tx
      .select({
        id: userMemories.id,
        content: userMemories.content,
        status: userMemories.status,
        sightings: userMemories.sightings,
        similarity: sql<number>`1 - (${userMemories.embedding} <=> ${toVec(embedding)})`
      })
      .from(userMemories)
      .where(eq(userMemories.userId, userId))
      .orderBy(sql`${userMemories.embedding} <=> ${toVec(embedding)}`)
      .limit(1)
    return rows[0] ?? null
  })
}

export async function insertMemory(
  userId: string,
  m: {
    content: string
    category: string
    status: 'candidate' | 'confirmed'
    embedding: number[]
    sourceChatId?: string
  }
): Promise<void> {
  await withOptionalRLS(userId, async tx => {
    await tx.insert(userMemories).values({
      userId,
      content: m.content,
      category: m.category as any,
      status: m.status,
      embedding: m.embedding,
      sourceChatId: m.sourceChatId ?? null
    })
  })
}

export async function bumpMemory(
  userId: string,
  id: string,
  graduate: boolean
): Promise<void> {
  await withOptionalRLS(userId, async tx => {
    await tx
      .update(userMemories)
      .set({
        sightings: sql`${userMemories.sightings} + 1`,
        status: graduate ? 'confirmed' : undefined,
        updatedAt: new Date()
      })
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
  })
}

export async function supersedeMemory(
  userId: string,
  id: string,
  content: string,
  embedding: number[]
): Promise<void> {
  await withOptionalRLS(userId, async tx => {
    await tx
      .update(userMemories)
      .set({ content, embedding, status: 'confirmed', updatedAt: new Date() })
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
  })
}

/** Confirmed memories for injection (most-recently-used first), capped. */
export async function getConfirmedMemories(userId: string, limit: number) {
  return withOptionalRLS(userId, async tx =>
    tx
      .select()
      .from(userMemories)
      .where(
        and(
          eq(userMemories.userId, userId),
          eq(userMemories.status, 'confirmed')
        )
      )
      .orderBy(desc(userMemories.lastUsedAt), desc(userMemories.updatedAt))
      .limit(limit)
  )
}

export async function setLastUsed(userId: string, ids: string[]) {
  if (ids.length === 0) return
  await withOptionalRLS(userId, async tx => {
    await tx
      .update(userMemories)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(userMemories.userId, userId), inArray(userMemories.id, ids)))
  })
}

/** LRU-evict confirmed memories beyond the cap. */
export async function evictOverCap(userId: string, cap: number) {
  await withOptionalRLS(userId, async tx => {
    await tx.execute(sql`
      DELETE FROM user_memories WHERE id IN (
        SELECT id FROM user_memories
        WHERE user_id = ${userId} AND status = 'confirmed'
        ORDER BY last_used_at ASC NULLS FIRST, updated_at ASC
        OFFSET ${cap}
      )`)
  })
}

export async function listMemories(userId: string) {
  return withOptionalRLS(userId, async tx =>
    tx
      .select()
      .from(userMemories)
      .where(eq(userMemories.userId, userId))
      .orderBy(desc(userMemories.updatedAt))
  )
}

export async function deleteMemory(userId: string, id: string) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .delete(userMemories)
      .where(and(eq(userMemories.userId, userId), eq(userMemories.id, id)))
  })
}

export async function clearMemories(userId: string) {
  await withOptionalRLS(userId, async tx => {
    await tx.delete(userMemories).where(eq(userMemories.userId, userId))
  })
}

export async function isMemoryEnabled(userId: string): Promise<boolean> {
  if (process.env.MEMORY_ENABLED === 'off') return false
  return withOptionalRLS(userId, async tx => {
    const rows = await tx
      .select({ enabled: userSettings.memoryEnabled })
      .from(userSettings)
      .where(eq(userSettings.userId, userId))
      .limit(1)
    return rows[0]?.enabled ?? true // default on
  })
}

export async function setMemoryEnabled(userId: string, on: boolean) {
  await withOptionalRLS(userId, async tx => {
    await tx
      .insert(userSettings)
      .values({ userId, memoryEnabled: on })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { memoryEnabled: on, updatedAt: new Date() }
      })
  })
}

export { embedTexts, getConfiguredModel } // re-export for callers' convenience
