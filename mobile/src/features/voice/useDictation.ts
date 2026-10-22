// Dictation's state machine, as the web's push-to-talk (hooks/
// use-voice-dictation.ts): start records, stop transcribes and hands the text
// to onText, cancel throws the take away. A take stops itself at 120 s; one
// under 0.6 s, or silent, is dropped without a request. A failure shows for
// 4 s, then the mic is idle again. Leaving the screen stops the microphone and
// abandons any transcription.

import { useCallback, useEffect, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { SIGNED_OUT_MESSAGE } from '@/core/api/client'
import { haptic } from '@/core/haptics'
import { startRecording, type Recording } from '@/features/voice/recorder'
import { transcribe } from '@/features/voice/transcribe'

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

export type DictationState = 'idle' | 'recording' | 'transcribing' | 'error'

export type Dictation = {
  state: DictationState
  /** What went wrong, while `state` is 'error'. */
  error?: string
  start(): void
  stop(): void
  cancel(): void
  /** The input level now, 0 to 1, while recording. */
  level: number
  /** Whole seconds recorded so far. */
  seconds: number
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
  onText
}: {
  onText(text: string): void
}): Dictation {
  const { baseUrl, getToken } = useApi()
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string>()
  const [level, setLevel] = useState(0)
  const [seconds, setSeconds] = useState(0)

  const live = useRef({ onText, baseUrl, getToken })
  useEffect(() => {
    live.current = { onText, baseUrl, getToken }
  }, [onText, baseUrl, getToken])

  // The phase, read synchronously so double taps and late callbacks are safe.
  const phase = useRef<'idle' | 'starting' | 'recording' | 'transcribing'>(
    'idle'
  )
  // Bumped by a cancel or unmount, so a start still opening the mic gives up.
  const attempt = useRef(0)
  const mounted = useRef(true)
  const take = useRef<Take | null>(null)
  const request = useRef<AbortController | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

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

  const stop = useCallback(async () => {
    if (phase.current !== 'recording') return
    haptic('light')
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
    if (!mounted.current) return
    if (audio.size === 0) {
      phase.current = 'idle'
      setState('idle')
      return
    }

    const controller = new AbortController()
    request.current = controller
    try {
      const token = await live.current.getToken().catch(() => null)
      if (controller.signal.aborted) return
      if (!token) return fail(SIGNED_OUT_MESSAGE)
      const text = await transcribe({
        baseUrl: live.current.baseUrl,
        token,
        audio,
        signal: controller.signal
      })
      if (!text) return fail(NOTHING_HEARD_MESSAGE)
      phase.current = 'idle'
      setState('idle')
      live.current.onText(text)
    } catch (e) {
      if (controller.signal.aborted) return
      fail((e as Error).message)
    } finally {
      request.current = null
    }
  }, [fail])

  const start = useCallback(async () => {
    if (phase.current !== 'idle') return
    phase.current = 'starting'
    const mine = ++attempt.current
    clearTimeout(errorTimer.current)
    setError(undefined)
    setState('idle')
    haptic('medium')

    let recording: Recording
    try {
      recording = await startRecording()
    } catch (e) {
      if (attempt.current !== mine) return
      fail(isRefusal(e) ? PERMISSION_MESSAGE : MIC_FAILED_MESSAGE)
      return
    }
    // Cancelled, or the screen left, while the microphone was opening.
    if (attempt.current !== mine) return recording.cancel()

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

  const cancel = useCallback(() => {
    if (phase.current === 'starting') {
      attempt.current++
      phase.current = 'idle'
      return
    }
    if (phase.current !== 'recording') return
    endTake().recording.cancel()
    phase.current = 'idle'
    setLevel(0)
    setSeconds(0)
    setState('idle')
  }, [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      attempt.current++
      if (take.current) endTake().recording.cancel()
      request.current?.abort()
      clearTimeout(errorTimer.current)
    }
  }, [])

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
