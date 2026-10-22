// Dictation's state machine, as the web's push-to-talk (hooks/
// use-voice-dictation.ts): start records, stop transcribes and hands the text
// to onText, cancel throws the take (or its transcription) away. A take stops
// itself at 120 s; one under 0.6 s, or silent, is dropped without a request.
// A failure shows for 4 s, then the mic is idle again. Starting stops any
// answer being read aloud, so it never plays into the recording.
//
// Dictation belongs to the screen it started on. Tabs and stacked screens stay
// mounted when left, so leaving it (`active` false), the app going to the
// background, or unmounting all cancel: the microphone closes and any
// transcription is abandoned, so nothing is sent from a screen out of sight.

import { App } from '@capacitor/app'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { isServerUnauthorized, SIGNED_OUT_MESSAGE } from '@/core/api/client'
import { haptic } from '@/core/haptics'
import { startRecording, type Recording } from '@/features/voice/recorder'
import { transcribe } from '@/features/voice/transcribe'
import { stopReading } from '@/features/voice/useReadAloud'

export const MAX_RECORDING_MS = 120_000
export const MIN_RECORDING_MS = 600
export const ERROR_VISIBLE_MS = 4_000
/** How often the meter and timer refresh while recording. */
const TICK_MS = 100

export const PERMISSION_MESSAGE =
  'Allow microphone access in Settings to dictate'
export const MIC_FAILED_MESSAGE = "Couldn't start the microphone"
export const NOTHING_HEARD_MESSAGE = "Didn't catch that"

/** getUserMedia's names for a refused microphone. */
const REFUSALS = new Set(['NotAllowedError', 'SecurityError'])

export type DictationState =
  | 'idle'
  /** The microphone is opening (the permission prompt may be up). */
  | 'starting'
  | 'recording'
  | 'transcribing'
  | 'error'

export type Dictation = {
  state: DictationState
  /** What went wrong, while `state` is 'error'. */
  error?: string
  start(): void
  stop(): void
  /** Abandons whatever is under way: opening, recording or transcribing. */
  cancel(): void
  /** The input level now, 0 to 1, while recording. */
  level: number
  /** Whole seconds recorded so far. */
  seconds: number
}

export type DictationOptions = {
  onText(text: string): void
  /** Whether the screen holding the composer is shown; leaving it cancels. */
  active?: boolean
}

type Take = {
  recording: Recording
  startedAt: number
  tick: ReturnType<typeof setInterval>
  cap: ReturnType<typeof setTimeout>
}

const isRefusal = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  REFUSALS.has((error as { name?: string }).name ?? '')

export function useDictation({
  onText,
  active = true
}: DictationOptions): Dictation {
  const { baseUrl, getToken, handleUnauthorized } = useApi()
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string>()
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)

  const live = useRef({ onText, baseUrl, getToken, handleUnauthorized, active })
  useEffect(() => {
    live.current = { onText, baseUrl, getToken, handleUnauthorized, active }
  }, [onText, baseUrl, getToken, handleUnauthorized, active])

  // The phase, read synchronously so double taps and late callbacks are safe.
  // A failure leaves it idle (the error is only shown).
  const phase = useRef<Exclude<DictationState, 'error'>>('idle')
  // Bumped by every cancel (and unmount): an await that finds it changed
  // gives up, so a late microphone is closed and a late transcript dropped.
  const attempt = useRef(0)
  const take = useRef<Take | null>(null)
  const request = useRef<AbortController | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Whether the app is in the background (between 'pause' and 'resume').
  const backgrounded = useRef(false)

  const endTake = () => {
    const current = take.current!
    take.current = null
    clearInterval(current.tick)
    clearTimeout(current.cap)
    return current
  }

  const fail = useCallback((message: string) => {
    phase.current = 'idle'
    haptic('error')
    setError(message)
    setState('error')
    clearTimeout(errorTimer.current)
    // A new start clears this timer, so it only ever ends the error.
    errorTimer.current = setTimeout(() => {
      setError(undefined)
      setState('idle')
    }, ERROR_VISIBLE_MS)
  }, [])

  /** Abandons what is under way; nothing it started will send. */
  const abandon = useCallback(() => {
    attempt.current++
    if (take.current) endTake().recording.cancel()
    request.current?.abort()
    request.current = null
  }, [])

  const cancel = useCallback(() => {
    if (phase.current === 'idle') return
    abandon()
    phase.current = 'idle'
    setLevel(0)
    setSeconds(0)
    setState('idle')
  }, [abandon])

  const stop = useCallback(async () => {
    if (phase.current !== 'recording') return
    haptic('light')
    const mine = attempt.current
    const { recording, startedAt } = endTake()
    setLevel(0)

    if (Date.now() - startedAt < MIN_RECORDING_MS) {
      recording.cancel()
      phase.current = 'idle'
      setState('idle')
      return
    }

    phase.current = 'transcribing'
    setState('transcribing')
    const audio = await recording.stop()
    if (attempt.current !== mine) return
    if (audio.size === 0) {
      phase.current = 'idle'
      setState('idle')
      return
    }

    const controller = new AbortController()
    request.current = controller
    try {
      const token = await live.current.getToken().catch(() => null)
      if (attempt.current !== mine) return
      if (!token) return fail(SIGNED_OUT_MESSAGE)
      const text = await transcribe({
        baseUrl: live.current.baseUrl,
        token,
        audio,
        signal: controller.signal
      })
      if (attempt.current !== mine) return
      if (!text) return fail(NOTHING_HEARD_MESSAGE)
      phase.current = 'idle'
      setState('idle')
      live.current.onText(text)
    } catch (e) {
      if (attempt.current !== mine) return
      // The server refused the token: refresh, or sign out (app-wide).
      if (isServerUnauthorized(e)) void live.current.handleUnauthorized('first')
      fail((e as Error).message)
    } finally {
      if (request.current === controller) request.current = null
    }
  }, [fail])

  const start = useCallback(async () => {
    if (phase.current !== 'idle' || !live.current.active) return
    phase.current = 'starting'
    const mine = ++attempt.current
    clearTimeout(errorTimer.current)
    setError(undefined)
    setState('starting')
    haptic('medium')
    // No answer read aloud plays into the recording: stop it (or its audio
    // still loading) before the mic opens.
    stopReading()

    let recording: Recording
    try {
      recording = await startRecording()
    } catch (e) {
      if (attempt.current !== mine) return
      fail(isRefusal(e) ? PERMISSION_MESSAGE : MIC_FAILED_MESSAGE)
      return
    }
    // Cancelled, left, or unmounted while the microphone was opening.
    if (attempt.current !== mine) return recording.cancel()
    // The app went to the background while it opened: no mic out of sight.
    if (backgrounded.current) {
      recording.cancel()
      phase.current = 'idle'
      setState('idle')
      return
    }

    phase.current = 'recording'
    const startedAt = Date.now()
    take.current = {
      recording,
      startedAt,
      tick: setInterval(() => {
        setLevel(recording.level())
        setSeconds(Math.floor((Date.now() - startedAt) / 1000))
      }, TICK_MS),
      cap: setTimeout(() => void stop(), MAX_RECORDING_MS)
    }
    setSeconds(0)
    setLevel(0)
    setState('recording')
  }, [fail, stop])

  // Leaving the screen (another tab, or a screen pushed over it) cancels.
  useEffect(() => {
    if (!active) cancel()
  }, [active, cancel])

  // So does the app going inactive. Not while the microphone opens: iOS's
  // first-use permission alert makes the app inactive too. A real trip to the
  // background (`pause`, which the alert does not fire) is remembered, so a
  // microphone that opens meanwhile is closed at once.
  useEffect(() => {
    const handles = [
      App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) return
        if (phase.current === 'recording' || phase.current === 'transcribing') {
          cancel()
        }
      }),
      App.addListener('pause', () => {
        backgrounded.current = true
      }),
      App.addListener('resume', () => {
        backgrounded.current = false
      })
    ]
    return () => {
      handles.forEach(handle => void handle.then(h => h.remove()))
    }
  }, [cancel])

  useEffect(
    () => () => {
      abandon()
      clearTimeout(errorTimer.current)
    },
    [abandon]
  )

  return {
    state,
    error,
    start: () => void start(),
    stop: () => void stop(),
    cancel,
    level,
    seconds
  }
}
