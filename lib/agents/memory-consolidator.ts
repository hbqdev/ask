import { dbAdmin } from '@/lib/db'
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
  // Cross-user system read (every user id that has memories) — must use the
  // admin client, as recall-backfill does. `db` connects as the restricted
  // app_user role, and user_memories' RLS policy matches
  // app.current_user_id, which is unset here, so `db` saw ZERO rows and the
  // sweep silently did nothing. Only the id listing is admin; each user's
  // dedup/evict below still runs RLS-scoped via withOptionalRLS.
  const rows = await dbAdmin
    .selectDistinct({ userId: userMemories.userId })
    .from(userMemories)
  for (const { userId } of rows) {
    const r = await consolidateUser(userId)
    merged += r.merged
  }
  return { users: rows.length, merged }
}
