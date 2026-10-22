import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NETWORK_ERROR_MESSAGE } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import {
  onStateChange,
  play,
  playingOwner,
  speak,
  speakableText,
  SPOKEN_MAX_CHARS,
  stop
} from '@/features/voice/speech'
import { UNAVAILABLE_MESSAGE } from '@/features/voice/transcribe'
import {
  audioElement,
  FakeAudio,
  installFakeAudio,
  objectUrls,
  resetFakeAudio
} from '@/test/fake-audio'

const BASE = 'https://ask.test.invalid'
const fetchMock = vi.fn()

const mp3 = (bytes = 'mp3') => new Blob([bytes], { type: 'audio/mpeg' })

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(ApiError)
  return error as ApiError
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  installFakeAudio()
  resetFakeAudio()
})

afterEach(() => {
  stop()
  vi.unstubAllGlobals()
})

describe('speak', () => {
  it('POSTs the text, voice and speed as JSON with the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('audio-bytes', {
        headers: { 'Content-Type': 'audio/mpeg' }
      })
    )
    const blob = await speak({
      baseUrl: BASE,
      token: 'tok',
      text: 'Hello there.',
      voice: 'bf_emma',
      speed: 1.4
    })

    expect(blob.type).toBe('audio/mpeg')
    expect(await blob.text()).toBe('audio-bytes')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/voice/speak`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json'
    })
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'Hello there.',
      voice: 'bf_emma',
      speed: 1.4
    })
  })

  it('leaves out a voice and speed it was not given, and clamps the speed', async () => {
    fetchMock.mockImplementation(async () => new Response('mp3'))
    await speak({ baseUrl: BASE, token: 't', text: 'Hi.' })
    await speak({ baseUrl: BASE, token: 't', text: 'Hi.', speed: 9 })
    const bodies = fetchMock.mock.calls.map(([, init]) =>
      JSON.parse(String((init as RequestInit).body))
    )
    expect(bodies).toEqual([{ text: 'Hi.' }, { text: 'Hi.', speed: 2 }])
  })

  it('503 (and 404, voice turned off) say voice is unavailable', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('TTS unavailable', { status: 503 })
    )
    const down = await failure(speak({ baseUrl: BASE, token: 't', text: 'x' }))
    expect(down.status).toBe(503)
    expect(down.message).toBe(UNAVAILABLE_MESSAGE)

    fetchMock.mockResolvedValueOnce(new Response('Not found', { status: 404 }))
    const off = await failure(speak({ baseUrl: BASE, token: 't', text: 'x' }))
    expect(off.status).toBe(404)
    expect(off.message).toBe(UNAVAILABLE_MESSAGE)
  })

  it('any other error (400, 401) gives its own message', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Bad request', { status: 400 })
    )
    const bad = await failure(speak({ baseUrl: BASE, token: 't', text: 'x' }))
    expect(bad.status).toBe(400)
    expect(bad.message).toBe('Bad request')

    fetchMock.mockResolvedValueOnce(
      new Response('Authentication required', { status: 401 })
    )
    const unauth = await failure(
      speak({ baseUrl: BASE, token: 't', text: 'x' })
    )
    expect(unauth.status).toBe(401)
    expect(unauth.message).toBe('Authentication required')
  })

  it('a lost connection is a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Load failed'))
    const error = await failure(speak({ baseUrl: BASE, token: 't', text: 'x' }))
    expect(error.status).toBe(0)
    expect(error.message).toBe(NETWORK_ERROR_MESSAGE)
  })

  it('a cancelled request rejects with the abort, not a network error', async () => {
    const controller = new AbortController()
    const abort = new DOMException('Aborted', 'AbortError')
    fetchMock.mockImplementationOnce(async () => {
      controller.abort()
      throw abort
    })
    await expect(
      speak({
        baseUrl: BASE,
        token: 't',
        text: 'x',
        signal: controller.signal
      })
    ).rejects.toBe(abort)
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(
      controller.signal
    )
  })
})

describe('speakableText', () => {
  /** A whole answer as the model writes it, with every kind of non-prose. */
  const RAW = [
    '## Why the sky is blue',
    '',
    'Sunlight scatters off air [1](#call_abc123). Blue scatters most [ 2 ](#call_abc123), [3](#call_def456).',
    '',
    '| Colour | Wavelength |',
    '| --- | --- |',
    '| Blue | 450 nm |',
    '',
    '```python',
    'def scatter(wavelength):',
    '    return 1 / wavelength ** 4',
    '```',
    '',
    'Use `scatter()` to compare **colours**.',
    '',
    '```spec',
    '{"op":"add","path":"/root","value":"main"}',
    '{"op":"add","path":"/elements/q1","value":{"type":"Button","props":{"text":"Why are sunsets red?"},"on":{"press":{"action":"submitQuery","params":{"query":"Why are sunsets red?"}}},"children":[]}}',
    '```'
  ].join('\n')

  it('speaks a raw answer as prose only: no citation anchors, tables, code or related-questions fence', () => {
    const spoken = speakableText(RAW)
    expect(spoken).toBe(
      'Why the sky is blue Sunlight scatters off air. Blue scatters most. Use scatter() to compare colours.'
    )
    for (const leftover of [
      '#call_',
      '](',
      '[1]',
      '|',
      '450 nm',
      'Wavelength',
      'def ',
      'wavelength ** 4',
      'python',
      '```',
      'spec',
      'submitQuery',
      'sunsets',
      '"op"',
      '**',
      '##'
    ]) {
      expect(spoken).not.toContain(leftover)
    }
  })

  it('drops an unfinished trailing related-questions fence and an unclosed code fence', () => {
    expect(
      speakableText(
        'The answer [1](#call_a).\n\n```spec\n{"op":"add","path":"/root"'
      )
    ).toBe('The answer.')
    expect(speakableText('Run this:\n\n```bash\nrm -rf build')).toBe(
      'Run this:'
    )
  })

  it('drops citations, spec fences and markdown', () => {
    const answer = [
      '## The answer',
      '',
      'The sky is **blue** [1](#call_a). See [the source](https://example.com/a).',
      '',
      '```spec',
      '{"op":"add","path":"/root","value":"q1"}',
      '```'
    ].join('\n')
    expect(speakableText(answer)).toBe(
      'The answer The sky is blue. See the source.'
    )
  })

  it('caps a long answer on a sentence boundary', () => {
    const sentence = 'This sentence is exactly forty chars ok. '
    const text = sentence.repeat(Math.ceil(SPOKEN_MAX_CHARS / 40) + 10)
    const spoken = speakableText(text)
    expect(SPOKEN_MAX_CHARS).toBe(20_000)
    expect(spoken.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS)
    expect(spoken.length).toBeGreaterThan(SPOKEN_MAX_CHARS - 41)
    expect(spoken.endsWith('chars ok.')).toBe(true)
  })

  it('cuts a long answer without sentences at the cap', () => {
    const spoken = speakableText('x'.repeat(25_000))
    expect(spoken.length).toBe(SPOKEN_MAX_CHARS)
  })
})

describe('the player', () => {
  it('plays a blob from an object URL on one audio element', async () => {
    const changes: Array<string | null> = []
    const off = onStateChange(owner => changes.push(owner))
    await play(mp3(), 'm1')

    const element = audioElement()
    expect(element.src).toBe(objectUrls.made[0])
    expect(element.play).toHaveBeenCalledTimes(1)
    expect(playingOwner()).toBe('m1')
    expect(changes).toEqual(['m1'])
    off()
  })

  it('starting a second read-aloud stops the first', async () => {
    const changes: Array<string | null> = []
    const off = onStateChange(owner => changes.push(owner))
    await play(mp3(), 'm1')
    const [first] = objectUrls.made
    await play(mp3(), 'm2')
    const [, second] = objectUrls.made

    const element = audioElement()
    expect(element.pause).toHaveBeenCalled()
    expect(objectUrls.revoked).toEqual([first])
    expect(element.src).toBe(second)
    expect(playingOwner()).toBe('m2')
    expect(changes).toEqual(['m1', 'm2'])
    // Still one element, reused.
    expect(FakeAudio.instances.filter(a => a === element)).toHaveLength(1)
    off()
  })

  it('revokes the URL when the audio ends', async () => {
    const changes: Array<string | null> = []
    const off = onStateChange(owner => changes.push(owner))
    await play(mp3(), 'm1')
    audioElement().end()

    expect(objectUrls.revoked).toEqual(objectUrls.made)
    expect(playingOwner()).toBeNull()
    expect(changes).toEqual(['m1', null])
    off()
  })

  it('revokes the URL when stopped', async () => {
    await play(mp3(), 'm1')
    stop()
    const element = audioElement()
    expect(element.pause).toHaveBeenCalled()
    expect(element.src).toBe('')
    expect(objectUrls.revoked).toEqual(objectUrls.made)
    expect(playingOwner()).toBeNull()
  })

  it('revokes the URL when the audio errors', async () => {
    await play(mp3(), 'm1')
    audioElement().fail()
    expect(objectUrls.revoked).toEqual(objectUrls.made)
    expect(playingOwner()).toBeNull()
  })

  it('a stop with nothing playing tells no one', () => {
    const listener = vi.fn()
    const off = onStateChange(listener)
    stop()
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('an end or error from a replaced playback is ignored', async () => {
    await play(mp3(), 'm1')
    const element = audioElement()
    const staleEnd = element.onended!
    await play(mp3(), 'm2')
    staleEnd()
    expect(playingOwner()).toBe('m2')
    expect(objectUrls.revoked).toHaveLength(1)
  })

  it('rejects, revokes and stops when the audio cannot start', async () => {
    const refused = new DOMException('Not allowed', 'NotAllowedError')
    FakeAudio.nextPlay = () => Promise.reject(refused)
    await expect(play(mp3(), 'm1')).rejects.toBe(refused)
    expect(objectUrls.revoked).toEqual(objectUrls.made)
    expect(playingOwner()).toBeNull()
  })

  it('resolves quietly when stopped before the audio started', async () => {
    let reject!: (e: unknown) => void
    FakeAudio.nextPlay = () => new Promise((_, r) => (reject = r))
    const playing = play(mp3(), 'm1')
    stop()
    // iOS rejects the interrupted play() with an AbortError.
    reject(new DOMException('Interrupted', 'AbortError'))
    await expect(playing).resolves.toBeUndefined()
    expect(objectUrls.revoked).toEqual(objectUrls.made)
  })

  it('has no owner by default', async () => {
    await play(mp3())
    expect(playingOwner()).toBe('')
  })

  it('stops telling a listener once it unsubscribes', async () => {
    const listener = vi.fn()
    const off = onStateChange(listener)
    off()
    await play(mp3(), 'm1')
    expect(listener).not.toHaveBeenCalled()
  })
})
