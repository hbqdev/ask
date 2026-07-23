import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkImageBudget, recordImageGeneration } from '../budget'

const mockGet = vi.fn()
const mockIncr = vi.fn()
const mockExpire = vi.fn()

// Mirror the rate-limit tests: drive the Upstash branch of the shared Redis
// init by stubbing the UPSTASH_* env vars, and mock @upstash/redis so the
// constructor hands back our spy client.
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(function () {
    return {
      get: mockGet,
      incr: mockIncr,
      expire: mockExpire
    }
  })
}))

const KEY_RE = /^replicate:budget:\d{4}-\d{2}$/

describe('image generation monthly budget', () => {
  beforeEach(() => {
    mockGet.mockReset()
    mockIncr.mockReset()
    mockExpire.mockReset()
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.com')
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token')
  })

  afterEach(() => vi.unstubAllEnvs())

  describe('checkImageBudget', () => {
    it.each([
      ['unset', ''],
      ['zero', '0'],
      ['NaN', 'not-a-number']
    ])(
      'treats %s budget as unlimited without touching Redis',
      async (_label, value) => {
        vi.stubEnv('REPLICATE_MONTHLY_BUDGET', value)

        const result = await checkImageBudget()

        expect(result).toEqual({ allowed: true, used: 0, budget: null })
        expect(mockGet).not.toHaveBeenCalled()
      }
    )

    it('allows generation while under the monthly budget', async () => {
      vi.stubEnv('REPLICATE_MONTHLY_BUDGET', '10')
      mockGet.mockResolvedValue(5)

      const result = await checkImageBudget()

      expect(result).toEqual({ allowed: true, used: 5, budget: 10 })
      expect(mockGet).toHaveBeenCalledWith(expect.stringMatching(KEY_RE))
    })

    it('denies generation at the monthly budget', async () => {
      vi.stubEnv('REPLICATE_MONTHLY_BUDGET', '10')
      mockGet.mockResolvedValue(10)

      const result = await checkImageBudget()

      expect(result).toEqual({ allowed: false, used: 10, budget: 10 })
    })

    it('denies generation over the monthly budget', async () => {
      vi.stubEnv('REPLICATE_MONTHLY_BUDGET', '10')
      mockGet.mockResolvedValue(11)

      const result = await checkImageBudget()

      expect(result.allowed).toBe(false)
      expect(result.used).toBe(11)
    })

    it('fails closed (denies) when a budget is set but the Redis read errors', async () => {
      vi.stubEnv('REPLICATE_MONTHLY_BUDGET', '10')
      mockGet.mockRejectedValue(new Error('redis down'))

      const result = await checkImageBudget()

      expect(result.allowed).toBe(false)
      expect(result.budget).toBe(10)
    })
  })

  describe('recordImageGeneration', () => {
    it('increments the counter and sets a ~35d expiry only on the first increment', async () => {
      vi.stubEnv('REPLICATE_MONTHLY_BUDGET', '10')
      mockIncr.mockResolvedValue(1)
      mockExpire.mockResolvedValue(1)

      await recordImageGeneration()

      expect(mockIncr).toHaveBeenCalledTimes(1)
      expect(mockIncr).toHaveBeenCalledWith(expect.stringMatching(KEY_RE))
      expect(mockExpire).toHaveBeenCalledTimes(1)
      expect(mockExpire).toHaveBeenCalledWith(
        expect.stringMatching(KEY_RE),
        60 * 60 * 24 * 35
      )

      // A later increment in the same month must not reset the expiry.
      mockExpire.mockClear()
      mockIncr.mockResolvedValue(2)

      await recordImageGeneration()

      expect(mockExpire).not.toHaveBeenCalled()
    })

    it('swallows Redis errors so a failed record cannot fail the generation', async () => {
      vi.stubEnv('REPLICATE_MONTHLY_BUDGET', '10')
      mockIncr.mockRejectedValue(new Error('redis down'))

      await expect(recordImageGeneration()).resolves.toBeUndefined()
    })
  })
})
