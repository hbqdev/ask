import {
  bumpMemory,
  evictOverCap,
  insertMemory,
  nearestMemory,
  supersedeMemory
} from '@/lib/db/memory-actions'
import {
  embedTexts,
  getConfiguredModel
} from '@/lib/embeddings/transformers-embedding'

import type {
  MemoryCandidate,
  NearestMemory,
  WriteConfig,
  WriteDecision
} from './types'

/**
 * Pure decision for the write path given a candidate and its nearest existing
 * memory (or null). Contradiction/supersede is decided one layer up (it needs a
 * granite call), so this function handles the mechanical dedup/graduation:
 * - no similar existing → insert (confirmed if the candidate is user-directed)
 * - similar existing → bump sightings; graduate a candidate to confirmed once
 *   its post-bump count reaches graduateSightings.
 */
export function decideWrite(
  candidate: MemoryCandidate,
  nearest: NearestMemory | null,
  cfg: WriteConfig
): WriteDecision {
  if (!nearest || nearest.similarity < cfg.simThreshold) {
    return {
      action: 'insert',
      status: candidate.confirmed ? 'confirmed' : 'candidate'
    }
  }
  // A near-duplicate exists → repetition signal.
  const graduate =
    nearest.status === 'candidate' &&
    (candidate.confirmed || nearest.sightings + 1 >= cfg.graduateSightings)
  return { action: 'bump', id: nearest.id, graduate }
}

function config(): WriteConfig {
  const sim = Number(process.env.MEMORY_SIM_THRESHOLD)
  const grad = Number(process.env.MEMORY_GRADUATE_SIGHTINGS)
  return {
    simThreshold: Number.isFinite(sim) ? sim : 0.9,
    graduateSightings: Number.isFinite(grad) && grad > 0 ? grad : 2
  }
}

/**
 * Persist extracted/user-directed candidates. Embeds each, finds its nearest
 * existing memory, applies decideWrite, and writes. Never throws — memory is a
 * background enhancement (returns the count saved/updated). Caps per user.
 */
export async function saveCandidates(
  userId: string,
  candidates: MemoryCandidate[],
  opts: { sourceChatId?: string } = {}
): Promise<number> {
  if (candidates.length === 0) return 0
  const cfg = config()
  const cap = Number(process.env.MEMORY_MAX_PER_USER)
  let saved = 0
  try {
    const embeddings = await embedTexts(
      candidates.map(c => c.content),
      getConfiguredModel()
    )
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      const embedding = embeddings[i]
      const nearest = await nearestMemory(userId, embedding)
      const decision = decideWrite(candidate, nearest, cfg)
      if (decision.action === 'insert') {
        await insertMemory(userId, {
          content: candidate.content,
          category: candidate.category,
          status: decision.status,
          embedding,
          sourceChatId: opts.sourceChatId
        })
        saved++
      } else if (decision.action === 'bump') {
        await bumpMemory(userId, decision.id, decision.graduate)
        saved++
      }
      // 'supersede'/'skip' reserved for the granite contradiction pass
      // (consolidation, Task 6); the per-turn path uses insert/bump only.
    }
    await evictOverCap(userId, Number.isFinite(cap) && cap > 0 ? cap : 30)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('saveCandidates failed:', error)
    }
  }
  return saved
}
