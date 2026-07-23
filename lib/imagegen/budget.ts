// Server-only monthly spend guard for Replicate image generation. Mirrors the
// Tavily budget in app/api/advanced-search/route.ts: a soft, calendar-month
// counter in Redis (Upstash REST or local `redis`, chosen by env) that gates a
// metered external API.
//
// REPLICATE_MONTHLY_BUDGET caps generations per UTC month. Unset / 0 / NaN =
// unlimited, and in that case we never touch Redis. When a budget IS set but
// Redis can't be read, we fail CLOSED (deny) so a cache outage can't blow the
// month's spend. Recording a generation is best-effort: a failed INCR must
// never fail a generation that already succeeded.

import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

let redisClient: Redis | ReturnType<typeof createClient> | null = null

// Initialize Redis client based on environment variables. Copied from the
// advanced-search route's pattern (Upstash REST when configured, otherwise a
// local redis:// connection) rather than imported, to keep this guard free of
// the route module's heavy transitive imports.
async function initializeRedisClient() {
  if (redisClient) return redisClient

  const upstashRedisRestUrl = process.env.UPSTASH_REDIS_REST_URL
  const upstashRedisRestToken = process.env.UPSTASH_REDIS_REST_TOKEN

  if (upstashRedisRestUrl && upstashRedisRestToken) {
    redisClient = new Redis({
      url: upstashRedisRestUrl,
      token: upstashRedisRestToken
    })
    return redisClient
  }

  try {
    const localRedisUrl =
      process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
    const client = createClient({ url: localRedisUrl })
    await client.connect()
    redisClient = client
  } catch (error) {
    console.warn(
      'Failed to connect to local Redis. Image budget guard disabled.',
      error
    )
    redisClient = null
  }

  return redisClient
}

// Both Upstash and local `redis` expose get/incr/expire with compatible
// signatures for our use, so narrow to the minimal surface (as the Tavily
// budget does) instead of branching on `instanceof Redis`.
type BudgetClient = {
  get(key: string): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

function getMonthlyBudget(): number | null {
  const raw = process.env.REPLICATE_MONTHLY_BUDGET
  if (!raw) return null
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function currentBudgetKey(): string {
  const d = new Date()
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return `replicate:budget:${month}`
}

/**
 * Whether an image generation is allowed under this UTC month's budget. When no
 * budget is configured this is unlimited and never touches Redis. When a budget
 * is set it reads the month's counter and denies at/over the cap; a Redis read
 * failure fails CLOSED (denies) so a cache outage can't blow the month's spend.
 */
export async function checkImageBudget(): Promise<{
  allowed: boolean
  used: number
  budget: number | null
}> {
  const budget = getMonthlyBudget()
  if (budget === null) return { allowed: true, used: 0, budget: null }

  const rawClient = await initializeRedisClient()
  if (!rawClient) {
    console.warn('[imagegen] budget: Redis unavailable, denying generation')
    return { allowed: false, used: 0, budget }
  }
  const client = rawClient as unknown as BudgetClient

  try {
    const used = Number(await client.get(currentBudgetKey())) || 0
    return { allowed: used < budget, used, budget }
  } catch (error) {
    console.warn('[imagegen] budget read failed, denying generation:', error)
    return { allowed: false, used: 0, budget }
  }
}

/**
 * Record one successful generation against this UTC month's counter. Best
 * effort: increments the key and sets a ~35-day expiry only on the first
 * increment (so the counter self-resets each calendar month), and swallows any
 * Redis error — a failed record must not fail a generation that already
 * succeeded. No-ops when no budget is configured.
 */
export async function recordImageGeneration(): Promise<void> {
  if (getMonthlyBudget() === null) return

  const rawClient = await initializeRedisClient()
  if (!rawClient) return
  const client = rawClient as unknown as BudgetClient

  const key = currentBudgetKey()
  try {
    const n = await client.incr(key)
    // Expire ~35 days out so the counter resets each calendar month.
    if (n === 1) await client.expire(key, 60 * 60 * 24 * 35)
  } catch (error) {
    console.warn('[imagegen] budget increment failed:', error)
  }
}
