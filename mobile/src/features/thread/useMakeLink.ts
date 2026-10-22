// Making a chat's link while a sheet (the chat menu, an answer's share
// choice) stays open: whether it is on its way, and why it failed, said in
// that sheet. Closing the sheet cancels: a link that lands afterwards is
// forgotten, so it opens no share sheet and says nothing.

import { useCallback, useRef, useState } from 'react'

import { reasonOf } from '@/features/thread/share-api'

export type MakeLink = {
  /** A link is on its way. */
  making: boolean
  /** Why the last link could not be made. */
  error?: string
  /**
   * Makes the link with `make`; resolves with it, or with undefined when it
   * failed (`error` says why) or was cancelled meanwhile.
   */
  run<T>(make: () => Promise<T>): Promise<T | undefined>
  /** Forgets any link on its way, and clears the state. */
  cancel(): void
}

export function useMakeLink(): MakeLink {
  const [making, setMaking] = useState(false)
  const [error, setError] = useState<string>()
  // Bumped by each run and cancel; a link from an older one is forgotten.
  const current = useRef(0)

  const run = useCallback(async <T>(make: () => Promise<T>) => {
    const mine = ++current.current
    setError(undefined)
    setMaking(true)
    let value: T
    try {
      value = await make()
    } catch (e) {
      if (mine === current.current) {
        setMaking(false)
        setError(`Couldn’t create the link. ${reasonOf(e)}`)
      }
      return undefined
    }
    if (mine !== current.current) return undefined
    setMaking(false)
    return value
  }, [])

  const cancel = useCallback(() => {
    current.current++
    setMaking(false)
    setError(undefined)
  }, [])

  return { making, error, run, cancel }
}
