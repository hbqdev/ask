import {
  getConfirmedMemories,
  isMemoryEnabled,
  setLastUsed
} from '@/lib/db/memory-actions'

export function buildMemoryBlock(memories: { content: string }[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map(m => `- ${m.content}`).join('\n')
  return `\n\n## What you know about this user\nThese are durable facts/preferences remembered from past conversations. Use them to personalize your answer when relevant; do not mention that you have memory unless asked.\n${lines}`
}

/**
 * The memory block to append to the researcher's system prompt for a user, or
 * '' when memory is disabled / empty / on any failure (fail-safe).
 */
export async function getMemoryInjection(
  userId: string | undefined
): Promise<string> {
  if (!userId) return ''
  try {
    if (!(await isMemoryEnabled(userId))) return ''
    const cap = Number(process.env.MEMORY_INJECT_TOP_K)
    const memories = await getConfirmedMemories(
      userId,
      Number.isFinite(cap) && cap > 0 ? cap : 30
    )
    if (memories.length === 0) return ''
    // usage signal for LRU eviction (fire-and-forget)
    void setLastUsed(
      userId,
      memories.map(m => m.id)
    ).catch(() => {})
    return buildMemoryBlock(memories)
  } catch {
    return ''
  }
}
