import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The functions run against a fake RLS-scoped tx: withOptionalRLS hands the
// callback a tx whose builder chain records what it was asked for.
vi.mock('@/lib/db/with-rls', () => ({
  withOptionalRLS: vi.fn((_userId: string, cb: (tx: any) => unknown) =>
    cb(fakeTx)
  )
}))
vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(),
  getConfiguredModel: vi.fn()
}))

import {
  deleteMemory,
  deleteUserSettings,
  listMemories
} from '../memory-actions'
import { userMemories, userSettings } from '../schema'

const dialect = new PgDialect()
const whereSql = (predicate: any) => dialect.sqlToQuery(predicate.getSQL())

// One stored memory with every column, the embedding included.
const STORED = {
  id: 'mem-1',
  userId: 'user-1',
  content: 'Likes TypeScript',
  category: 'preference',
  status: 'confirmed',
  sightings: 2,
  embedding: [0.1, 0.2, 0.3],
  sourceChatId: 'chat-1',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
  lastUsedAt: null
}

let fakeTx: any
let selected: Record<string, unknown> | undefined
let deletedFrom: unknown
let deleteWhere: any
let deletedRows: { id: string }[]

beforeEach(() => {
  selected = undefined
  deletedFrom = undefined
  deleteWhere = undefined
  deletedRows = []
  fakeTx = {
    // select(projection) returns, per stored row, only the projected keys,
    // the way Postgres would; select() with no projection returns every column.
    select: vi.fn((projection?: Record<string, unknown>) => {
      selected = projection
      const rows = projection
        ? [
            Object.fromEntries(
              Object.keys(projection).map(k => [
                k,
                (STORED as Record<string, unknown>)[k]
              ])
            )
          ]
        : [STORED]
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => Promise.resolve(rows)
      }
      return chain
    }),
    delete: vi.fn((table: unknown) => {
      deletedFrom = table
      const result: any = Promise.resolve(undefined)
      const chain = {
        where: (predicate: any) => {
          deleteWhere = predicate
          const done: any = Promise.resolve(undefined)
          done.returning = () => Promise.resolve(deletedRows)
          return done
        }
      }
      return Object.assign(result, chain)
    })
  }
})

describe('listMemories', () => {
  it('never selects the embedding', async () => {
    const rows = await listMemories('user-1')

    expect(selected).toBeDefined()
    expect(Object.keys(selected!)).not.toContain('embedding')
    expect(rows[0]).not.toHaveProperty('embedding')
  })

  it('still returns every other column', async () => {
    const rows = await listMemories('user-1')

    const { embedding: _omitted, ...rest } = STORED
    expect(rows).toEqual([rest])
  })
})

describe('deleteMemory', () => {
  it("returns true when the user's memory was deleted", async () => {
    deletedRows = [{ id: 'mem-1' }]

    expect(await deleteMemory('user-1', 'mem-1')).toBe(true)
    expect(deletedFrom).toBe(userMemories)
  })

  it('returns false when no row matched (missing or foreign)', async () => {
    deletedRows = []

    expect(await deleteMemory('user-1', 'mem-x')).toBe(false)
  })
})

describe('deleteUserSettings', () => {
  it("deletes only that user's settings row", async () => {
    await deleteUserSettings('user-1')

    expect(deletedFrom).toBe(userSettings)
    const { sql, params } = whereSql(deleteWhere)
    expect(sql).toContain('"user_id" = $1')
    expect(params).toEqual(['user-1'])
  })
})
