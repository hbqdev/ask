import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same pattern as recall-actions-sql.test.ts: mocked tests can't catch a SQL
// generation defect, so assert the compiled SQL text directly. Here the bug
// under test (M-3) is a whitespace-only-text false positive: `HAVING
// string_agg(...) <> ''` only rejects an EXACT empty string, so a message
// whose only text part is e.g. a single space passes the HAVING check, gets
// no chunk (recall-index.ts's `if (!text.trim()) return 0`), and is
// re-selected on every future call — a rebuild that can never report
// success.
//
// M-3 was first "fixed" by wrapping the aggregate in `trim(...)  <> ''`.
// That was ALSO wrong: Postgres's trim()/btrim() strips SPACES ONLY, not
// tabs or newlines (verified live against pg17: `trim(E'\t') <> ''` and
// `trim(E'\n') <> ''` are both true). Meanwhile recall-index.ts's JS guard
// is `if (!text.trim()) return 0`, and JS's String.prototype.trim() strips
// ALL whitespace (tabs, newlines, etc). That mismatch meant a message whose
// text collapsed to just "\t" or "\n" still passed the SQL HAVING, got
// selected, got rejected by the JS guard with 0 chunks, and was reselected
// forever — the exact bug M-3 was filed to close, just with a narrower
// trigger. The real fix is a "contains a non-whitespace character" test
// (`~ '[^[:space:]]'`), which agrees with the JS guard's semantics instead
// of Postgres's space-only trim(). Pin the regex predicate, and pin the
// ABSENCE of trim(string_agg(, so a regression back to either the original
// bug or the first wrong fix fails this test.
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

  it('HAVING uses a non-whitespace regex test, not trim(), so tabs/newlines are excluded too', async () => {
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
    // Pins the fixed predicate: "contains a non-whitespace character",
    // matching the JS guard's `!text.trim()` semantics.
    expect(sql).toContain("~ '[^[:space:]]'")
    // Guard against a regression to EITHER the original un-trimmed
    // exact-empty check OR the space-only trim() "fix" — both let
    // tab/newline-only text through.
    expect(sql.toLowerCase()).not.toContain('trim(string_agg(')
  })
})
