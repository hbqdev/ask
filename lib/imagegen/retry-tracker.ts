// Consecutive-retry counter per chat for premium escalation. The researcher
// marks a generation as a retry (isRetry) when the user was unhappy with the
// previous result; the 4th consecutive retry escalates to the premium model
// and the streak resets. Same Redis pattern as rotation.ts, with an
// in-process fallback map.

import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

export const RETRY_ESCALATION_THRESHOLD = 4
const TTL_SECONDS = 60 * 60 * 24

type RetryClient = {
  incr(key: string): Promise<number>
  del(key: string): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
}

let client: RetryClient | null = null
let clientInitialized = false
let clientOverridden = false
const memoryCounters = new Map<string, number>()

async function getRetryClient(): Promise<RetryClient | null> {
  if (clientOverridden || clientInitialized) return client
  clientInitialized = true

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    client = new Redis({ url, token }) as unknown as RetryClient
    return client
  }
  try {
    const local = createClient({
      url: process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
    })
    await local.connect()
    client = local as unknown as RetryClient
  } catch (error) {
    console.warn('[imagegen] retry: Redis unavailable, using memory:', error)
    client = null
  }
  return client
}

export function __setRetryClientForTests(c: RetryClient | null): void {
  client = c
  clientOverridden = true
  memoryCounters.clear()
}

export function __resetRetryForTests(): void {
  client = null
  clientInitialized = false
  clientOverridden = false
  memoryCounters.clear()
}

export async function trackRetry(
  chatKey: string,
  isRetry: boolean
): Promise<{ attempt: number; escalate: boolean }> {
  const key = `imagegen:retry:${chatKey}`
  const c = await getRetryClient()

  if (!isRetry) {
    if (c) {
      try {
        await c.del(key)
        return { attempt: 0, escalate: false }
      } catch {
        // Durably abandon the failing client so the process stays on the memory
        // path from here on. clientInitialized is already true, so
        // getRetryClient() consistently returns null — this prevents
        // disjoint-counter drift between Redis and memory after a transient
        // failure.
        client = null
      }
    }
    memoryCounters.delete(key)
    return { attempt: 0, escalate: false }
  }

  let attempt: number | null = null
  if (c) {
    try {
      attempt = await c.incr(key)
      if (attempt === 1) await c.expire(key, TTL_SECONDS)
      if (attempt >= RETRY_ESCALATION_THRESHOLD) await c.del(key)
    } catch {
      // Abandon the failing client (see the non-retry path above) so subsequent
      // calls stay on the memory path instead of splitting the counter.
      client = null
      attempt = null
    }
  }
  if (attempt === null) {
    attempt = (memoryCounters.get(key) ?? 0) + 1
    memoryCounters.set(key, attempt)
    if (attempt >= RETRY_ESCALATION_THRESHOLD) memoryCounters.delete(key)
  }
  return {
    attempt,
    escalate: attempt >= RETRY_ESCALATION_THRESHOLD
  }
}
