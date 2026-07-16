import { describe, expect, it } from 'vitest'

import type { MemoryCandidate, NearestMemory, WriteConfig } from '../types'
import { decideWrite } from '../write'

const cfg: WriteConfig = { simThreshold: 0.9, graduateSightings: 2 }
const cand = (over: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  content: 'Self-hosts their infrastructure',
  category: 'fact',
  ...over
})
const near = (over: Partial<NearestMemory> = {}): NearestMemory => ({
  id: 'm1',
  content: 'Self-hosts everything',
  status: 'candidate',
  sightings: 1,
  similarity: 0.95,
  ...over
})

describe('decideWrite', () => {
  it('inserts a new candidate when nothing is similar', () => {
    expect(decideWrite(cand(), null, cfg)).toEqual({
      action: 'insert',
      status: 'candidate'
    })
  })

  it('inserts confirmed directly for a user-directed save', () => {
    expect(decideWrite(cand({ confirmed: true }), null, cfg)).toEqual({
      action: 'insert',
      status: 'confirmed'
    })
  })

  it('bumps + graduates a near-duplicate candidate that reaches the threshold', () => {
    // existing sightings 1 → after bump 2 == graduateSightings → graduate
    expect(decideWrite(cand(), near({ sightings: 1 }), cfg)).toEqual({
      action: 'bump',
      id: 'm1',
      graduate: true
    })
  })

  it('bumps without graduating when still below threshold', () => {
    const c = { ...cfg, graduateSightings: 3 }
    expect(decideWrite(cand(), near({ sightings: 1 }), c)).toEqual({
      action: 'bump',
      id: 'm1',
      graduate: false
    })
  })

  it('does not demote an already-confirmed near-duplicate (bump, no graduate flag effect)', () => {
    expect(
      decideWrite(cand(), near({ status: 'confirmed', sightings: 5 }), cfg)
    ).toEqual({ action: 'bump', id: 'm1', graduate: false })
  })

  it('below the similarity threshold is treated as new, not a dup', () => {
    expect(decideWrite(cand(), near({ similarity: 0.5 }), cfg)).toEqual({
      action: 'insert',
      status: 'candidate'
    })
  })
})
