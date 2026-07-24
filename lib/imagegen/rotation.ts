// Per-pool round-robin counters for image model rotation. Same Redis client
// pattern as budget.ts (Upstash REST when configured, else local redis://),
// with an in-process fallback so rotation still varies engines when Redis is
// down — degraded (resets on restart, per-process) but never broken.

import { Redis } from '@upstash/redis'
import { createClient } from 'redis'

type CounterClient = { incr(key: string): Promise<number> }

let client: CounterClient | null = null
let clientInitialized = false
let clientOverridden = false
const memoryCounters = new Map<string, number>()

async function getRotationClient(): Promise<CounterClient | null> {
  if (clientOverridden || clientInitialized) return client
  clientInitialized = true

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    client = new Redis({ url, token })
    return client
  }
  try {
    const local = createClient({
      url: process.env.LOCAL_REDIS_URL || 'redis://localhost:6379'
    })
    await local.connect()
    client = local as unknown as CounterClient
  } catch (error) {
    console.warn('[imagegen] rotation: Redis unavailable, using memory:', error)
    client = null
  }
  return client
}

export function __setRotationClientForTests(c: CounterClient | null): void {
  client = c
  clientOverridden = true
  memoryCounters.clear()
}

export function __resetRotationForTests(): void {
  client = null
  clientInitialized = false
  clientOverridden = false
  memoryCounters.clear()
}

function nextFromMemory(key: string, poolSize: number): number {
  const n = (memoryCounters.get(key) ?? 0) + 1
  memoryCounters.set(key, n)
  return (n - 1) % poolSize
}

/**
 * 0-based rotation index for a pool. Consecutive calls on the same poolKey
 * never return the same index (poolSize >= 2), which is what makes a retry
 * land on a different engine.
 */
export async function nextRotationIndex(
  poolKey: string,
  poolSize: number
): Promise<number> {
  if (poolSize <= 1) return 0
  const key = `imagegen:rr:${poolKey}`
  const c = await getRotationClient()
  if (c) {
    try {
      const n = await c.incr(key)
      return (n - 1) % poolSize
    } catch (error) {
      console.warn('[imagegen] rotation INCR failed, using memory:', error)
    }
  }
  return nextFromMemory(key, poolSize)
}
