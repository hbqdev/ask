import { beforeEach, describe, expect, it, vi } from 'vitest'

// withOptionalRLS (real, unmocked) drives our mock transaction: with no userId
// it calls callback(db) directly, which is the shape these tests want.
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn()
  }
}))

import { db } from '@/lib/db'

import { deleteMessagesAfter } from '../actions'

/** Chainable stand-in for Drizzle's fluent select/delete builders. */
function makeChain(resolvedValue: unknown) {
  const chain: any = {}
  chain.from = vi.fn(() => chain)
  chain.where = vi.fn(() => chain)
  chain.orderBy = vi.fn(() => chain)
  chain.limit = vi.fn(() => Promise.resolve(resolvedValue))
  chain.then = (resolve: any, reject: any) =>
    Promise.resolve(resolvedValue).then(resolve, reject)
  return chain
}

/**
 * Pull column names out of a Drizzle SQL predicate. `and(eq(a,x), eq(b,y))`
 * builds an SQL object whose queryChunks contain the Column instances, so this
 * is how the test can see WHICH columns the pivot lookup filtered on — the
 * whole point of the fix. Asserting on returned rows cannot distinguish a
 * scoped lookup from an unscoped one, because the mock answers the same either
 * way.
 */
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

describe('deleteMessagesAfter', () => {
  let selectResults: unknown[][]
  let deleteCalled: boolean

  beforeEach(() => {
    vi.clearAllMocks()
    selectResults = []
    deleteCalled = false
  })

  function install(pivotRows: unknown[]) {
    // First select resolves the pivot message; any later select finds the
    // messages to delete.
    let call = 0
    const tx: any = {
      select: vi.fn(() => {
        const rows = call === 0 ? pivotRows : []
        call++
        selectResults.push(rows)
        return makeChain(rows)
      }),
      delete: vi.fn(() => {
        deleteCalled = true
        return makeChain(undefined)
      })
    }
    vi.mocked(db).select = tx.select
    vi.mocked(db).delete = tx.delete
  }

  it('scopes the pivot lookup to this chat, not message id alone', async () => {
    // Regression guard. The pivot used to be resolved by message id ALONE while
    // the delete below is scoped to chatId, so a messageId from another chat
    // supplied a foreign cutoff timestamp and the delete removed whatever in
    // THIS chat fell after it.
    const wherePredicates: any[] = []
    let call = 0
    const chainFor = (rows: unknown[]) => {
      const chain: any = {}
      chain.from = vi.fn(() => chain)
      chain.where = vi.fn((p: any) => {
        wherePredicates.push(p)
        return chain
      })
      chain.limit = vi.fn(() => Promise.resolve(rows))
      chain.then = (res: any, rej: any) => Promise.resolve(rows).then(res, rej)
      return chain
    }
    vi.mocked(db).select = vi.fn(() => chainFor(call++ === 0 ? [] : [])) as any
    vi.mocked(db).delete = vi.fn(() => chainFor([])) as any

    await deleteMessagesAfter('chat-A', 'msg-from-chat-B')

    const cols = columnsIn(wherePredicates[0])
    expect(cols).toContain('id')
    expect(cols).toContain('chat_id')
  })

  it('proceeds when the pivot message does belong to the chat', async () => {
    install([{ createdAt: new Date('2026-01-01T00:00:00Z') }])

    const result = await deleteMessagesAfter('chat-A', 'msg-in-chat-A')

    expect(result.count).toBe(0) // nothing after it in this fixture
    expect(vi.mocked(db).select).toHaveBeenCalled()
  })
})
