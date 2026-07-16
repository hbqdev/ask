import { db } from '@/lib/db'
import {
  deleteMemory,
  evictOverCap,
  listMemories
} from '@/lib/db/memory-actions'
import { userMemories } from '@/lib/db/schema'

export async function consolidateUser(
  userId: string
): Promise<{ merged: number; evicted: number }> {
  let merged = 0
  try {
    const memories = await listMemories(userId)
    const seen = new Map<string, string>() // normalized content → keeper id
    for (const m of memories) {
      if (m.status !== 'confirmed') continue
      const key = m.content.trim().toLowerCase()
      if (seen.has(key)) {
        await deleteMemory(userId, m.id) // older dup (listMemories is desc updatedAt)
        merged++
      } else {
        seen.set(key, m.id)
      }
    }
    const cap = Number(process.env.MEMORY_MAX_PER_USER)
    await evictOverCap(userId, Number.isFinite(cap) && cap > 0 ? cap : 30)
  } catch (error) {
    console.error('[memory] consolidation failed for', userId, error)
  }
  return { merged, evicted: 0 }
}

export async function consolidateAllActiveUsers(): Promise<{
  users: number
  merged: number
}> {
  let merged = 0
  const rows = await db
    .selectDistinct({ userId: userMemories.userId })
    .from(userMemories)
  for (const { userId } of rows) {
    const r = await consolidateUser(userId)
    merged += r.merged
  }
  return { users: rows.length, merged }
}
