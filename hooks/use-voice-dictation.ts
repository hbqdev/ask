'use client'
import { useCallback, useRef, useState } from 'react'

type DictationState = 'idle' | 'recording' | 'transcribing'

// Push-to-talk capture: start() opens the mic and records; stop() finalizes,
// POSTs the audio to /api/voice/transcribe, and resolves the transcript via
// onTranscript. Fail-quiet: any error returns to idle so the mic UI never
// wedges and typing is always available (mirrors use-speech-playback).
export function useVoiceDictation(onTranscript: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  // Set by stop() when it fires before the recorder exists (user released the
  // button during the first-use permission prompt). Tells the in-flight start()
  // to release the mic instead of recording — closes the "hot mic" race.
  const cancelledRef = useRef(false)

  const start = useCallback(async () => {
    cancelledRef.current = false
    let stream: MediaStream | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (cancelledRef.current) {
        // Released during the permission prompt: never open the recorder, and
        // stop the tracks so the mic goes cold immediately.
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null
        cancelledRef.current = false
        setState('idle')
        return
      }
      streamRef.current = stream
      const recorder = new MediaRecorder(stream)
      chunksRef.current = []
      recorder.ondataavailable = e => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach(t => t.stop())
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm'
        })
        if (blob.size === 0) {
          setState('idle')
          return
        }
        setState('transcribing')
        try {
          const form = new FormData()
          form.append('file', blob, 'audio.webm')
          const res = await fetch('/api/voice/transcribe', {
            method: 'POST',
            body: form
          })
          if (res.ok) {
            const { text } = await res.json()
            if (typeof text === 'string' && text.trim()) {
              onTranscript(text.trim())
            }
          }
        } catch {
          /* fail-quiet: dictation is additive; typing still works */
        }
        setState('idle')
      }
      recorder.start()
      recorderRef.current = recorder
      setState('recording')
    } catch {
      // If getUserMedia opened the mic before MediaRecorder construction threw,
      // release the tracks so a failed start never leaves the mic live.
      stream?.getTracks().forEach(t => t.stop())
      setState('idle')
    }
  }, [onTranscript])

  const stop = useCallback(() => {
    const r = recorderRef.current
    if (r && r.state !== 'inactive') {
      r.stop()
    } else {
      // Recorder not created yet (still awaiting the permission prompt): tell
      // the in-flight start() to abandon and release the mic once it resolves.
      cancelledRef.current = true
    }
  }, [])

  return { state, start, stop }
}
