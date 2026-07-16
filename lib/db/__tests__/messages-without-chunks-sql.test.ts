import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same pattern as recall-actions-sql.test.ts: mocked tests can't catch a SQL
// generation defect, so assert the compiled SQL text directly. Here the bug
// under test (M-3) is a whitespace-only-text false positive: `HAVING
// string_agg(...) <> ''` only rejects an EXACT empty string, so a message
// whose only text part is e.g. a single space passes the HAVING check, gets
// no chunk (recall-index.ts's `if (!text.trim()) return 0`), and is
// re-selected on every future call — a rebuild that can never report
// success. `trim()`-ing the aggregate before comparing closes that gap.
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn()
  }
}))

import { db } from '@/lib/db'

import { messagesWithoutChunks } from '../recall-actions'

describe('messagesWithoutChunks SQL generation', () => {
  const dialect = new PgDialect()

  beforeEach(() => vi.clearAllMocks())

  it('wraps the HAVING aggregate in trim() so whitespace-only text is excluded too', async () => {
    const executedSql: unknown[] = []
    const mockTx = {
      execute: vi.fn(async (sqlArg: unknown) => {
        executedSql.push(sqlArg)
        return { rows: [] }
      })
    }
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(mockTx))

    await messagesWithoutChunks('u1', 25)

    const selectCall = executedSql.find(s => {
      const { sql } = dialect.sqlToQuery((s as any).getSQL())
      return sql.toLowerCase().includes('string_agg')
    })
    expect(selectCall).toBeDefined()

    const { sql } = dialect.sqlToQuery((selectCall as any).getSQL())
    expect(sql.toLowerCase()).toMatch(/having\s+trim\(string_agg\(/)
    // Guard against a regression back to the un-trimmed exact-empty check.
    expect(sql.toLowerCase()).not.toMatch(/having\s+string_agg\(/)
  })
})
