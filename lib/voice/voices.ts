// Curated Kokoro-82M voices + speed presets exposed to the user in Settings.
// Pure data (no server env) so it is safe in the client bundle; the /speak
// route validates the incoming voice against this list and clamps the speed.

export const DEFAULT_TTS_VOICE = 'af_heart'
export const DEFAULT_TTS_SPEED = 1.2

// Kokoro ships ~50 voices; this is a legible cross-section (US/UK, female/male).
export const TTS_VOICES: { id: string; label: string }[] = [
  { id: 'af_heart', label: 'Heart — US, warm (default)' },
  { id: 'af_bella', label: 'Bella — US female' },
  { id: 'af_nicole', label: 'Nicole — US female' },
  { id: 'af_sky', label: 'Sky — US female' },
  { id: 'am_adam', label: 'Adam — US male' },
  { id: 'am_michael', label: 'Michael — US male' },
  { id: 'bf_emma', label: 'Emma — UK female' },
  { id: 'bf_isabella', label: 'Isabella — UK female' },
  { id: 'bm_george', label: 'George — UK male' }
]

// Speed multipliers. Kokoro supports roughly 0.5–2.0.
export const TTS_SPEEDS: { value: string; label: string }[] = [
  { value: '0.9', label: 'Slower (0.9×)' },
  { value: '1.0', label: 'Normal (1.0×)' },
  { value: '1.2', label: 'A bit faster (1.2×)' },
  { value: '1.4', label: 'Fast (1.4×)' },
  { value: '1.6', label: 'Faster (1.6×)' }
]

export function isValidVoice(id: unknown): id is string {
  return typeof id === 'string' && TTS_VOICES.some(v => v.id === id)
}

export function clampSpeed(n: number): number {
  return Math.min(2, Math.max(0.5, n))
}
