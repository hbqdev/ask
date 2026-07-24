import { describe, expect, it } from 'vitest'

import { createWarmTrigger } from '../warm-trigger'

describe('createWarmTrigger', () => {
  it('warms on the first intent signal', () => {
    let sent = 0
    const trigger = createWarmTrigger({
      send: () => sent++,
      now: () => 1_000,
      minIntervalMs: 10_000
    })

    trigger()

    expect(sent).toBe(1)
  })

  it('collapses a burst of keystrokes into a single warm', () => {
    let sent = 0
    let clock = 1_000
    const trigger = createWarmTrigger({
      send: () => sent++,
      now: () => clock,
      minIntervalMs: 10_000
    })

    trigger()
    clock = 1_200
    trigger()
    clock = 5_000
    trigger()

    expect(sent).toBe(1)
  })

  it('re-warms once the window elapses so a long compose stays warm', () => {
    let sent = 0
    let clock = 1_000
    const trigger = createWarmTrigger({
      send: () => sent++,
      now: () => clock,
      minIntervalMs: 10_000
    })

    trigger()
    clock = 11_000
    trigger()

    expect(sent).toBe(2)
  })

  it('never lets a failing send bubble into the UI', () => {
    const trigger = createWarmTrigger({
      send: () => {
        throw new Error('offline')
      },
      now: () => 1_000,
      minIntervalMs: 10_000
    })

    expect(() => trigger()).not.toThrow()
  })
})
