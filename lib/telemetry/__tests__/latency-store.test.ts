import { describe, expect, it, vi } from 'vitest'

import { createDurableSink } from '../latency-store'

describe('createDurableSink', () => {
  it('writes the line to the console sink and to the durable store', () => {
    const logged: string[] = []
    const pushed: string[] = []
    const sink = createDurableSink({
      log: l => logged.push(l),
      push: async l => {
        pushed.push(l)
      }
    })

    sink('[latency] {"total_ms":12}')

    expect(logged).toEqual(['[latency] {"total_ms":12}'])
    expect(pushed).toEqual(['[latency] {"total_ms":12}'])
  })

  it('still logs when the durable store throws synchronously', () => {
    const logged: string[] = []
    const sink = createDurableSink({
      log: l => logged.push(l),
      push: () => {
        throw new Error('redis down')
      }
    })

    expect(() => sink('[latency] {}')).not.toThrow()
    expect(logged).toEqual(['[latency] {}'])
  })

  it('swallows a rejected push so telemetry never breaks a turn', async () => {
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    const sink = createDurableSink({
      log: () => {},
      push: async () => {
        throw new Error('write failed')
      }
    })

    expect(() => sink('[latency] {}')).not.toThrow()
    await new Promise(r => setTimeout(r, 10))
    process.off('unhandledRejection', onUnhandled)
    expect(onUnhandled).not.toHaveBeenCalled()
  })
})
