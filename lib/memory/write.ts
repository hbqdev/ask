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
