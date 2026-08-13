import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { transcribeAudio } from '@/lib/voice/stt-client'

// Bound abuse + STT latency. ~25MB matches OpenAI's audio limit and holds well
// over a minute of Opus — far more than a push-to-talk clip needs.
const MAX_BYTES = 25 * 1024 * 1024

export async function POST(req: Request): Promise<Response> {
  // Feature-gated: when off, the endpoint does not exist.
  if (!isVoiceEnabled()) return new Response('Not found', { status: 404 })

  const userId = await getCurrentUserId()
  if (!userId) return new Response('Unauthorized', { status: 401 })

  let audio: File | null = null
  try {
    const form = await req.formData()
    const f = form.get('file')
    if (f instanceof File) audio = f
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (!audio || audio.size === 0)
    return new Response('No audio', { status: 400 })
  if (audio.size > MAX_BYTES) {
    return new Response('Audio too large', { status: 413 })
  }

  try {
    const text = await transcribeAudio(audio)
    return new Response(JSON.stringify({ text }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    })
  } catch (e) {
    console.warn('[voice] /transcribe failed:', e)
    return new Response('STT unavailable', { status: 503 })
  }
}
