import { beforeEach, describe, expect, it, vi } from 'vitest'

// withRLS (real, unmocked) runs its callback inside db.transaction, first
// issuing set_config to pin app.current_user_id. Mocking db.transaction lets us
// drive that callback against a fake tx that behaves like an RLS-scoped DB.
vi.mock('@/lib/db', () => ({
  db: { transaction: vi.fn() }
}))

import { db } from '@/lib/db'

import { countUserChats } from '../actions'

// A two-user fixture "table". A COUNT(*) scoped to one user must never see the
// other user's rows.
const CHAT_ROWS = [
  { id: 'c1', userId: 'user-1' },
  { id: 'c2', userId: 'user-1' },
  { id: 'c3', userId: 'user-1' },
  { id: 'c4', userId: 'user-2' } // another user's chat — must NOT be counted
]

/** Column names referenced by a Drizzle predicate (e.g. the WHERE clause). */
function columnsIn(predicate: any): string[] {
  const found: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.name === 'string' && node.table) found.push(node.name)
    const chunks = node.queryChunks ?? node.chunks
    if (Array.isArray(chunks)) chunks.forEach(walk)
    if (Array.isArray(node)) node.forEach(walk)
  }
  walk(predicate)
  return found
}

/** Bound param values in a Drizzle predicate (Param nodes carry `.value`). */
function paramsIn(predicate: any): unknown[] {
  const found: unknown[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if ('encoder' in node && 'value' in node) found.push(node.value)
    const chunks = node.queryChunks ?? node.chunks
    if (Array.isArray(chunks)) chunks.forEach(walk)
    if (Array.isArray(node)) node.forEach(walk)
  }
  walk(predicate)
  return found
}

describe('countUserChats', () => {
  let wheredPredicate: any

  beforeEach(() => {
    vi.clearAllMocks()
    wheredPredicate = undefined
    // db.transaction(cb) → cb(tx). tx.select().from().where() filters the
    // fixture rows by the user_id bound into the WHERE predicate — exactly what
    // an RLS-scoped COUNT(*) sees — and returns [{ value }] like drizzle's
    // count().
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
      const tx: any = {
        execute: vi.fn(() => Promise.resolve()), // set_config no-op
        select: vi.fn(() => {
          const chain: any = {}
          chain.from = vi.fn(() => chain)
          chain.where = vi.fn((predicate: any) => {
            wheredPredicate = predicate
            const owners = paramsIn(predicate)
            const value = CHAT_ROWS.filter(r =>
              owners.includes(r.userId)
            ).length
            return Promise.resolve([{ value }])
          })
          return chain
        })
      }
      return cb(tx)
    })
  })

  it("returns the number of the user's chats", async () => {
    expect(await countUserChats('user-1')).toBe(3)
  })

  it('is RLS-scoped: a chat owned by another user is not counted', async () => {
    // user-2 owns c4 only; user-1's three chats never leak into the count.
    expect(await countUserChats('user-2')).toBe(1)
    expect(columnsIn(wheredPredicate)).toContain('user_id')
    expect(paramsIn(wheredPredicate)).toContain('user-2')
  })

  it('returns 0 when the user has no chats', async () => {
    expect(await countUserChats('user-nobody')).toBe(0)
  })
})
