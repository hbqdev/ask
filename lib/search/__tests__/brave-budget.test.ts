import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  braveBudgetKey,
  braveMonthlyBudget,
  type BudgetClient,
  checkBraveBudget,
  isBraveApiEnabled,
  recordBraveCalls
} from '../brave-budget'

// The Brave provider (type: 'general') spent metered quota with no counter,
// one API call PER content_type, while the advanced-search merge path was
// budget-gated. Both now share this counter under one key.

function fakeClient(initial = 0) {
  const store = new Map<string, number>()
  const expires: Record<string, number> = {}
  if (initial)
    store.set(braveBudgetKey(new Date('2026-07-15T00:00:00Z')), initial)
  return {
    store,
    expires,
    client: {
      get: async (k: string) => store.get(k) ?? null,
      incr: async (k: string) => {
        const n = (store.get(k) ?? 0) + 1
        store.set(k, n)
        return n
      },
      expire: async (k: string, s: number) => {
        expires[k] = s
        return 1
      }
    } satisfies BudgetClient
  }
}

const NOW = new Date('2026-07-15T00:00:00Z')

describe('braveBudgetKey', () => {
  it('is a UTC calendar-month key', () => {
    expect(braveBudgetKey(new Date('2026-07-15T00:00:00Z'))).toBe(
      'brave:budget:2026-07'
    )
  })

  it('zero-pads the month so keys sort lexically', () => {
    expect(braveBudgetKey(new Date('2026-01-05T00:00:00Z'))).toBe(
      'brave:budget:2026-01'
    )
  })

  it('matches the key the advanced-search merge path already writes', () => {
    // Both paths MUST share one counter, otherwise each believes it has the
    // full monthly quota to itself and together they spend double.
    const d = new Date('2026-12-31T23:59:59Z')
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    expect(braveBudgetKey(d)).toBe(`brave:budget:${month}`)
  })
})

describe('braveMonthlyBudget', () => {
  const saved = process.env.BRAVE_MONTHLY_BUDGET
  afterEach(() => {
    if (saved === undefined) delete process.env.BRAVE_MONTHLY_BUDGET
    else process.env.BRAVE_MONTHLY_BUDGET = saved
  })

  it('defaults to the free tier when unset', () => {
    delete process.env.BRAVE_MONTHLY_BUDGET
    expect(braveMonthlyBudget()).toBe(2000)
  })

  it('honours an explicit cap', () => {
    process.env.BRAVE_MONTHLY_BUDGET = '500'
    expect(braveMonthlyBudget()).toBe(500)
  })

  it('treats 0 and garbage as disabled rather than unlimited', () => {
    // A metered paid API must never read "unset/invalid" as "no limit".
    process.env.BRAVE_MONTHLY_BUDGET = '0'
    expect(braveMonthlyBudget()).toBe(0)
    process.env.BRAVE_MONTHLY_BUDGET = 'lots'
    expect(braveMonthlyBudget()).toBe(0)
    process.env.BRAVE_MONTHLY_BUDGET = '-5'
    expect(braveMonthlyBudget()).toBe(0)
  })
})

describe('checkBraveBudget', () => {
  beforeEach(() => {
    process.env.BRAVE_MONTHLY_BUDGET = '10'
    process.env.BRAVE_SEARCH_API_KEY = 'test-key'
  })
  afterEach(() => {
    delete process.env.BRAVE_MONTHLY_BUDGET
    delete process.env.BRAVE_SEARCH_API_KEY
  })

  it('allows a call when under the cap', async () => {
    const { client } = fakeClient(3)
    await expect(checkBraveBudget(1, client, NOW)).resolves.toMatchObject({
      allowed: true,
      used: 3,
      budget: 10
    })
  })

  it('checks the whole block, so a multi-content_type search cannot straddle the cap', async () => {
    // 8 used + 3 calls = 11 > 10. Allowing this would overspend by one.
    const { client } = fakeClient(8)
    await expect(checkBraveBudget(3, client, NOW)).resolves.toMatchObject({
      allowed: false
    })
    // ...but 2 still fits exactly.
    await expect(checkBraveBudget(2, client, NOW)).resolves.toMatchObject({
      allowed: true
    })
  })

  it('denies once the cap is reached', async () => {
    const { client } = fakeClient(10)
    await expect(checkBraveBudget(1, client, NOW)).resolves.toMatchObject({
      allowed: false
    })
  })

  it('fails CLOSED when Redis is missing', async () => {
    // Skipping Brave costs one degraded search; unmetered spend against a paid
    // quota is unrecoverable.
    await expect(checkBraveBudget(1, null, NOW)).resolves.toMatchObject({
      allowed: false
    })
  })

  it('fails CLOSED when the read throws', async () => {
    const client: BudgetClient = {
      get: async () => {
        throw new Error('redis down')
      },
      incr: async () => 1,
      expire: async () => 1
    }
    await expect(checkBraveBudget(1, client, NOW)).resolves.toMatchObject({
      allowed: false
    })
  })

  it('is disabled outright when the budget is 0', async () => {
    process.env.BRAVE_MONTHLY_BUDGET = '0'
    const { client } = fakeClient(0)
    await expect(checkBraveBudget(1, client, NOW)).resolves.toMatchObject({
      allowed: false,
      budget: 0
    })
  })
})

describe('recordBraveCalls', () => {
  beforeEach(() => {
    process.env.BRAVE_MONTHLY_BUDGET = '10'
  })
  afterEach(() => {
    delete process.env.BRAVE_MONTHLY_BUDGET
  })

  it('increments once per API call, not once per search', async () => {
    // The provider fires one call per content_type; counting searches instead
    // of calls is what let this path overspend by up to 3x.
    const { client, store } = fakeClient(0)
    await recordBraveCalls(3, client, NOW)
    expect(store.get(braveBudgetKey(NOW))).toBe(3)
  })

  it('sets an expiry only on the first increment so the month self-resets', async () => {
    const { client, expires } = fakeClient(0)
    await recordBraveCalls(2, client, NOW)
    expect(expires[braveBudgetKey(NOW)]).toBe(60 * 60 * 24 * 35)
  })

  it('does nothing for a zero or negative count', async () => {
    const { client, store } = fakeClient(0)
    await recordBraveCalls(0, client, NOW)
    await recordBraveCalls(-1, client, NOW)
    expect(store.get(braveBudgetKey(NOW))).toBeUndefined()
  })

  it('swallows Redis errors — a search already succeeded', async () => {
    const client: BudgetClient = {
      get: async () => 0,
      incr: async () => {
        throw new Error('redis down')
      },
      expire: async () => 1
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(recordBraveCalls(1, client, NOW)).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe('isBraveApiEnabled', () => {
  afterEach(() => {
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.BRAVE_MONTHLY_BUDGET
  })

  it('needs both a key and a non-zero budget', () => {
    process.env.BRAVE_SEARCH_API_KEY = 'k'
    process.env.BRAVE_MONTHLY_BUDGET = '10'
    expect(isBraveApiEnabled()).toBe(true)

    process.env.BRAVE_MONTHLY_BUDGET = '0'
    expect(isBraveApiEnabled()).toBe(false)

    process.env.BRAVE_MONTHLY_BUDGET = '10'
    delete process.env.BRAVE_SEARCH_API_KEY
    expect(isBraveApiEnabled()).toBe(false)
  })
})
