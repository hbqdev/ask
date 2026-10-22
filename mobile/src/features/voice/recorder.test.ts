import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { pickMimeType, startRecording } from '@/features/voice/recorder'

class FakeTrack {
  stopped = false
  stop() {
    this.stopped = true
  }
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()]
  getTracks() {
    return this.tracks
  }
}

/** A stand-in MediaRecorder: stop() delivers `data`, then the stop event. */
class FakeRecorder {
  static supported = new Set(['audio/mp4', 'audio/webm'])
  static last: FakeRecorder | undefined
  static throwOnCreate = false
  static isTypeSupported(type: string) {
    return FakeRecorder.supported.has(type)
  }

  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  data: Blob[] = [new Blob(['voice'], { type: 'audio/mp4' })]
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  stops = 0

  constructor(
    public stream: FakeStream,
    public options?: { mimeType?: string }
  ) {
    if (FakeRecorder.throwOnCreate) throw new Error('not supported')
    this.mimeType = options?.mimeType ?? ''
    FakeRecorder.last = this
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.stops++
    this.state = 'inactive'
    // Like the browser: the data and the stop event come a moment later.
    queueMicrotask(() => {
      for (const data of this.data) this.ondataavailable?.({ data })
      this.onstop?.()
    })
  }
  /** The recorder stopping on its own (the track ended). */
  end() {
    this.state = 'inactive'
    for (const data of this.data) this.ondataavailable?.({ data })
    this.onstop?.()
  }
}

class FakeAudioContext {
  static last: FakeAudioContext | undefined
  static throwOnCreate = false
  static sample = 0
  closed = 0
  resumed = 0
  connected: unknown[] = []
  source: { connect: (node: unknown) => void } | undefined

  constructor() {
    if (FakeAudioContext.throwOnCreate) throw new Error('no audio')
    FakeAudioContext.last = this
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      getFloatTimeDomainData(buffer: Float32Array) {
        buffer.fill(FakeAudioContext.sample)
      }
    }
  }
  createMediaStreamSource(stream: FakeStream) {
    expect(stream).toBeInstanceOf(FakeStream)
    this.source = { connect: node => this.connected.push(node) }
    return this.source
  }
  resume() {
    this.resumed++
    return Promise.resolve()
  }
  close() {
    this.closed++
    return Promise.resolve()
  }
}

let stream: FakeStream
const getUserMedia = vi.fn()

beforeEach(() => {
  stream = new FakeStream()
  getUserMedia.mockReset()
  getUserMedia.mockImplementation(async () => stream)
  FakeRecorder.supported = new Set(['audio/mp4', 'audio/webm'])
  FakeRecorder.last = undefined
  FakeRecorder.throwOnCreate = false
  FakeAudioContext.last = undefined
  FakeAudioContext.throwOnCreate = false
  FakeAudioContext.sample = 0
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const allStopped = () => stream.tracks.every(t => t.stopped)

describe('pickMimeType', () => {
  it('prefers audio/mp4', () => {
    expect(pickMimeType()).toBe('audio/mp4')
  })

  it('falls back to audio/webm', () => {
    FakeRecorder.supported = new Set(['audio/webm'])
    expect(pickMimeType()).toBe('audio/webm')
  })

  it('leaves the choice to the browser when neither is supported', () => {
    FakeRecorder.supported = new Set()
    expect(pickMimeType()).toBeUndefined()
  })
})

describe('startRecording', () => {
  it('asks for the microphone and records in the preferred type', async () => {
    await startRecording()
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({ audio: true })
    expect(FakeRecorder.last!.stream).toBe(stream)
    expect(FakeRecorder.last!.options).toEqual({ mimeType: 'audio/mp4' })
    expect(FakeRecorder.last!.state).toBe('recording')
  })

  it('records in webm where mp4 is not supported', async () => {
    FakeRecorder.supported = new Set(['audio/webm'])
    await startRecording()
    expect(FakeRecorder.last!.options).toEqual({ mimeType: 'audio/webm' })
  })

  it('passes no type when neither is supported', async () => {
    FakeRecorder.supported = new Set()
    await startRecording()
    expect(FakeRecorder.last!.options).toBeUndefined()
  })

  it('passes on a refused microphone', async () => {
    const denied = new DOMException('denied', 'NotAllowedError')
    getUserMedia.mockRejectedValueOnce(denied)
    await expect(startRecording()).rejects.toBe(denied)
    expect(FakeRecorder.last).toBeUndefined()
  })

  it('stops the tracks when the recorder cannot be made', async () => {
    FakeRecorder.throwOnCreate = true
    await expect(startRecording()).rejects.toThrow('not supported')
    expect(allStopped()).toBe(true)
  })

  it('tracks are stopped after recording: stop gives the audio in its type', async () => {
    const recording = await startRecording()
    expect(allStopped()).toBe(false)

    const audio = await recording.stop()
    expect(audio.type).toBe('audio/mp4')
    expect(await audio.text()).toBe('voice')
    expect(allStopped()).toBe(true)
    expect(FakeAudioContext.last!.closed).toBe(1)
  })

  it('stop twice gives the same audio and stops the recorder once', async () => {
    const recording = await startRecording()
    const first = recording.stop()
    const second = recording.stop()
    expect(await second).toBe(await first)
    expect(FakeRecorder.last!.stops).toBe(1)
    expect(FakeAudioContext.last!.closed).toBe(1)
  })

  it('leaves out empty chunks, so a silent recorder gives an empty blob', async () => {
    const recording = await startRecording()
    FakeRecorder.last!.data = [new Blob([])]
    const audio = await recording.stop()
    expect(audio.size).toBe(0)
  })

  it('types the audio as the recorder reports, else as asked', async () => {
    FakeRecorder.supported = new Set()
    const recording = await startRecording()
    FakeRecorder.last!.mimeType = 'audio/webm;codecs=opus'
    expect((await recording.stop()).type).toBe('audio/webm;codecs=opus')

    FakeRecorder.supported = new Set(['audio/webm'])
    const second = await startRecording()
    FakeRecorder.last!.mimeType = ''
    expect((await second.stop()).type).toBe('audio/webm')
  })

  it('a recorder that ended on its own still gives its audio on stop', async () => {
    const recording = await startRecording()
    FakeRecorder.last!.end()
    expect(allStopped()).toBe(true)

    const audio = await recording.stop()
    expect(await audio.text()).toBe('voice')
    expect(FakeRecorder.last!.stops).toBe(0)
    expect(FakeAudioContext.last!.closed).toBe(1)
  })

  it('tracks are stopped after recording: cancel discards it', async () => {
    const recording = await startRecording()
    recording.cancel()
    expect(allStopped()).toBe(true)
    expect(FakeRecorder.last!.stops).toBe(1)
    expect(FakeAudioContext.last!.closed).toBe(1)

    // A second cancel, or a cancel after the recorder stopped, does nothing more.
    await Promise.resolve()
    recording.cancel()
    expect(FakeRecorder.last!.stops).toBe(1)
    expect(FakeAudioContext.last!.closed).toBe(1)
  })

  it('level is the RMS of the analyser, between 0 and 1', async () => {
    const recording = await startRecording()
    const context = FakeAudioContext.last!
    expect(context.connected).toHaveLength(1)
    expect(context.resumed).toBe(1)

    FakeAudioContext.sample = 0.25
    expect(recording.level()).toBeCloseTo(0.25)
    FakeAudioContext.sample = -0.5
    expect(recording.level()).toBeCloseTo(0.5)
    FakeAudioContext.sample = 3
    expect(recording.level()).toBe(1)

    recording.cancel()
    expect(recording.level()).toBe(0)
  })

  it('records without a meter when the audio context fails', async () => {
    FakeAudioContext.throwOnCreate = true
    const recording = await startRecording()
    expect(recording.level()).toBe(0)
    expect(await (await recording.stop()).text()).toBe('voice')
    expect(allStopped()).toBe(true)
  })

  it('closes a context whose analyser could not be wired', async () => {
    const createSource = vi
      .spyOn(FakeAudioContext.prototype, 'createMediaStreamSource')
      .mockImplementation(() => {
        throw new Error('no source')
      })
    // A close that fails as well is ignored.
    const close = vi
      .spyOn(FakeAudioContext.prototype, 'close')
      .mockRejectedValueOnce(new Error('no'))
    const recording = await startRecording()
    expect(close).toHaveBeenCalledTimes(1)
    expect(recording.level()).toBe(0)
    recording.cancel()
    expect(close).toHaveBeenCalledTimes(1)
    expect(allStopped()).toBe(true)
    createSource.mockRestore()
    close.mockRestore()
  })

  it('ignores a context that fails to resume or close', async () => {
    vi.spyOn(FakeAudioContext.prototype, 'resume').mockRejectedValueOnce(
      new Error('no')
    )
    vi.spyOn(FakeAudioContext.prototype, 'close').mockRejectedValueOnce(
      new Error('no')
    )
    const recording = await startRecording()
    recording.cancel()
    await Promise.resolve()
    expect(allStopped()).toBe(true)
    vi.restoreAllMocks()
  })
})
