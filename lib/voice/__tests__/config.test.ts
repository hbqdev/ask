import { afterEach, describe, expect, it } from 'vitest'

import { gistModelId, isVoiceEnabled, ttsServiceUrl, ttsVoice } from '../config'

const orig = { ...process.env }
afterEach(() => {
  process.env = { ...orig }
})

describe('voice config', () => {
  it('isVoiceEnabled is true only when VOICE_ENABLED === "true"', () => {
    process.env.VOICE_ENABLED = 'true'
    expect(isVoiceEnabled()).toBe(true)
    process.env.VOICE_ENABLED = 'false'
    expect(isVoiceEnabled()).toBe(false)
    delete process.env.VOICE_ENABLED
    expect(isVoiceEnabled()).toBe(false)
  })

  it('ttsServiceUrl returns the env value or undefined', () => {
    process.env.TTS_SERVICE_URL = 'http://ask-tts-lab:8080'
    expect(ttsServiceUrl()).toBe('http://ask-tts-lab:8080')
    delete process.env.TTS_SERVICE_URL
    expect(ttsServiceUrl()).toBeUndefined()
  })

  it('ttsVoice and gistModelId have defaults, overridable by env', () => {
    delete process.env.VOICE_TTS_VOICE
    delete process.env.VOICE_GIST_MODEL_ID
    expect(ttsVoice()).toBe('af_heart')
    expect(gistModelId()).toBe('granite4.1:8b')
    process.env.VOICE_TTS_VOICE = 'am_adam'
    process.env.VOICE_GIST_MODEL_ID = 'llama3.2:3b'
    expect(ttsVoice()).toBe('am_adam')
    expect(gistModelId()).toBe('llama3.2:3b')
  })
})
