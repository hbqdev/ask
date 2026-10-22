import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { appPreflight, withAppCors } from '@/lib/http/with-app-cors'
import { isVoiceEnabled } from '@/lib/voice/config'
import { transcribeAudio } from '@/lib/voice/stt-client'

// Bound abuse + STT latency. ~25MB matches OpenAI's audio limit and holds well
// over a minute of Opus — far more than a push-to-talk clip needs.
const MAX_BYTES = 25 * 1024 * 1024
// Multipart framing (boundaries, part headers) on top of the audio itself.
const MULTIPART_OVERHEAD = 64 * 1024

// This route is outside the proxy matcher (proxy.ts) so its multipart body is
// never cut at Next's 10 MB proxy limit; it therefore answers the app's CORS
// itself.
export function OPTIONS(req: Request): Response {
  return appPreflight(req)
}

export async function POST(req: Request): Promise<Response> {
  return withAppCors(await transcribe(req), req.headers.get('origin'))
}

const TOO_LARGE = Symbol('too large')

/**
 * The multipart body, read with at most `limit` bytes in memory. Outside the
 * proxy nothing caps it and req.formData() buffers all of it, so a declared
 * length over the cap is refused unread, and a body with none (a hop that
 * forwards it chunked) is read up to the cap and refused past it. Rejects
 * when the body is not a form (or breaks off).
 */
async function readForm(
  req: Request,
  limit: number
): Promise<FormData | typeof TOO_LARGE> {
  const declared = req.headers.get('content-length')
  if (declared !== null) {
    return Number(declared) > limit ? TOO_LARGE : req.formData()
  }
  const kept: Uint8Array[] = []
  let size = 0
  if (req.body) {
    const reader = req.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) {
        await reader.cancel()
        return TOO_LARGE
      }
      kept.push(value)
    }
  }
  return new Response(Buffer.concat(kept), {
    headers: { 'content-type': req.headers.get('content-type') ?? '' }
  }).formData()
}

async function transcribe(req: Request): Promise<Response> {
  // Feature-gated: when off, the endpoint does not exist.
  if (!isVoiceEnabled()) return new Response('Not found', { status: 404 })

  let userId: string | undefined
  try {
    userId = await getCurrentUserId()
  } catch (e) {
    console.warn('[voice] /transcribe session lookup failed:', e)
    return new Response('Server error', { status: 500 })
  }
  if (!userId) return new Response('Unauthorized', { status: 401 })

  let audio: File | null = null
  try {
    const form = await readForm(req, MAX_BYTES + MULTIPART_OVERHEAD)
    if (form === TOO_LARGE)
      return new Response('Audio too large', { status: 413 })
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
