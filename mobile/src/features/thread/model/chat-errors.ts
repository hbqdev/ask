// What a failed chat request or stream shows: the message, whether Retry is
// offered and whether the user must sign in. The transport throws
// Error(<response body>) and a stream error chunk carries a JSON
// PublicErrorPayload (code map §1). Pure: no React.
import { toPublicErrorPayload } from '@/lib/errors/public-error'

export type ChatErrorView = {
  message: string
  retryable: boolean
  authRequired: boolean
}

const FALLBACK_MESSAGE = 'Something went wrong'
const AUTH_REQUIRED = 'Authentication required'
const SIGNED_OUT = 'Signed out'

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function describeChatError(error: Error): ChatErrorView {
  const text = error.message.trim()
  if (!text) {
    return { message: FALLBACK_MESSAGE, retryable: true, authRequired: false }
  }

  const body = parseJsonObject(text)
  if (body) {
    const payload = toPublicErrorPayload(text)
    // The server already wrote a top-level `error` for the user
    // (serializePublicError, or a pre-stream JSON body), so show it rather
    // than its re-classified generic line. Any other shape is a raw upstream
    // body: show the payload's public message instead.
    const message =
      typeof body.error === 'string' && body.error.trim()
        ? body.error
        : payload.error
    return {
      message,
      retryable: payload.retryable !== false,
      authRequired: payload.authRequired === true
    }
  }

  return {
    message: text,
    retryable: text !== AUTH_REQUIRED,
    authRequired: text === AUTH_REQUIRED || text === SIGNED_OUT
  }
}
