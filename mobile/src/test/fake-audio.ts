import { vi } from 'vitest'

/**
 * A stand-in for HTMLAudioElement, enough for the read-aloud player: jsdom
 * cannot play media. `end()` and `fail()` play the element to its end or
 * make it error.
 */
export class FakeAudio {
  static instances: FakeAudio[] = []
  /** What the next play() resolves or rejects with; used once. */
  static nextPlay: (() => Promise<void>) | null = null

  src = ''
  paused = true
  onended: (() => void) | null = null
  onerror: (() => void) | null = null

  play = vi.fn(() => {
    const impl = FakeAudio.nextPlay
    FakeAudio.nextPlay = null
    this.paused = false
    return impl ? impl() : Promise.resolve()
  })

  pause = vi.fn(() => {
    this.paused = true
  })

  constructor() {
    FakeAudio.instances.push(this)
  }

  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }

  /** The audio plays to its end. */
  end() {
    this.paused = true
    this.onended?.()
  }

  /** The audio fails to decode or load. */
  fail() {
    this.paused = true
    this.onerror?.()
  }
}

let urls = 0

/** The object URLs made and revoked, in order. */
export const objectUrls = { made: [] as string[], revoked: [] as string[] }

/** Installs FakeAudio as `Audio`, and object URLs that are only recorded. */
export function installFakeAudio() {
  vi.stubGlobal('Audio', FakeAudio)
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:fake/${++urls}`
    objectUrls.made.push(url)
    return url
  })
  URL.revokeObjectURL = vi.fn((url: string) => {
    objectUrls.revoked.push(url)
  })
}

/** The player's audio element (the last one made). */
export function audioElement(): FakeAudio {
  const element = FakeAudio.instances.at(-1)
  if (!element) throw new Error('no audio element was made')
  return element
}

/** Forgets the URLs recorded so far and any queued play behaviour. */
export function resetFakeAudio() {
  objectUrls.made.length = 0
  objectUrls.revoked.length = 0
  FakeAudio.nextPlay = null
}
