import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { ApiError } from '@/core/api/errors'
import { haptic } from '@/core/haptics'
import { startRecording, type Recording } from '@/features/voice/recorder'
import { transcribe } from '@/features/voice/transcribe'
import {
  ERROR_VISIBLE_MS,
  MAX_RECORDING_MS,
  MIC_FAILED_MESSAGE,
  NOTHING_HEARD_MESSAGE,
  PERMISSION_MESSAGE,
  useDictation
} from '@/features/voice/useDictation'

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))
vi.mock('@/features/voice/recorder', () => ({ startRecording: vi.fn() }))
vi.mock('@/features/voice/transcribe', () => ({ transcribe: vi.fn() }))

type AppStateListener = (state: { isActive: boolean }) => void
const app = vi.hoisted(() => ({
  listeners: [] as Array<(state: { isActive: boolean }) => void>
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, listener: AppStateListener) => {
      app.listeners.push(listener)
      return {
        remove: async () => {
          const i = app.listeners.indexOf(listener)
          if (i >= 0) app.listeners.splice(i, 1)
        }
      }
    })
  }
}))

/** The app going to the background (false) or coming back (true). */
const appActive = (isActive: boolean) =>
  act(async () => app.listeners.forEach(l => l({ isActive })))

const BASE = 'https://ask.test.invalid'
const getToken = vi.fn<() => Promise<string | null>>()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const voice = new Blob(['voice'], { type: 'audio/mp4' })

function fakeRecording(audio: Blob = voice) {
  return {
    stop: vi.fn(async () => audio),
    cancel: vi.fn(),
    level: vi.fn(() => 0.3)
  } satisfies Recording
}

let recording: ReturnType<typeof fakeRecording>

beforeEach(() => {
  app.listeners.length = 0
  vi.useFakeTimers()
  vi.mocked(haptic).mockClear()
  getToken.mockReset()
  getToken.mockResolvedValue('tok')
  vi.mocked(useApi).mockReturnValue({
    baseUrl: BASE,
    getToken,
    client: {}
  } as unknown as Api)
  recording = fakeRecording()
  vi.mocked(startRecording).mockReset()
  vi.mocked(startRecording).mockImplementation(async () => recording)
  vi.mocked(transcribe).mockReset()
  vi.mocked(transcribe).mockResolvedValue('why is the sky blue')
})

afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  const onText = vi.fn()
  const hook = renderHook(props => useDictation(props), {
    initialProps: { onText, active: true }
  })
  /** The screen being left (false) or shown again (true). */
  const setActive = (active: boolean) => hook.rerender({ onText, active })
  return { ...hook, onText, setActive }
}

const flush = () => act(async () => {})
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

async function startIt(result: { current: ReturnType<typeof useDictation> }) {
  await act(async () => result.current.start())
}

async function stopIt(result: { current: ReturnType<typeof useDictation> }) {
  await act(async () => result.current.stop())
}

describe('useDictation', () => {
  it('runs idle → recording → transcribing → idle and hands over the text', async () => {
    const pending = deferred<string>()
    vi.mocked(transcribe).mockReturnValueOnce(pending.promise)
    const { result, onText } = setup()
    expect(result.current.state).toBe('idle')
    expect(result.current.seconds).toBe(0)
    expect(result.current.level).toBe(0)

    await startIt(result)
    expect(result.current.state).toBe('recording')
    expect(haptic).toHaveBeenCalledExactlyOnceWith('medium')

    await advance(2_300)
    expect(result.current.seconds).toBe(2)
    expect(result.current.level).toBe(0.3)

    await stopIt(result)
    expect(result.current.state).toBe('transcribing')
    expect(result.current.level).toBe(0)
    expect(haptic).toHaveBeenLastCalledWith('light')
    expect(recording.stop).toHaveBeenCalledTimes(1)
    expect(transcribe).toHaveBeenCalledExactlyOnceWith({
      baseUrl: BASE,
      token: 'tok',
      audio: voice,
      signal: expect.any(AbortSignal)
    })

    await act(async () => pending.resolve('why is the sky blue'))
    expect(result.current.state).toBe('idle')
    expect(result.current.error).toBeUndefined()
    expect(onText).toHaveBeenCalledExactlyOnceWith('why is the sky blue')

    // The timer stopped with the recording.
    await advance(5_000)
    expect(result.current.seconds).toBe(2)
  })

  it('an empty recording is not sent', async () => {
    recording = fakeRecording(new Blob([], { type: 'audio/mp4' }))
    const { result, onText } = setup()
    await startIt(result)
    await advance(3_000)
    await stopIt(result)

    expect(result.current.state).toBe('idle')
    expect(transcribe).not.toHaveBeenCalled()
    expect(onText).not.toHaveBeenCalled()
  })

  it('discards a recording under 0.6 s without a request', async () => {
    const { result, onText } = setup()
    await startIt(result)
    await advance(500)
    await stopIt(result)

    expect(result.current.state).toBe('idle')
    expect(recording.cancel).toHaveBeenCalledTimes(1)
    expect(recording.stop).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(onText).not.toHaveBeenCalled()

    // 0.6 s is long enough.
    recording = fakeRecording()
    await startIt(result)
    await advance(600)
    await stopIt(result)
    expect(transcribe).toHaveBeenCalledTimes(1)
  })

  it('stops by itself at 120 s', async () => {
    const { result, onText } = setup()
    await startIt(result)
    await advance(MAX_RECORDING_MS - 1)
    expect(result.current.state).toBe('recording')
    expect(result.current.seconds).toBe(119)
    expect(recording.stop).not.toHaveBeenCalled()

    await advance(1)
    expect(MAX_RECORDING_MS).toBe(120_000)
    expect(recording.stop).toHaveBeenCalledTimes(1)
    expect(haptic).toHaveBeenLastCalledWith('light')
    expect(onText).toHaveBeenCalledExactlyOnceWith('why is the sky blue')
    expect(result.current.state).toBe('idle')
  })

  it('permission denied shows a message, for 4 s', async () => {
    vi.mocked(startRecording).mockRejectedValueOnce(
      new DOMException('denied', 'NotAllowedError')
    )
    const { result } = setup()
    await startIt(result)

    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe(PERMISSION_MESSAGE)
    expect(PERMISSION_MESSAGE).toBe(
      'Allow microphone access in Settings to dictate'
    )
    expect(haptic).toHaveBeenLastCalledWith('error')

    await advance(ERROR_VISIBLE_MS - 1)
    expect(result.current.state).toBe('error')
    await advance(1)
    expect(ERROR_VISIBLE_MS).toBe(4_000)
    expect(result.current.state).toBe('idle')
    expect(result.current.error).toBeUndefined()
  })

  it('a security error is a refusal too; anything else could not start', async () => {
    vi.mocked(startRecording)
      .mockRejectedValueOnce(new DOMException('no', 'SecurityError'))
      .mockRejectedValueOnce(new DOMException('no mic', 'NotFoundError'))
      .mockRejectedValueOnce('odd')
      .mockRejectedValueOnce({})
    const { result } = setup()
    await startIt(result)
    expect(result.current.error).toBe(PERMISSION_MESSAGE)
    for (let i = 0; i < 3; i++) {
      await startIt(result)
      expect(result.current.error).toBe(MIC_FAILED_MESSAGE)
    }
  })

  it('shows a failed transcription and sends nothing', async () => {
    vi.mocked(transcribe).mockRejectedValueOnce(
      new ApiError(503, 'Voice is unavailable right now')
    )
    const { result, onText } = setup()
    await startIt(result)
    await advance(1_000)
    await stopIt(result)

    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe('Voice is unavailable right now')
    expect(haptic).toHaveBeenLastCalledWith('error')
    expect(onText).not.toHaveBeenCalled()
  })

  it("an empty transcript sends nothing and says it didn't catch that", async () => {
    vi.mocked(transcribe).mockResolvedValueOnce('')
    const { result, onText } = setup()
    await startIt(result)
    await advance(1_000)
    await stopIt(result)

    expect(onText).not.toHaveBeenCalled()
    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe(NOTHING_HEARD_MESSAGE)
    expect(NOTHING_HEARD_MESSAGE).toBe("Didn't catch that")
  })

  it('without a token it says signed out and sends no request', async () => {
    getToken.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('x'))
    const { result } = setup()
    for (let i = 0; i < 2; i++) {
      await startIt(result)
      await advance(1_000)
      await stopIt(result)
      expect(result.current.state).toBe('error')
      expect(result.current.error).toBe('Signed out')
    }
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('cancel discards the recording', async () => {
    const { result, onText } = setup()
    await startIt(result)
    await advance(3_000)
    act(() => result.current.cancel())

    expect(result.current.state).toBe('idle')
    expect(result.current.seconds).toBe(0)
    expect(recording.cancel).toHaveBeenCalledTimes(1)
    expect(recording.stop).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
    expect(onText).not.toHaveBeenCalled()

    // Nothing left running: the cap never fires.
    await advance(MAX_RECORDING_MS)
    expect(recording.stop).not.toHaveBeenCalled()
  })

  it('a cancel while the microphone opens closes it as soon as it is ready', async () => {
    const opening = deferred<Recording>()
    vi.mocked(startRecording).mockReturnValueOnce(opening.promise)
    const { result } = setup()
    act(() => result.current.start())
    expect(result.current.state).toBe('starting')
    act(() => result.current.cancel())
    expect(result.current.state).toBe('idle')
    await act(async () => opening.resolve(recording))

    expect(recording.cancel).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('idle')
  })

  it('shows that the microphone is opening until it records', async () => {
    const opening = deferred<Recording>()
    vi.mocked(startRecording).mockReturnValueOnce(opening.promise)
    const { result } = setup()
    act(() => result.current.start())
    expect(result.current.state).toBe('starting')
    expect(haptic).toHaveBeenCalledExactlyOnceWith('medium')

    await act(async () => opening.resolve(recording))
    expect(result.current.state).toBe('recording')
  })

  it('ignores a second start, and stop or cancel with nothing recording', async () => {
    const opening = deferred<Recording>()
    vi.mocked(startRecording).mockReturnValueOnce(opening.promise)
    const { result } = setup()
    act(() => result.current.stop())
    act(() => result.current.cancel())
    act(() => result.current.start())
    act(() => result.current.start())
    act(() => result.current.stop())
    await act(async () => opening.resolve(recording))
    expect(startRecording).toHaveBeenCalledTimes(1)
    expect(result.current.state).toBe('recording')

    await startIt(result)
    expect(startRecording).toHaveBeenCalledTimes(1)
  })

  it('ignores stop and start while transcribing', async () => {
    const pending = deferred<string>()
    vi.mocked(transcribe).mockReturnValueOnce(pending.promise)
    const { result, onText } = setup()
    await startIt(result)
    await advance(1_000)
    await stopIt(result)
    await stopIt(result)
    await startIt(result)

    expect(result.current.state).toBe('transcribing')
    expect(recording.stop).toHaveBeenCalledTimes(1)
    expect(startRecording).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve('done'))
    expect(result.current.state).toBe('idle')
    expect(onText).toHaveBeenCalledExactlyOnceWith('done')
  })

  it('cancel while transcribing abandons it: nothing is handed over', async () => {
    const pending = deferred<string>()
    vi.mocked(transcribe).mockReturnValueOnce(pending.promise)
    const { result, onText } = setup()
    await startIt(result)
    await advance(1_000)
    await stopIt(result)
    const { signal } = vi.mocked(transcribe).mock.calls[0][0] as {
      signal: AbortSignal
    }

    act(() => result.current.cancel())
    expect(signal.aborted).toBe(true)
    expect(result.current.state).toBe('idle')

    // A late answer is dropped, and the mic is free again.
    await act(async () => pending.resolve('too late'))
    expect(onText).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
    expect(haptic).not.toHaveBeenCalledWith('error')
    await startIt(result)
    expect(result.current.state).toBe('recording')
  })

  it('a new recording after an error clears it and outlives its timer', async () => {
    vi.mocked(startRecording).mockRejectedValueOnce(
      new DOMException('denied', 'NotAllowedError')
    )
    const { result } = setup()
    await startIt(result)
    expect(result.current.state).toBe('error')

    await advance(1_000)
    await startIt(result)
    expect(result.current.state).toBe('recording')
    expect(result.current.error).toBeUndefined()
    await advance(ERROR_VISIBLE_MS)
    expect(result.current.state).toBe('recording')
  })

  it('hands the text to the latest onText', async () => {
    const { result, rerender, onText } = setup()
    const later = vi.fn()
    await startIt(result)
    rerender({ onText: later, active: true })
    await advance(1_000)
    await stopIt(result)

    expect(onText).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledExactlyOnceWith('why is the sky blue')
  })

  it('unmounting while recording stops the microphone', async () => {
    const { result, unmount } = setup()
    await startIt(result)
    unmount()
    expect(recording.cancel).toHaveBeenCalledTimes(1)
    await advance(MAX_RECORDING_MS)
    expect(recording.stop).not.toHaveBeenCalled()
  })

  it('unmounting while the microphone opens closes it once ready', async () => {
    const opening = deferred<Recording>()
    vi.mocked(startRecording).mockReturnValueOnce(opening.promise)
    const { result, unmount } = setup()
    act(() => result.current.start())
    unmount()
    await act(async () => opening.resolve(recording))
    expect(recording.cancel).toHaveBeenCalledTimes(1)
  })

  it('unmounting while the microphone fails to open shows nothing', async () => {
    const opening = deferred<Recording>()
    vi.mocked(startRecording).mockReturnValueOnce(opening.promise)
    const { result, unmount } = setup()
    act(() => result.current.start())
    unmount()
    await act(async () => opening.reject(new Error('gone')))
    expect(haptic).not.toHaveBeenCalledWith('error')
  })

  it('unmounting while the audio is gathered sends nothing', async () => {
    const gathered = deferred<Blob>()
    recording.stop.mockReturnValueOnce(gathered.promise)
    const { result, unmount } = setup()
    await startIt(result)
    await advance(1_000)
    await stopIt(result)
    unmount()
    await act(async () => gathered.resolve(voice))
    expect(getToken).not.toHaveBeenCalled()
    expect(transcribe).not.toHaveBeenCalled()
  })

  it('unmounting while the token is fetched sends nothing', async () => {
    const token = deferred<string | null>()
    getToken.mockReturnValueOnce(token.promise)
    const { result, unmount, onText } = setup()
    await startIt(result)
    await advance(1_000)
    await stopIt(result)
    unmount()
    await act(async () => token.resolve('tok'))
    expect(transcribe).not.toHaveBeenCalled()
    expect(onText).not.toHaveBeenCalled()
  })

  it('unmounting while transcribing aborts the request and drops the text', async () => {
    const pending = deferred<string>()
    vi.mocked(transcribe).mockReturnValueOnce(pending.promise)
    const { result, unmount, onText } = setup()
    await startIt(result)
    await advance(1_000)
    await stopIt(result)
    const { signal } = vi.mocked(transcribe).mock.calls[0][0] as {
      signal: AbortSignal
    }
    unmount()
    expect(signal.aborted).toBe(true)

    await act(async () =>
      pending.reject(new DOMException('Aborted', 'AbortError'))
    )
    expect(onText).not.toHaveBeenCalled()
    expect(haptic).not.toHaveBeenCalledWith('error')
    await flush()
  })

  describe('leaving the screen or the app', () => {
    it('leaving the screen mid-recording stops the mic and sends nothing', async () => {
      const { result, setActive, onText } = setup()
      await startIt(result)
      await advance(2_000)
      setActive(false)

      expect(recording.cancel).toHaveBeenCalledTimes(1)
      expect(result.current.state).toBe('idle')
      await advance(MAX_RECORDING_MS)
      expect(recording.stop).not.toHaveBeenCalled()
      expect(transcribe).not.toHaveBeenCalled()
      expect(onText).not.toHaveBeenCalled()

      setActive(true)
      expect(result.current.state).toBe('idle')
    })

    it('leaving the screen mid-transcription aborts it and drops the text', async () => {
      const pending = deferred<string>()
      vi.mocked(transcribe).mockReturnValueOnce(pending.promise)
      const { result, setActive, onText } = setup()
      await startIt(result)
      await advance(1_000)
      await stopIt(result)
      const { signal } = vi.mocked(transcribe).mock.calls[0][0] as {
        signal: AbortSignal
      }
      setActive(false)
      expect(signal.aborted).toBe(true)
      expect(result.current.state).toBe('idle')

      await act(async () => pending.resolve('why is the sky blue'))
      expect(onText).not.toHaveBeenCalled()
    })

    it('leaving the screen while the audio is gathered sends nothing', async () => {
      const gathered = deferred<Blob>()
      recording.stop.mockReturnValueOnce(gathered.promise)
      const { result, setActive } = setup()
      await startIt(result)
      await advance(1_000)
      await stopIt(result)
      setActive(false)
      await act(async () => gathered.resolve(voice))
      expect(getToken).not.toHaveBeenCalled()
      expect(transcribe).not.toHaveBeenCalled()
      expect(result.current.state).toBe('idle')
    })

    it('leaving the screen while the mic opens closes it once ready', async () => {
      const opening = deferred<Recording>()
      vi.mocked(startRecording).mockReturnValueOnce(opening.promise)
      const { result, setActive } = setup()
      act(() => result.current.start())
      setActive(false)
      await act(async () => opening.resolve(recording))
      expect(recording.cancel).toHaveBeenCalledTimes(1)
      expect(result.current.state).toBe('idle')
    })

    it('a screen that is not shown cannot start', async () => {
      const { result, setActive } = setup()
      setActive(false)
      await startIt(result)
      expect(startRecording).not.toHaveBeenCalled()
      expect(result.current.state).toBe('idle')
    })

    it('the app going to the background mid-recording stops the mic', async () => {
      const { result, onText } = setup()
      await startIt(result)
      await advance(2_000)
      await appActive(false)

      expect(recording.cancel).toHaveBeenCalledTimes(1)
      expect(result.current.state).toBe('idle')
      await appActive(true)
      await advance(MAX_RECORDING_MS)
      expect(transcribe).not.toHaveBeenCalled()
      expect(onText).not.toHaveBeenCalled()
    })

    it('the app going to the background mid-transcription drops the text', async () => {
      const pending = deferred<string>()
      vi.mocked(transcribe).mockReturnValueOnce(pending.promise)
      const { result, onText } = setup()
      await startIt(result)
      await advance(1_000)
      await stopIt(result)
      await appActive(false)
      await act(async () => pending.resolve('why is the sky blue'))
      expect(onText).not.toHaveBeenCalled()
      expect(result.current.state).toBe('idle')
    })

    it('the permission prompt (the app inactive while the mic opens) does not stop it', async () => {
      const opening = deferred<Recording>()
      vi.mocked(startRecording).mockReturnValueOnce(opening.promise)
      const { result } = setup()
      act(() => result.current.start())
      await appActive(false)
      await appActive(true)
      await act(async () => opening.resolve(recording))
      expect(result.current.state).toBe('recording')
      expect(recording.cancel).not.toHaveBeenCalled()
    })

    it('stops listening to the app when unmounted', async () => {
      const { unmount } = setup()
      await flush()
      expect(app.listeners).toHaveLength(1)
      unmount()
      await flush()
      expect(app.listeners).toHaveLength(0)
    })
  })
})
