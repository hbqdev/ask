'use client'
import { useCallback, useRef, useState } from 'react'

type DictationState = 'idle' | 'recording' | 'transcribing'

// Click-to-toggle mic capture. start() opens the mic and records; stop()
// finalizes and POSTs the audio to /api/voice/transcribe, resolving the
// transcript via onTranscript; cancel() discards the take. The live MediaStream
// is exposed so a waveform can visualize input. Fail-quiet: any error returns to
// idle so the UI never wedges and typing is always available.
export function useVoiceDictation(onTranscript: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  // stop() = finish + transcribe; cancel() = discard. onstop reads this.
  const discardRef = useRef(false)
  // Press-and-hold can release before the recorder exists (the getUserMedia
  // permission prompt is still open). stop()/cancel() flag this so start() aborts
  // once the stream resolves instead of leaving a hot mic with no way to stop it.
  const pendingStopRef = useRef(false)

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setStream(null)
  }, [])

  const start = useCallback(async () => {
    // Guard a double-start (two quick clicks before the recorder exists).
    if (recorderRef.current) return
    discardRef.current = false
    pendingStopRef.current = false
    let s: MediaStream | undefined
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: true })
      // A hold released (or a cancel) while the permission prompt was open: abort
      // before going live so the mic never opens with no way to stop it.
      if (pendingStopRef.current) {
        s.getTracks().forEach(t => t.stop())
        streamRef.current = null
        setStream(null)
        setState('idle')
        pendingStopRef.current = false
        return
      }
      streamRef.current = s
      setStream(s)
      const recorder = new MediaRecorder(s)
      chunksRef.current = []
      recorder.ondataavailable = e => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        recorderRef.current = null
        releaseStream()
        if (discardRef.current) {
          setState('idle')
          return
        }
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
      // getUserMedia denied, or MediaRecorder construction threw after the mic
      // opened — release any tracks so a failed start never leaves the mic live.
      s?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      setStream(null)
      setState('idle')
    }
  }, [onTranscript, releaseStream])

  const stop = useCallback(() => {
    discardRef.current = false
    const r = recorderRef.current
    if (r && r.state !== 'inactive') {
      r.stop()
    } else {
      // Recorder not built yet (start() pending): tell start() to abort on resolve.
      pendingStopRef.current = true
    }
  }, [])

  const cancel = useCallback(() => {
    discardRef.current = true
    const r = recorderRef.current
    if (r && r.state !== 'inactive') {
      r.stop()
    } else if (streamRef.current) {
      releaseStream()
      setState('idle')
    } else {
      // Recorder not built yet (start() pending): tell start() to abort on resolve.
      pendingStopRef.current = true
    }
  }, [releaseStream])

  return { state, stream, start, stop, cancel }
}
