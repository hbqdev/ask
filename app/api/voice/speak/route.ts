import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { synthesizeSpeech } from '@/lib/voice/tts-client'

// Read-aloud now speaks the full (cleaned) answer, not a short gist, so the cap
// is generous — enough for a long research answer. emit-spoken-gist truncates
// beyond ~20k chars, so this is a backstop against abuse, not the normal path.
const MAX_TEXT = 20000

export async function POST(req: Request): Promise<Response> {
  // Feature-gated: when off, the endpoint does not exist.
  if (!isVoiceEnabled()) return new Response('Not found', { status: 404 })

  const userId = await getCurrentUserId()
  if (!userId) return new Response('Unauthorized', { status: 401 })

  let text: unknown
  try {
    ;({ text } = await req.json())
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) {
    return new Response('Invalid text', { status: 400 })
  }

  try {
    const audio = await synthesizeSpeech(text)
    return new Response(audio, {
      headers: {
        // Kokoro service streams mp3; adjust if the service is configured for wav.
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store'
      }
    })
  } catch (e) {
    console.warn('[voice] /speak failed:', e)
    return new Response('TTS unavailable', { status: 503 })
  }
}
