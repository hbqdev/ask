import { describe, expect, it } from 'vitest'

import { serialQueue } from '@/core/serial'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('serialQueue', () => {
  it('starts a task at once when nothing is running', () => {
    const run = serialQueue()
    let started = false
    void run(async () => {
      started = true
    })
    expect(started).toBe(true)
  })

  it('runs one task at a time, in order, each with its own result', async () => {
    const run = serialQueue()
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()]
    const started: number[] = []
    const results = gates.map((gate, i) =>
      run(() => {
        started.push(i)
        return gate.promise
      })
    )
    expect(started).toEqual([0])

    gates[0].resolve('a')
    expect(await results[0]).toBe('a')
    expect(started).toEqual([0, 1])

    gates[1].resolve('b')
    expect(await results[1]).toBe('b')
    expect(started).toEqual([0, 1, 2])
    gates[2].resolve('c')
    expect(await results[2]).toBe('c')
  })

  it('moves on past a task that fails, or throws before it awaits', async () => {
    const run = serialQueue()
    const failed = run(() => Promise.reject(new Error('no')))
    const thrown = run(() => {
      throw new Error('sync')
    })
    const next = run(async () => 'next')
    await expect(failed).rejects.toThrow('no')
    await expect(thrown).rejects.toThrow('sync')
    expect(await next).toBe('next')
  })
})
