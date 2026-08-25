import { describe, expect, it } from 'vitest'

import {
  clampSpeed,
  DEFAULT_TTS_VOICE,
  isValidVoice,
  TTS_VOICES
} from '../voices'

describe('voices', () => {
  it('accepts known voices and rejects unknown / non-string', () => {
    expect(isValidVoice('af_heart')).toBe(true)
    expect(isValidVoice(DEFAULT_TTS_VOICE)).toBe(true)
    expect(isValidVoice('not_a_voice')).toBe(false)
    expect(isValidVoice(123)).toBe(false)
    expect(isValidVoice(undefined)).toBe(false)
  })

  it('exposes the default voice in the offered list', () => {
    expect(TTS_VOICES.some(v => v.id === DEFAULT_TTS_VOICE)).toBe(true)
  })

  it('clamps speed to Kokoro’s 0.5–2.0 range', () => {
    expect(clampSpeed(1.2)).toBe(1.2)
    expect(clampSpeed(0.1)).toBe(0.5)
    expect(clampSpeed(5)).toBe(2)
  })
})
