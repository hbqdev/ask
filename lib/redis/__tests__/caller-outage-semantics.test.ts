// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every module moved onto lib/redis/local-redis.ts must keep the SAME answer
// it gave before when local Redis is unavailable — budgets fail CLOSED, caches
// miss, heartbeats read as "unknown", counters fall back to memory — and must
// now reach that answer in bounded time for every outage shape, including the
// 2026-09-27 one (connected socket, commands that never answer).
//
//   hung     connected + ready, every command never settles
//   offline  connected once, now reconnecting (isReady false): commands
//            reject immediately, as node-redis does with the offline queue off
//   refused  connect() rejects

type Mode = 'hung' | 'offline' | 'refused'

const state = vi.hoisted(() => ({ mode: 'hung' as Mode, created: 0 }))

vi.mock('redis', async () => {
  // Imported here: vi.mock factories are hoisted above the file's imports.
  const { EventEmitter } = await import('node:events')
  class FakeRedis extends EventEmitter {
    isOpen = false
    isReady = false
    async connect() {
      this.isOpen = true
      if (state.mode === 'refused') throw new Error('ECONNREFUSED')
      this.isReady = state.mode === 'hung'
    }
    async disconnect() {
      this.isOpen = false
      this.isReady = false
    }
    private command() {
      if (state.mode === 'hung') return new Promise(() => {})
      return Promise.reject(new Error('The client is offline'))
    }
    get = () => this.command()
    set = () => this.command()
    incr = () => this.command()
    expire = () => this.command()
    del = () => this.command()
  }
  return {
    createClient: () => {
      state.created += 1
      return new FakeRedis()
    }
  }
})

const MODES: Mode[] = ['hung', 'offline', 'refused']
// Every hung command is cut at this bound; each case does at most two.
const BOUND_MS = 1500

beforeEach(() => {
  vi.resetModules()
  state.created = 0
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  vi.stubEnv('LOCAL_REDIS_URL', 'redis://redis:6379')
  vi.stubEnv('LOCAL_REDIS_COMMAND_TIMEOUT_MS', '100')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = Date.now()
  const out = await fn()
  return [out, Date.now() - started]
}

describe.each(MODES)('local Redis %s', mode => {
  beforeEach(() => {
    state.mode = mode
  })

  it('brave budget fails CLOSED, and recording never throws', async () => {
    const { checkBraveBudget, recordBraveCalls } = await import(
      '@/lib/search/brave-budget'
    )
    vi.stubEnv('BRAVE_MONTHLY_BUDGET', '2000')
    const [res, ms] = await timed(() => checkBraveBudget(1))
    expect(res.allowed).toBe(false)
    expect(ms).toBeLessThan(BOUND_MS)
    await expect(recordBraveCalls(1)).resolves.toBeUndefined()
  })

  it('image budget fails CLOSED when a budget is set', async () => {
    const { checkImageBudget, recordImageGeneration } = await import(
      '@/lib/imagegen/budget'
    )
    vi.stubEnv('REPLICATE_MONTHLY_BUDGET', '50')
    const [res, ms] = await timed(() => checkImageBudget())
    expect(res).toEqual({ allowed: false, used: 0, budget: 50 })
    expect(ms).toBeLessThan(BOUND_MS)
    await expect(recordImageGeneration()).resolves.toBeUndefined()
  })

  it('image budget stays unlimited (never touches Redis) when unset', async () => {
    const { checkImageBudget } = await import('@/lib/imagegen/budget')
    vi.stubEnv('REPLICATE_MONTHLY_BUDGET', '')
    await expect(checkImageBudget()).resolves.toEqual({
      allowed: true,
      used: 0,
      budget: null
    })
    expect(state.created).toBe(0)
  })

  it('basic search cache is a miss: the live search runs and returns', async () => {
    const { redisCacheIO, withBasicSearchCache } = await import(
      '@/lib/search/basic-search-cache'
    )
    const fresh = { results: [{ url: 'https://a' }] }
    const search = vi.fn(async () => fresh)
    const [out, ms] = await timed(() =>
      withBasicSearchCache('search:basic:q', search, redisCacheIO)
    )
    expect(out).toBe(fresh)
    expect(search).toHaveBeenCalledTimes(1)
    expect(ms).toBeLessThan(BOUND_MS * 2)
  })

  it('ingest heartbeat reads as unknown (null), never "down"', async () => {
    const { isIngestorAlive, recordIngestHeartbeat } = await import(
      '@/lib/utils/ingest-heartbeat'
    )
    const [alive, ms] = await timed(() => isIngestorAlive())
    expect(alive).toBeNull()
    expect(ms).toBeLessThan(BOUND_MS)
    await expect(recordIngestHeartbeat()).resolves.toBeUndefined()
  })

  it('image retry counter falls back to memory and keeps counting', async () => {
    const { trackRetry } = await import('@/lib/imagegen/retry-tracker')
    const [first, ms] = await timed(() => trackRetry('chat-1', true))
    expect(first).toEqual({ attempt: 1, escalate: false })
    expect(ms).toBeLessThan(BOUND_MS)
    await expect(trackRetry('chat-1', true)).resolves.toEqual({
      attempt: 2,
      escalate: false
    })
  })

  it('image rotation falls back to memory and still rotates', async () => {
    const { nextRotationIndex } = await import('@/lib/imagegen/rotation')
    const [a, ms] = await timed(() => nextRotationIndex('pool', 3))
    expect(ms).toBeLessThan(BOUND_MS)
    const b = await nextRotationIndex('pool', 3)
    expect(b).not.toBe(a)
  })
})
