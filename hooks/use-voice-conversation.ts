'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { SpeechDetector } from '@/lib/voice/vad'
import { encodeWav } from '@/lib/voice/wav'

export type ConversationPhase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error'
export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error'

export interface VoiceConversationDeps {
  createDetector: (cb: {
    onSpeechStart: () => void
    onSpeechEnd: (pcm: Float32Array) => void
  }) => Promise<SpeechDetector>
  transcribe: (wav: Blob, signal: AbortSignal) => Promise<string>
  condense: (answer: string, signal: AbortSignal) => Promise<string>
  speak: (text: string) => Promise<void>
  stopSpeaking: () => void
  submit: (text: string) => void
  chatStatus: ChatStatus
  answer: { key: string; text: string } | null
}

export interface VoiceConversationApi {
  phase: ConversationPhase
  transcript: string
  errorText: string | null
  muted: boolean
  setMuted: (m: boolean) => void
  end: () => void
}

const ERROR_HOLD_MS = 1500

export function useVoiceConversation(
  active: boolean,
  deps: VoiceConversationDeps
): VoiceConversationApi {
  const d = useRef(deps)
  d.current = deps

  const [phase, setPhaseState] = useState<ConversationPhase>('idle')
  const [transcript, setTranscript] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [muted, setMutedState] = useState(false)

  const phaseRef = useRef<ConversationPhase>('idle')
  const setPhase = useCallback((p: ConversationPhase) => {
    phaseRef.current = p
    setPhaseState(p)
  }, [])

  const detectorRef = useRef<SpeechDetector | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const spokenKeyRef = useRef<string | null>(null)
  const mutedRef = useRef(false)
  const liveRef = useRef(false)

  const listen = useCallback(() => {
    if (!liveRef.current) return
    setPhase('listening')
    if (!mutedRef.current) detectorRef.current?.start()
  }, [setPhase])

  const onSpeechEnd = useCallback(
    async (pcm: Float32Array) => {
      if (phaseRef.current !== 'listening' || mutedRef.current) return
      detectorRef.current?.pause()
      setPhase('transcribing')
      const ac = new AbortController()
      abortRef.current = ac
      let text = ''
      try {
        text = (await d.current.transcribe(encodeWav(pcm), ac.signal)).trim()
      } catch {
        text = ''
      }
      if (!liveRef.current) return
      if (!text) {
        listen()
        return
      }
      setTranscript(text)
      spokenKeyRef.current = null // expect a fresh answer for this turn
      d.current.submit(text)
      setPhase('thinking')
    },
    [listen, setPhase]
  )

  // Lifecycle: arm on active, tear down on inactive/unmount.
  useEffect(() => {
    if (!active) return
    liveRef.current = true
    setErrorText(null)
    let cancelled = false
    d.current
      .createDetector({ onSpeechStart: () => {}, onSpeechEnd })
      .then(det => {
        if (cancelled) {
          det.destroy()
          return
        }
        detectorRef.current = det
        setPhase('listening')
        if (!mutedRef.current) det.start()
      })
      .catch(() => {
        setErrorText('Microphone unavailable.')
        setPhase('error')
      })
    return () => {
      cancelled = true
      liveRef.current = false
      abortRef.current?.abort()
      d.current.stopSpeaking()
      detectorRef.current?.destroy()
      detectorRef.current = null
      setPhase('idle')
    }
  }, [active, onSpeechEnd, setPhase])

  // React to the streamed answer / chat errors while thinking.
  useEffect(() => {
    if (phaseRef.current !== 'thinking') return
    if (deps.chatStatus === 'error') {
      setErrorText('Something went wrong.')
      setPhase('error')
      const t = setTimeout(() => {
        setErrorText(null)
        listen()
      }, ERROR_HOLD_MS)
      return () => clearTimeout(t)
    }
    const ans = deps.answer
    if (
      deps.chatStatus === 'ready' &&
      ans &&
      ans.key !== spokenKeyRef.current
    ) {
      spokenKeyRef.current = ans.key
      setPhase('speaking')
      const ac = new AbortController()
      abortRef.current = ac
      ;(async () => {
        let gist = ''
        try {
          gist = (await d.current.condense(ans.text, ac.signal)).trim()
        } catch {
          gist = ''
        }
        if (!liveRef.current) return
        try {
          if (gist) await d.current.speak(gist)
        } catch {
          /* fail-open: fall through to listening */
        }
        if (liveRef.current) listen()
      })()
    }
  }, [deps.answer, deps.chatStatus, listen, setPhase])

  const setMuted = useCallback((m: boolean) => {
    mutedRef.current = m
    setMutedState(m)
    if (m) detectorRef.current?.pause()
    else if (phaseRef.current === 'listening') detectorRef.current?.start()
  }, [])

  const end = useCallback(() => {
    liveRef.current = false
    abortRef.current?.abort()
    d.current.stopSpeaking()
    detectorRef.current?.destroy()
    detectorRef.current = null
    setPhase('idle')
  }, [setPhase])

  return { phase, transcript, errorText, muted, setMuted, end }
}
