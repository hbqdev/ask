import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isVoiceEnabled } from '@/lib/voice/config'
import { condenseForSpeech } from '@/lib/voice/spoken-gist'

const MAX_TEXT = 20000

// Condense a finished answer into a short spoken reply for the hands-free
// conversation loop. Reuses the granite gist path (condenseForSpeech) that the
// on-screen read-aloud no longer uses. Gated + authed like the other voice routes.
export async function POST(req: Request): Promise<Response> {
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
    const gist = await condenseForSpeech(text)
    return new Response(JSON.stringify({ text: gist }), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      }
    })
  } catch {
    return new Response('Gist unavailable', { status: 503 })
  }
}
