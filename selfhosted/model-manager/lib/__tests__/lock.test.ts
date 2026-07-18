import { describe, expect, it } from 'vitest'
import { withApplyLock } from '../lock'

describe('withApplyLock', () => {
  it('serializes concurrent calls (no interleave)', async () => {
    const order: string[] = []
    const task = (id: string) => async () => {
      order.push(`${id}-start`)
      await new Promise(r => setTimeout(r, 10))
      order.push(`${id}-end`)
    }
    await Promise.all([withApplyLock(task('a')), withApplyLock(task('b'))])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('a rejecting task does not block the next', async () => {
    await expect(
      withApplyLock(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    const r = await withApplyLock(async () => 42)
    expect(r).toBe(42)
  })
})
