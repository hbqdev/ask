// Voice is gated by a single flag so text users see zero change and the two
// endpoints stay disabled unless a deployment opts in. Off everywhere except the
// lab overlay (docker-compose.lab.yaml). Read per-call (not at import) so a lab
// env flip takes effect without a rebuild.
export function isVoiceEnabled(): boolean {
  return process.env.VOICE_ENABLED === 'true'
}

// Container-to-container URL for the self-hosted Kokoro TTS service. Unset ⇒
// voice degrades to text-only (fail open).
export function ttsServiceUrl(): string | undefined {
  return process.env.TTS_SERVICE_URL || undefined
}

// A Kokoro voice id. af_heart is a warm default; overridable per deployment.
export function ttsVoice(): string {
  return process.env.VOICE_TTS_VOICE || 'af_heart'
}

// Local model that condenses an answer into a spoken gist — the same resident
// granite4.1:8b the title generator / memory extractor use.
export function gistModelId(): string {
  return process.env.VOICE_GIST_MODEL_ID || 'granite4.1:8b'
}

// Container-to-container URL for the self-hosted Whisper STT service. Unset ⇒
// dictation degrades to text-only (fail open), mirroring ttsServiceUrl.
export function whisperServiceUrl(): string | undefined {
  return process.env.WHISPER_SERVICE_URL || undefined
}

// faster-whisper model the STT service loads. distil-large-v3 is the design
// default; a lighter model (e.g. Systran/faster-whisper-small) can be set per
// deployment if CPU transcription latency is too high.
export function sttModelId(): string {
  return process.env.VOICE_STT_MODEL || 'Systran/faster-distil-whisper-large-v3'
}
