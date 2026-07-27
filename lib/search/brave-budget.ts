// Monthly spend guard for the Brave Search API.
//
// Brave is metered (free tier ~2,000 calls/month) and we call it from TWO
// independent places:
//
//   1. app/api/advanced-search/route.ts   — the merge client, already gated
//   2. lib/tools/search/providers/brave.ts — the general-search provider,
//      which until now spent quota with no counter at all
//
// (2) is the expensive one: it fires one API call PER content_type, so a
// single `type: 'general'` search with content_types ['web','video','image']
// is three calls. Unmetered, that path could exhaust the month's quota while
// the metered path still believed it had budget left.
//
// This module exists so both paths share ONE counter under ONE key. The key
// format and the BRAVE_MONTHLY_BUDGET semantics deliberately match the route's
// existing implementation exactly (`brave:budget:YYYY-MM`, default 2000,
// 0 = disabled) — a second meaning for the same env var would be worse than no
// meter at all, because the number in the dashboard would stop matching the
// number the code enforces.
//
// Shape mirrors lib/imagegen/budget.ts, with one deliberate difference: that
// guard treats "unset" as unlimited, this one treats it as the 2000 default,
// because Brave bills and Replicate's guard is opt-in.

import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

/** Redis list of the minimal surface both dialects agree on. */
export type BudgetClient = {
  get(key: string): Promise<unknown>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
}

let redisClient: Redis | ReturnType<typeof createClient> | null = null

async function initializeRedisClient() {
  if (redisClient) return redisClient

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    redisClient = new Redis({ url, token })
    return redisClient
  }

  try {
    const client = createClient({
      url: process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
    })
    await client.connect()
    redisClient = client
  } catch (error) {
    console.warn('[brave] budget: Redis unavailable', error)
    redisClient = null
  }
  return redisClient
}

/** UTC-month counter key. Shared with the advanced-search merge path. */
export function braveBudgetKey(now: Date = new Date()): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return `brave:budget:${month}`
}

/** Cap for this month. 0 (or a non-numeric value) disables Brave entirely. */
export function braveMonthlyBudget(): number {
  return Math.max(
    0,
    parseInt(process.env.BRAVE_MONTHLY_BUDGET || '2000', 10) || 0
  )
}

/** The provider is usable when a key exists and the budget is non-zero. */
export function isBraveApiEnabled(): boolean {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY) && braveMonthlyBudget() > 0
}

/**
 * Whether `calls` more Brave API calls fit in this month's budget.
 *
 * Fails CLOSED on a Redis outage, matching the merge path: skipping Brave
 * costs one degraded search, while spending unmetered against a paid quota is
 * unrecoverable. `calls` is checked as a block so a 3-content_type search
 * cannot straddle the cap.
 */
export async function checkBraveBudget(
  calls: number = 1,
  client?: BudgetClient | null,
  now: Date = new Date()
): Promise<{ allowed: boolean; used: number; budget: number }> {
  const budget = braveMonthlyBudget()
  if (budget <= 0) return { allowed: false, used: 0, budget }

  const c =
    client ??
    ((await initializeRedisClient()) as unknown as BudgetClient | null)
  if (!c) {
    console.warn('[brave] budget: Redis unavailable, skipping Brave')
    return { allowed: false, used: 0, budget }
  }

  try {
    const used = Number(await c.get(braveBudgetKey(now))) || 0
    return { allowed: used + calls <= budget, used, budget }
  } catch (error) {
    console.warn('[brave] budget read failed, skipping Brave:', error)
    return { allowed: false, used: 0, budget }
  }
}

/**
 * Record `calls` SUCCESSFUL Brave API calls against this month.
 *
 * Best effort — a failed counter write must never fail a search whose results
 * are already in hand. Counts only successful calls so a Brave outage cannot
 * burn the month's quota, which is why this is separate from the check.
 *
 * Uses repeated INCR rather than INCRBY on purpose: node-redis spells it
 * `incrBy` and Upstash spells it `incrby`, and that dialect split has already
 * caused a silent no-op once in this codebase (see lib/telemetry/latency-store.ts).
 * `calls` is at most 3, so the extra round trips are irrelevant.
 */
export async function recordBraveCalls(
  calls: number,
  client?: BudgetClient | null,
  now: Date = new Date()
): Promise<void> {
  if (calls <= 0 || braveMonthlyBudget() <= 0) return

  const c =
    client ??
    ((await initializeRedisClient()) as unknown as BudgetClient | null)
  if (!c) return

  const key = braveBudgetKey(now)
  try {
    for (let i = 0; i < calls; i++) {
      const n = await c.incr(key)
      // ~35 days so the counter self-resets each calendar month.
      if (n === 1) await c.expire(key, 60 * 60 * 24 * 35)
    }
  } catch (error) {
    console.warn('[brave] budget increment failed:', error)
  }
}
