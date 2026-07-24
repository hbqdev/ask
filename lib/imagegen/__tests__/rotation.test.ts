import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetRotationForTests,
  __setRotationClientForTests,
  nextRotationIndex
} from '../rotation'

beforeEach(() => __resetRotationForTests())

describe('nextRotationIndex (in-memory path)', () => {
  beforeEach(() => __setRotationClientForTests(null))

  it('advances and wraps per poolKey independently', async () => {
    expect(await nextRotationIndex('generate:general', 3)).toBe(0)
    expect(await nextRotationIndex('generate:general', 3)).toBe(1)
    expect(await nextRotationIndex('generate:general', 3)).toBe(2)
    expect(await nextRotationIndex('generate:general', 3)).toBe(0)
    // a different pool has its own counter
    expect(await nextRotationIndex('edit:general', 3)).toBe(0)
  })

  it('returns 0 for empty or single pools without dividing by zero', async () => {
    expect(await nextRotationIndex('x', 0)).toBe(0)
    expect(await nextRotationIndex('y', 1)).toBe(0)
    expect(await nextRotationIndex('y', 1)).toBe(0)
  })
})

describe('nextRotationIndex (client path)', () => {
  it('uses the client INCR and maps 1-based counters to 0-based indexes', async () => {
    const incr = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    __setRotationClientForTests({ incr })
    expect(await nextRotationIndex('generate:general', 6)).toBe(0)
    expect(await nextRotationIndex('generate:general', 6)).toBe(1)
    expect(incr).toHaveBeenCalledWith('imagegen:rr:generate:general')
  })

  it('falls back to memory when the client throws and abandons the failing client', async () => {
    const incr = vi.fn().mockRejectedValue(new Error('down'))
    __setRotationClientForTests({ incr })
    expect(await nextRotationIndex('generate:general', 3)).toBe(0)
    expect(await nextRotationIndex('generate:general', 3)).toBe(1)
    // the failing client is abandoned after the first blip: no further INCRs,
    // and memory keeps advancing without repeating an index
    expect(incr).toHaveBeenCalledTimes(1)
  })
})
