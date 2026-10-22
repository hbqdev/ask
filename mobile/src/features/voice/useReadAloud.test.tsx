import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useApi, type Api } from '@/core/api/ApiProvider'
import { SIGNED_OUT_MESSAGE } from '@/core/api/client'
import { haptic } from '@/core/haptics'
import { playingOwner, stop } from '@/features/voice/speech'
import { UNAVAILABLE_MESSAGE } from '@/features/voice/transcribe'
import {
  ERROR_VISIBLE_MS,
  PLAY_FAILED_MESSAGE,
  stopReading,
  useReadAloud,
  useStopReadingOnLeave
} from '@/features/voice/useReadAloud'
import { VOICE_SETTINGS_KEY } from '@/features/voice/voice-settings'
import {
  audioElement,
  FakeAudio,
  installFakeAudio,
  objectUrls,
  resetFakeAudio
} from '@/test/fake-audio'

vi.mock('@/core/haptics', () => ({ haptic: vi.fn() }))
vi.mock('@/core/api/ApiProvider', () => ({ useApi: vi.fn() }))

const prefs = vi.hoisted(() => new Map<string, string>())
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null
    })),
    set: vi.fn(async () => {}),
    remove: vi.fn(async () => {})
  }
}))

const app = vi.hoisted(() => ({
  listeners: [] as Array<{ event: string; listener: () => void }>
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (event: string, listener: () => void) => {
      const entry = { event, listener }
      app.listeners.push(entry)
      return {
        remove: async () => {
          app.listeners.splice(app.listeners.indexOf(entry), 1)
        }
      }
    })
  }
}))

const BASE = 'https://ask.test.invalid'
const getToken = vi.fn<() => Promise<string | null>>()
const fetchMock = vi.fn<typeof fetch>()

const ANSWER = [
  '## Why',
  '',
  'The sky is **blue** [1](#call_a), as [NASA](https://nasa.example/sky) says.',
  '',
  '```spec',
  '{"op":"add","path":"/root","value":"q1"}',
  '```'
].join('\n')
const SPOKEN = 'Why The sky is blue, as NASA says.'

const mp3 = () =>
  new Response('mp3', { headers: { 'Content-Type': 'audio/mpeg' } })

/** A request that never answers; it rejects like fetch when aborted. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    )
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => (resolve = res))
  return { promise, resolve }
}

const spokenBodies = () =>
  fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))

const emitPause = () =>
  act(async () =>
    app.listeners.filter(l => l.event === 'pause').forEach(l => l.listener())
  )

beforeEach(() => {
  vi.clearAllMocks()
  prefs.clear()
  app.listeners.length = 0
  installFakeAudio()
  resetFakeAudio()
  getToken.mockResolvedValue('tok')
  vi.mocked(useApi).mockReturnValue({
    baseUrl: BASE,
    getToken
  } as unknown as Api)
  fetchMock.mockImplementation(async () => mp3())
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  stopReading()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useReadAloud', () => {
  it('reads an answer aloud: loading, then playing, then stopped by a tap', async () => {
    const { result } = renderHook(() => useReadAloud('m1'))
    expect(result.current.state).toBe('idle')

    act(() => result.current.toggle(ANSWER))
    expect(result.current.state).toBe('loading')
    expect(haptic).toHaveBeenCalledWith('light')

    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/voice/speak`)
    expect(audioElement().src).toBe(objectUrls.made[0])

    act(() => result.current.toggle(ANSWER))
    expect(result.current.state).toBe('idle')
    expect(playingOwner()).toBeNull()
    expect(objectUrls.revoked).toEqual(objectUrls.made)
  })

  it('speaks the answer without citations, spec fences or markdown', async () => {
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(spokenBodies()[0].text).toBe(SPOKEN)
  })

  it('speaks with the saved voice and speed', async () => {
    prefs.set(
      VOICE_SETTINGS_KEY,
      JSON.stringify({ voice: 'bm_george', speed: 1.6, autoRead: false })
    )
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(spokenBodies()[0]).toEqual({
      text: SPOKEN,
      voice: 'bm_george',
      speed: 1.6
    })
  })

  it('goes back to idle when the audio ends', async () => {
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('playing'))
    act(() => audioElement().end())
    expect(result.current.state).toBe('idle')
    expect(objectUrls.revoked).toEqual(objectUrls.made)
  })

  it('a tap while loading cancels the request', async () => {
    fetchMock.mockImplementation((_url, init) => hang(init))
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())

    act(() => result.current.toggle(ANSWER))
    expect(result.current.state).toBe('idle')
    const signal = fetchMock.mock.calls[0][1]!.signal!
    expect(signal.aborted).toBe(true)
    await act(async () => {})
    expect(result.current.state).toBe('idle')
    expect(FakeAudio.instances.every(a => a.play.mock.calls.length === 0)).toBe(
      true
    )
  })

  it('a stop while the token is fetched sends nothing', async () => {
    const token = deferred<string | null>()
    getToken.mockReturnValueOnce(token.promise)
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    act(() => result.current.toggle(ANSWER))
    await act(async () => token.resolve('tok'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.state).toBe('idle')
  })

  it('a reading cancelled by another one goes idle, and its late audio is dropped', async () => {
    const first = deferred<Response>()
    fetchMock.mockImplementationOnce(() => first.promise)
    const a = renderHook(() => useReadAloud('m1'))
    const b = renderHook(() => useReadAloud('m2'))
    act(() => a.result.current.toggle(ANSWER))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    act(() => b.result.current.toggle('Second answer.'))
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true)
    // This fake ignores the abort and answers anyway.
    await act(async () => first.resolve(mp3()))
    expect(a.result.current.state).toBe('idle')
    await waitFor(() => expect(b.result.current.state).toBe('playing'))
    expect(playingOwner()).toBe('m2')
  })

  it('starting a second read-aloud stops the first', async () => {
    const a = renderHook(() => useReadAloud('m1'))
    const b = renderHook(() => useReadAloud('m2'))
    act(() => a.result.current.toggle(ANSWER))
    await waitFor(() => expect(a.result.current.state).toBe('playing'))

    act(() => b.result.current.toggle('Second answer.'))
    // The first stops at once, before the second's audio arrives.
    expect(a.result.current.state).toBe('idle')
    expect(objectUrls.revoked).toEqual([objectUrls.made[0]])
    await waitFor(() => expect(b.result.current.state).toBe('playing'))
    expect(a.result.current.state).toBe('idle')
  })

  it('a tap again after stopping starts afresh, ignoring the stopped request', async () => {
    const first = deferred<Response>()
    fetchMock.mockImplementationOnce(() => first.promise)
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    act(() => result.current.toggle(ANSWER))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('playing'))
    // The stopped request answers late: nothing changes.
    await act(async () => first.resolve(mp3()))
    expect(result.current.state).toBe('playing')
    expect(objectUrls.made).toHaveLength(1)
  })

  it('reading again while the audio starts keeps the new reading going', async () => {
    let interrupt!: (e: unknown) => void
    FakeAudio.nextPlay = () => new Promise((_, reject) => (interrupt = reject))
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.read('First.'))
    await waitFor(() => expect(audioElement().play).toHaveBeenCalled())

    const second = deferred<Response>()
    fetchMock.mockImplementationOnce(() => second.promise)
    act(() => result.current.read('Second.'))
    expect(result.current.state).toBe('loading')
    // The first play() is interrupted, as iOS does on pause.
    await act(async () => interrupt(new DOMException('Stop', 'AbortError')))
    expect(result.current.state).toBe('loading')
    await act(async () => second.resolve(mp3()))
    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(spokenBodies().map(b => b.text)).toEqual(['First.', 'Second.'])
  })

  it('shows an error for a while, then is idle again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockImplementation(
      async () => new Response('TTS unavailable', { status: 503 })
    )
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.error).toBe(UNAVAILABLE_MESSAGE)
    expect(haptic).toHaveBeenCalledWith('error')

    act(() => vi.advanceTimersByTime(ERROR_VISIBLE_MS))
    expect(result.current.state).toBe('idle')
    expect(result.current.error).toBeUndefined()
  })

  it('a tap during an error tries again', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response('TTS unavailable', { status: 503 })
    )
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('error'))
    act(() => result.current.toggle(ANSWER))
    expect(result.current.state).toBe('loading')
    expect(result.current.error).toBeUndefined()
    await waitFor(() => expect(result.current.state).toBe('playing'))
  })

  it('says so when signed out', async () => {
    getToken.mockResolvedValueOnce(null)
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.error).toBe(SIGNED_OUT_MESSAGE)
    expect(fetchMock).not.toHaveBeenCalled()

    getToken.mockRejectedValueOnce(new Error('refresh failed'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.error).toBe(SIGNED_OUT_MESSAGE)
  })

  it('says so when the audio cannot play', async () => {
    FakeAudio.nextPlay = () =>
      Promise.reject(new DOMException('No', 'NotSupportedError'))
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('error'))
    expect(result.current.error).toBe(PLAY_FAILED_MESSAGE)
  })

  it('reads nothing when nothing in the text can be spoken', () => {
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle('[1](#call_a)\n\n```spec\n{}\n```'))
    expect(result.current.state).toBe('idle')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('read() starts reading, and starts again rather than stopping', async () => {
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.read('A gist.'))
    await waitFor(() => expect(result.current.state).toBe('playing'))
    act(() => result.current.read('A gist.'))
    expect(result.current.state).toBe('loading')
    await waitFor(() => expect(result.current.state).toBe('playing'))
    expect(spokenBodies().map(b => b.text)).toEqual(['A gist.', 'A gist.'])
  })

  it('shows playing for a reading of the same message started elsewhere', async () => {
    const a = renderHook(() => useReadAloud('m1'))
    const b = renderHook(() => useReadAloud('m1'))
    act(() => a.result.current.toggle(ANSWER))
    await waitFor(() => expect(b.result.current.state).toBe('playing'))
  })

  it('stops its own reading when it goes away', async () => {
    const { result, unmount } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('playing'))
    unmount()
    expect(playingOwner()).toBeNull()
    expect(objectUrls.revoked).toEqual(objectUrls.made)
  })

  it('going away leaves another message’s reading alone', async () => {
    const a = renderHook(() => useReadAloud('m1'))
    const b = renderHook(() => useReadAloud('m2'))
    act(() => a.result.current.toggle(ANSWER))
    await waitFor(() => expect(a.result.current.state).toBe('playing'))
    b.unmount()
    expect(playingOwner()).toBe('m1')
  })
})

describe('stopReading', () => {
  it('stops only the readings it is asked to', async () => {
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(result.current.state).toBe('playing'))
    act(() => stopReading(owner => owner === 'other'))
    expect(playingOwner()).toBe('m1')
    act(() => stopReading(owner => owner === 'm1'))
    expect(playingOwner()).toBeNull()
    expect(result.current.state).toBe('idle')
  })

  it('cancels a reading that is loading', async () => {
    fetchMock.mockImplementation((_url, init) => hang(init))
    const { result } = renderHook(() => useReadAloud('m1'))
    act(() => result.current.toggle(ANSWER))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    act(() => stopReading(owner => owner === 'other'))
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(false)
    act(() => stopReading())
    expect(fetchMock.mock.calls[0][1]!.signal!.aborted).toBe(true)
    await waitFor(() => expect(result.current.state).toBe('idle'))
  })
})

describe('useStopReadingOnLeave', () => {
  const ownsM1 = (owner: string) => owner === 'm1'

  async function playing() {
    const reader = renderHook(() => useReadAloud('m1'))
    act(() => reader.result.current.toggle(ANSWER))
    await waitFor(() => expect(reader.result.current.state).toBe('playing'))
    return reader
  }

  it('leaving the screen stops playback and revokes the URL', async () => {
    const screen = renderHook(
      ({ active }) => useStopReadingOnLeave(active, ownsM1),
      { initialProps: { active: true } }
    )
    const reader = await playing()
    screen.rerender({ active: false })
    expect(reader.result.current.state).toBe('idle')
    expect(playingOwner()).toBeNull()
    expect(objectUrls.revoked).toEqual(objectUrls.made)
  })

  it('the app going to the background stops playback', async () => {
    renderHook(() => useStopReadingOnLeave(true, ownsM1))
    await waitFor(() =>
      expect(app.listeners.map(l => l.event)).toEqual(['pause'])
    )
    const reader = await playing()
    await emitPause()
    expect(reader.result.current.state).toBe('idle')
    expect(objectUrls.revoked).toEqual(objectUrls.made)
  })

  it('the screen going away stops playback and its listener', async () => {
    const screen = renderHook(() => useStopReadingOnLeave(true, ownsM1))
    await waitFor(() => expect(app.listeners).toHaveLength(1))
    await playing()
    screen.unmount()
    expect(playingOwner()).toBeNull()
    await waitFor(() => expect(app.listeners).toHaveLength(0))
  })

  it('leaves readings it does not own alone', async () => {
    const screen = renderHook(
      ({ active }) => useStopReadingOnLeave(active, o => o === 'elsewhere'),
      { initialProps: { active: true } }
    )
    await playing()
    screen.rerender({ active: false })
    await emitPause()
    screen.unmount()
    expect(playingOwner()).toBe('m1')
    stop()
  })
})
