import { describe, expect, it } from 'vitest'

import { mapWithConcurrency } from '../map-with-concurrency'

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async n => n * 10)
    expect(out).toEqual([10, 20, 30, 40])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const work = async (n: number) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return n
    }

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, work)

    expect(peak).toBe(3)
  })

  it('keeps going when one item rejects, surfacing it as a rejected result', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async n => {
      if (n === 2) throw new Error('boom')
      return n
    })

    expect(out[0]).toBe(1)
    expect(out[1]).toBeInstanceOf(Error)
    expect(out[2]).toBe(3)
  })

  it('treats a non-positive limit as unbounded rather than hanging', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async n => n)
    expect(out).toEqual([1, 2, 3])
  })
})
