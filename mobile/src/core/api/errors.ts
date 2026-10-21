// Typed errors for calls to Ask's API. Ask answers failures in three shapes:
// plain text (most pre-stream errors, e.g. 401 "Authentication required"),
// JSON {error} from newer routes, and its public error JSON
// {code, type, error, retryable} (lib/errors/public-error.ts).

/** Gateway, overload and rate-limit statuses, plus 0 for a network failure. */
const RETRYABLE_STATUSES = new Set([0, 429, 502, 503, 504])

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never reached the server. */
  status: number
  retryable: boolean
  /** Ask's public error code (e.g. `rate_limit`), when the server sent one. */
  code?: string

  constructor(
    status: number,
    message: string,
    options: { retryable?: boolean; code?: string } = {}
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.retryable = options.retryable ?? RETRYABLE_STATUSES.has(status)
    this.code = options.code
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Builds an ApiError from a non-2xx response, reading its body once. */
export async function toApiError(res: Response): Promise<ApiError> {
  const fallback = `Request failed (${res.status})`
  let text = ''
  try {
    text = (await res.text()).trim()
  } catch {
    // An unreadable body still yields an error with the status.
  }

  const body = parseJsonObject(text)
  if (body) {
    const message =
      typeof body.error === 'string' && body.error.trim()
        ? body.error.trim()
        : fallback
    return new ApiError(res.status, message, {
      code: typeof body.code === 'string' ? body.code : undefined,
      retryable:
        typeof body.retryable === 'boolean' ? body.retryable : undefined
    })
  }

  // A proxy's HTML error page is not a message to show anyone.
  const message = text && !text.startsWith('<') ? text : fallback
  return new ApiError(res.status, message)
}
