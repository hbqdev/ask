import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useMakeLink } from '@/features/thread/useMakeLink'

/** A promise with its settle functions, for a link still on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useMakeLink', () => {
  it('is making the link until it is made, then resolves with it', async () => {
    const link = deferred<string>()
    const { result } = renderHook(() => useMakeLink())
    expect(result.current.making).toBe(false)

    let made!: Promise<string | undefined>
    act(() => {
      made = result.current.run(() => link.promise)
    })
    expect(result.current.making).toBe(true)

    await act(async () => link.resolve('https://x.invalid/search/c1'))
    await expect(made).resolves.toBe('https://x.invalid/search/c1')
    expect(result.current.making).toBe(false)
    expect(result.current.error).toBeUndefined()
  })

  it('says why the link could not be made, and resolves with nothing', async () => {
    const { result } = renderHook(() => useMakeLink())

    let made!: Promise<string | undefined>
    await act(async () => {
      made = result.current.run(() => Promise.reject(new Error('Not found')))
    })

    await expect(made).resolves.toBeUndefined()
    expect(result.current.making).toBe(false)
    expect(result.current.error).toBe('Couldn’t create the link. Not found')
  })

  it('says a non-Error reason as text', async () => {
    const { result } = renderHook(() => useMakeLink())
    await act(async () => {
      await result.current.run(() => Promise.reject('boom'))
    })
    expect(result.current.error).toBe('Couldn’t create the link. boom')
  })

  it('clears an earlier error when it runs again', async () => {
    const { result } = renderHook(() => useMakeLink())
    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('Not found')))
    })
    const link = deferred<string>()
    act(() => {
      void result.current.run(() => link.promise)
    })
    expect(result.current.error).toBeUndefined()
    await act(async () => link.resolve('u'))
  })

  it('a cancel forgets a link on its way: it resolves with nothing and sets nothing', async () => {
    const link = deferred<string>()
    const { result } = renderHook(() => useMakeLink())
    let made!: Promise<string | undefined>
    act(() => {
      made = result.current.run(() => link.promise)
    })

    act(() => result.current.cancel())
    expect(result.current.making).toBe(false)

    await act(async () => link.resolve('u'))
    await expect(made).resolves.toBeUndefined()
    expect(result.current.making).toBe(false)
  })

  it('a cancel hides a failure that lands afterwards', async () => {
    const link = deferred<string>()
    const { result } = renderHook(() => useMakeLink())
    let made!: Promise<string | undefined>
    act(() => {
      made = result.current.run(() => link.promise)
    })
    act(() => result.current.cancel())

    await act(async () => link.reject(new Error('Server error')))

    await expect(made).resolves.toBeUndefined()
    expect(result.current.error).toBeUndefined()
    expect(result.current.making).toBe(false)
  })

  it('a cancel clears a shown error', async () => {
    const { result } = renderHook(() => useMakeLink())
    await act(async () => {
      await result.current.run(() => Promise.reject(new Error('Not found')))
    })
    act(() => result.current.cancel())
    expect(result.current.error).toBeUndefined()
  })
})
