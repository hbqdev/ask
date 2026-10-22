// Reading one message aloud: tap to read, tap again (while the audio loads or
// plays) to stop. The answer is cleaned for speech, fetched in the saved voice
// and speed, and played on the app's single player, so starting one reading
// stops any other. A failure shows for 4 s, then the control is idle again.
//
// A reading belongs to the screen it was started on. Tabs and stacked screens
// stay mounted when left, so useStopReadingOnLeave stops a screen's readings
// when it is left, when the app goes to the background, and when it goes away.

import { App } from '@capacitor/app'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { isServerUnauthorized, SIGNED_OUT_MESSAGE } from '@/core/api/client'
import { haptic } from '@/core/haptics'
import {
  onStateChange,
  play,
  playingOwner,
  speak,
  speakableText,
  stop
} from '@/features/voice/speech'
import { loadVoiceSettings } from '@/features/voice/voice-settings'

export const ERROR_VISIBLE_MS = 4_000
export const PLAY_FAILED_MESSAGE = 'Couldn’t play the audio'

export type ReadAloudState = 'idle' | 'loading' | 'playing' | 'error'

export type ReadAloud = {
  state: ReadAloudState
  /** What went wrong, while `state` is 'error'. */
  error?: string
  /** Reads `text` aloud, or stops while its audio loads or plays. */
  toggle(text: string): void
  /** Reads `text` aloud, from the start, whatever is under way. */
  read(text: string): void
}

/** Matches the owners (message ids) a caller may stop. */
export type Owns = (owner: string) => boolean

const everyone: Owns = () => true

// The reading whose audio is being fetched, app-wide: at most one.
let pending: { owner: string; controller: AbortController } | null = null

/**
 * Stops the readings `owns` matches (all by default): cancels one whose
 * audio is loading and stops one that is playing.
 */
export function stopReading(owns: Owns = everyone): void {
  if (pending && owns(pending.owner)) {
    pending.controller.abort()
    pending = null
  }
  const owner = playingOwner()
  if (owner !== null && owns(owner)) stop()
}

const subscribe = (onChange: () => void) => onStateChange(() => onChange())

type Phase = 'idle' | 'loading' | 'error'

export function useReadAloud(owner: string): ReadAloud {
  const { baseUrl, getToken, handleUnauthorized } = useApi()
  const playing = useSyncExternalStore(
    subscribe,
    () => playingOwner() === owner
  )
  const [phase, setPhaseState] = useState<Phase>('idle')
  const [error, setError] = useState<string>()

  const live = useRef({ baseUrl, getToken, handleUnauthorized })
  useEffect(() => {
    live.current = { baseUrl, getToken, handleUnauthorized }
  }, [baseUrl, getToken, handleUnauthorized])

  // The phase, read synchronously so a quick second tap sees the first.
  const phaseRef = useRef<Phase>('idle')
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])
  // Bumped by every start and stop: a reading that finds it changed was
  // superseded and leaves the state alone.
  const attempt = useRef(0)
  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const fail = useCallback(
    (message: string) => {
      haptic('error')
      setError(message)
      setPhase('error')
      clearTimeout(errorTimer.current)
      errorTimer.current = setTimeout(() => {
        setError(undefined)
        setPhase('idle')
      }, ERROR_VISIBLE_MS)
    },
    [setPhase]
  )

  const read = useCallback(
    async (text: string) => {
      const spoken = speakableText(text)
      if (!spoken) return
      stopReading()
      const mine = ++attempt.current
      const controller = new AbortController()
      pending = { owner, controller }
      clearTimeout(errorTimer.current)
      setError(undefined)
      setPhase('loading')

      const superseded = () => attempt.current !== mine
      // Cancelled from elsewhere (another reading, or the screen was left).
      const cancelled = () => {
        if (!superseded()) setPhase('idle')
      }

      // While this reading loads, `pending` is its own: anything that ends it
      // aborts the controller first.
      let blob: Blob
      try {
        const [token, { voice, speed }] = await Promise.all([
          live.current.getToken().catch(() => null),
          loadVoiceSettings()
        ])
        if (controller.signal.aborted) return cancelled()
        if (!token) throw new Error(SIGNED_OUT_MESSAGE)
        blob = await speak({
          baseUrl: live.current.baseUrl,
          token,
          text: spoken,
          voice,
          speed,
          signal: controller.signal
        })
      } catch (e) {
        if (controller.signal.aborted) return cancelled()
        pending = null
        // The server refused the token: refresh, or sign out (app-wide).
        if (isServerUnauthorized(e))
          void live.current.handleUnauthorized('first')
        return fail((e as Error).message)
      }
      if (controller.signal.aborted) return cancelled()
      pending = null

      // A stop or another reading meanwhile makes play() resolve, not reject.
      try {
        await play(blob, owner)
      } catch {
        return fail(PLAY_FAILED_MESSAGE)
      }
      // Playing now (or stopped already): the player's state says which.
      // Unless a new reading of this message has begun meanwhile.
      if (!superseded()) setPhase('idle')
    },
    [owner, fail, setPhase]
  )

  const stopOwn = useCallback(() => {
    attempt.current++
    stopReading(o => o === owner)
  }, [owner])

  const toggle = useCallback(
    (text: string) => {
      haptic('light')
      if (phaseRef.current === 'loading' || playingOwner() === owner) {
        stopOwn()
        setPhase('idle')
        return
      }
      void read(text)
    },
    [owner, read, stopOwn, setPhase]
  )

  // Going away stops this message's reading.
  useEffect(
    () => () => {
      stopOwn()
      clearTimeout(errorTimer.current)
    },
    [stopOwn]
  )

  const state: ReadAloudState =
    phase === 'loading'
      ? 'loading'
      : playing
        ? 'playing'
        : phase === 'error'
          ? 'error'
          : 'idle'

  return {
    state,
    error: state === 'error' ? error : undefined,
    toggle,
    read: useCallback((text: string) => void read(text), [read])
  }
}

/**
 * Stops the readings `owns` matches when the screen showing them is left
 * (`active` turns false), when the app goes to the background, and when the
 * screen goes away.
 */
export function useStopReadingOnLeave(active: boolean, owns: Owns): void {
  const ownsRef = useRef(owns)
  useEffect(() => {
    ownsRef.current = owns
  }, [owns])

  useEffect(() => {
    if (!active) stopReading(o => ownsRef.current(o))
  }, [active])

  useEffect(() => {
    const handle = App.addListener('pause', () =>
      stopReading(o => ownsRef.current(o))
    )
    return () => {
      void handle.then(h => h.remove())
      stopReading(o => ownsRef.current(o))
    }
  }, [])
}
