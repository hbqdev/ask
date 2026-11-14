import type { FollowupRequest } from './types'

/**
 * Ask the server for follow-up questions. Resolves [] on any failure
 * (non-200, network error, bad body) and never throws: follow-ups are an
 * extra, never a reason to surface an error.
 */
export async function fetchFollowups(
  req: FollowupRequest,
  signal?: AbortSignal
): Promise<string[]> {
  try {
    const res = await fetch('/api/chat/followups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal
    })
    if (res.status !== 200) return []
    const body = (await res.json()) as { questions?: unknown }
    if (!Array.isArray(body?.questions)) return []
    return body.questions.filter((q): q is string => typeof q === 'string')
  } catch {
    return []
  }
}
