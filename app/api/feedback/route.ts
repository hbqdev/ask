import { Langfuse } from 'langfuse'

import { updateMessageFeedback } from '@/lib/actions/feedback'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import { isTracingEnabled } from '@/lib/utils/telemetry'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { traceId, score, comment, messageId } = body

    if (!traceId) {
      return new Response('traceId is required', {
        status: 400,
        statusText: 'Bad Request'
      })
    }

    if (score === undefined || (score !== 1 && score !== -1)) {
      return new Response('score must be 1 (good) or -1 (bad)', {
        status: 400,
        statusText: 'Bad Request'
      })
    }

    // Check if tracing is enabled
    if (!isTracingEnabled()) {
      return new Response('Feedback tracking is not enabled', {
        status: 200
      })
    }

    // Resolve identity BEFORE writing anything. This route took a caller-
    // supplied traceId and messageId and wrote to both Langfuse and the
    // messages table with no identity required. The app runs as the non-owner
    // `app_user` role, so RLS scopes the DB write — but Langfuse has no RLS and
    // the owner-URL fallback (DATABASE_RESTRICTED_URL unset) bypasses it, so
    // without this an unauthenticated POST could score any trace and overwrite
    // any message's metadata.
    //
    // getCurrentUserId rather than a hand-rolled supabase lookup: with
    // ENABLE_AUTH=false it returns the anonymous user id, so personal
    // deployments keep working instead of 401-ing on every feedback click.
    const userId = await getCurrentUserId()
    if (!userId) {
      return new Response('Unauthorized', {
        status: 401,
        statusText: 'Unauthorized'
      })
    }

    // Initialize Langfuse client
    const langfuse = new Langfuse()

    // Send score to Langfuse
    langfuse.score({
      traceId,
      name: 'user_feedback',
      value: score,
      comment
    })

    // Flush to ensure the score is sent
    await langfuse.flushAsync()

    // Update the message metadata with the feedback score using the action
    if (messageId) {
      const result = await updateMessageFeedback(messageId, score, userId)

      if (!result.success) {
        console.error('Error updating message feedback:', result.error)
        // Continue even if database update fails
      }
    }

    return new Response('Feedback recorded successfully', {
      status: 200
    })
  } catch (error) {
    console.error('Error recording feedback:', error)
    return new Response('Error recording feedback', {
      status: 500,
      statusText: 'Internal Server Error'
    })
  }
}
