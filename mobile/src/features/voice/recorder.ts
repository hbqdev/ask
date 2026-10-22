// The microphone for dictation: MediaRecorder captures the take (mp4 where
// supported, as iOS records, else webm) and an AnalyserNode meters it. The
// audio stays in memory; stop() hands it back as one Blob. Both stop and
// cancel stop every track (so iOS drops its recording indicator) and close
// the audio context.

export type Recording = {
  /** Ends the take and gives its audio; calling it again gives the same. */
  stop(): Promise<Blob>
  /** Ends the take and throws the audio away. */
  cancel(): void
  /** The input's loudness now: the RMS of the waveform, 0 to 1. */
  level(): number
}

const MIME_PREFERENCE = ['audio/mp4', 'audio/webm']

/** The first type in the preference this device records, if any. */
export function pickMimeType(): string | undefined {
  return MIME_PREFERENCE.find(type => MediaRecorder.isTypeSupported(type))
}

type Meter = { level(): number; close(): void }

const NO_METER: Meter = { level: () => 0, close() {} }

/** A level meter on the stream; without one if Web Audio fails (no meter, still a recording). */
function openMeter(stream: MediaStream): Meter {
  let context: AudioContext | undefined
  try {
    context = new AudioContext()
    const analyser = context.createAnalyser()
    context.createMediaStreamSource(stream).connect(analyser)
    // Opened after the permission prompt, the context may start suspended.
    context.resume().catch(() => {})
    const samples = new Float32Array(analyser.fftSize)
    const open = context
    return {
      level() {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += sample * sample
        return Math.min(1, Math.sqrt(sum / samples.length))
      },
      close: () => open.close().catch(() => {})
    }
  } catch {
    context?.close().catch(() => {})
    return NO_METER
  }
}

/**
 * Opens the microphone and starts recording. Rejects as getUserMedia does
 * (a NotAllowedError when the user refused), or if no recorder can be made.
 */
export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const stopTracks = () => stream.getTracks().forEach(track => track.stop())

  const mimeType = pickMimeType()
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  } catch (error) {
    stopTracks()
    throw error
  }

  const meter = openMeter(stream)
  let released = false
  const release = () => {
    if (released) return
    released = true
    stopTracks()
    meter.close()
  }

  const chunks: Blob[] = []
  const audio = () => new Blob(chunks, { type: recorder.mimeType || mimeType })
  let onFinished: (() => void) | undefined
  let finished: Promise<Blob> | undefined

  recorder.ondataavailable = e => {
    if (e.data.size) chunks.push(e.data)
  }
  // Also fires when the recorder ends on its own (the track ended).
  recorder.onstop = () => {
    release()
    onFinished?.()
  }
  recorder.start()

  return {
    level: () => (released ? 0 : meter.level()),
    stop() {
      finished ??= new Promise(resolve => {
        if (recorder.state === 'inactive') {
          release()
          return resolve(audio())
        }
        onFinished = () => resolve(audio())
        recorder.stop()
      })
      return finished
    },
    cancel() {
      chunks.length = 0
      recorder.ondataavailable = null
      if (recorder.state !== 'inactive') recorder.stop()
      release()
    }
  }
}
