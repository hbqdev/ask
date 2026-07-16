export type MemoryCategory = 'preference' | 'fact' | 'interest'

export interface MemoryCandidate {
  content: string
  category: MemoryCategory
  /** Confirmed immediately (the `remember` tool / explicit user save). */
  confirmed?: boolean
}

export interface NearestMemory {
  id: string
  content: string
  status: 'candidate' | 'confirmed'
  sightings: number
  similarity: number // cosine similarity in [0,1]
}

export type WriteDecision =
  | { action: 'insert'; status: 'candidate' | 'confirmed' }
  | { action: 'bump'; id: string; graduate: boolean }
  | { action: 'supersede'; id: string }
  | { action: 'skip' }

export interface WriteConfig {
  simThreshold: number // MEMORY_SIM_THRESHOLD
  graduateSightings: number // MEMORY_GRADUATE_SIGHTINGS
}
