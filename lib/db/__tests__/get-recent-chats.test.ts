import { beforeEach, describe, expect, it, vi } from 'vitest'

// withRLS (real, unmocked) runs its callback inside db.transaction, first
// issuing set_config to pin app.current_user_id. Mocking db.transaction lets us
// drive that callback against a fake tx that behaves like an RLS-scoped DB.
vi.mock('@/lib/db', () => ({
  db: { transaction: vi.fn() }
}))

import { db } from '@/lib/db'

import { getRecentChats } from '../actions'

type Row = {
  id: string
  title: string
  userId: string
  lastViewedAt: Date | null
  createdAt: Date
}

const d = (iso: string) => new Date(iso)

// A two-user fixture "table", deliberately out of recency order so the ORDER BY
// (lastViewedAt DESC NULLS LAST, createdAt DESC) has to do real work. `n1` has
// never been reopened (lastViewedAt null) so it must sort by createdAt, after
// every viewed chat.
const CHAT_ROWS: Row[] = [
  {
    id: 'c-old',
    title: 'Oldest viewed',
    userId: 'user-1',
    lastViewedAt: d('2026-08-10T09:00:00Z'),
    createdAt: d('2026-01-01T00:00:00Z')
  },
  {
    id: 'c-new',
    title: 'Most recent',
    userId: 'user-1',
    lastViewedAt: d('2026-08-16T12:00:00Z'),
    createdAt: d('2026-02-01T00:00:00Z')
  },
  {
    id: 'c-mid',
    title: 'Middle',
    userId: 'user-1',
    lastViewedAt: d('2026-08-14T08:00:00Z'),
    createdAt: d('2026-03-01T00:00:00Z')
  },
  {
    id: 'n1',
    title: 'Never reopened',
    userId: 'user-1',
    lastViewedAt: null,
    createdAt: d('2026-08-15T00:00:00Z')
  },
  {
    id: 'other',
    title: "Someone else's chat",
    userId: 'user-2',
    lastViewedAt: d('2026-08-16T23:00:00Z'),
    createdAt: d('2026-08-16T23:00:00Z')
  } // must NEVER appear for user-1
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

// lastViewedAt DESC NULLS LAST, then createdAt DESC — the exact order the query
// asks Postgres for, reproduced here so the mock returns realistically-sorted
// rows.
function compareRecent(a: Row, b: Row): number {
  const av = a.lastViewedAt?.getTime()
  const bv = b.lastViewedAt?.getTime()
  if (av !== bv) {
    if (av === undefined) return 1 // a is null → sorts last
    if (bv === undefined) return -1 // b is null → sorts last
    return bv - av // DESC
  }
  return b.createdAt.getTime() - a.createdAt.getTime() // DESC
}

describe('getRecentChats', () => {
  let wheredPredicate: any
  let selectedProjection: Record<string, unknown> | undefined
  let limitArg: number | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    wheredPredicate = undefined
    selectedProjection = undefined
    limitArg = undefined
    // db.transaction(cb) → cb(tx). The fake tx mirrors an RLS-scoped read:
    // .where() filters the fixture by the user_id bound into the predicate,
    // .orderBy() applies the recency comparator, .limit() slices.
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
      const tx: any = {
        execute: vi.fn(() => Promise.resolve()), // set_config no-op
        select: vi.fn((projection: Record<string, unknown>) => {
          selectedProjection = projection
          let rows: Row[] = []
          const chain: any = {}
          chain.from = vi.fn(() => chain)
          chain.where = vi.fn((predicate: any) => {
            wheredPredicate = predicate
            const owners = paramsIn(predicate)
            rows = CHAT_ROWS.filter(r => owners.includes(r.userId))
            return chain
          })
          chain.orderBy = vi.fn(() => {
            rows = [...rows].sort(compareRecent)
            return chain
          })
          chain.limit = vi.fn((n: number) => {
            limitArg = n
            return Promise.resolve(rows.slice(0, n))
          })
          return chain
        })
      }
      return cb(tx)
    })
  })

  it("returns the user's chats newest-viewed first (nulls last)", async () => {
    const rows = await getRecentChats('user-1')
    expect(rows.map(r => r.id)).toEqual(['c-new', 'c-mid', 'c-old', 'n1'])
  })

  it('never exceeds the requested limit', async () => {
    const rows = await getRecentChats('user-1', 2)
    expect(limitArg).toBe(2)
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.id)).toEqual(['c-new', 'c-mid'])
  })

  it('defaults the limit to 10', async () => {
    await getRecentChats('user-1')
    expect(limitArg).toBe(10)
  })

  it("is RLS-scoped: another user's chats never leak in", async () => {
    const rows = await getRecentChats('user-2')
    expect(rows.map(r => r.id)).toEqual(['other'])
    expect(columnsIn(wheredPredicate)).toContain('user_id')
    expect(paramsIn(wheredPredicate)).toContain('user-2')
  })

  it('selects only id, title, lastViewedAt and createdAt', async () => {
    await getRecentChats('user-1')
    expect(Object.keys(selectedProjection ?? {}).sort()).toEqual([
      'createdAt',
      'id',
      'lastViewedAt',
      'title'
    ])
  })

  it('returns an empty list for a user with no chats', async () => {
    expect(await getRecentChats('user-nobody')).toEqual([])
  })
})
