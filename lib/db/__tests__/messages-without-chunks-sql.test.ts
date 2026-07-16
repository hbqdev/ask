import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same pattern as recall-actions-sql.test.ts: mocked tests can't catch a SQL
// generation defect, so assert the compiled SQL text directly. Historically
// (M-3) the bug under test was a whitespace-only-text false positive:
// `HAVING string_agg(...) <> ''` only rejects an EXACT empty string, so a
// message whose only text part is e.g. a single space passes the HAVING
// check, gets no chunk (recall-index.ts's `if (!text.trim()) return 0`),
// and is re-selected on every future call — a rebuild that can never report
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
// of Postgres's space-only trim().
//
// The query was later rewritten (chunk-hygiene fix) to aggregate ALL part
// types (not just type='text') into an ordered `json_agg`, so the caller
// can apply extractIndexableText's final-answer-only rule instead of
// pre-flattening every text part into one string. That means the HAVING
// predicate can no longer run the regex over a `string_agg` of text parts
// alone — it now uses `bool_or(p.type = 'text' AND p.text_text ~
// '[^[:space:]]')` over all joined parts, which preserves the exact same
// semantics (message has at least one non-whitespace text part). Pin the
// regex predicate, and pin the ABSENCE of trim(, so a regression back to
// either the original bug or the first wrong fix fails this test.
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

  function captureSql() {
    const executedSql: unknown[] = []
    const mockTx = {
      execute: vi.fn(async (sqlArg: unknown) => {
        executedSql.push(sqlArg)
        return { rows: [] }
      })
    }
    vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(mockTx))
    return executedSql
  }

  function findSelect(executedSql: unknown[]) {
    const selectCall = executedSql.find(s => {
      const { sql } = dialect.sqlToQuery((s as any).getSQL())
      return sql.toLowerCase().includes('json_agg')
    })
    expect(selectCall).toBeDefined()
    return dialect.sqlToQuery((selectCall as any).getSQL()).sql
  }

  it('HAVING uses a non-whitespace regex test, not trim(), so tabs/newlines are excluded too', async () => {
    const executedSql = captureSql()

    await messagesWithoutChunks('u1', 25)

    const sql = findSelect(executedSql)
    // Pins the fixed predicate: "contains a non-whitespace character",
    // matching the JS guard's `!text.trim()` semantics.
    expect(sql).toContain("~ '[^[:space:]]'")
    // Guard against a regression to EITHER the original un-trimmed
    // exact-empty check OR the space-only trim() "fix" — both let
    // tab/newline-only text through.
    expect(sql.toLowerCase()).not.toContain('trim(')
  })

  it('aggregates ALL part types (not just text) ordered by "order", so the caller can apply extractIndexableText', async () => {
    const executedSql = captureSql()

    await messagesWithoutChunks('u1', 25)

    const sql = findSelect(executedSql)
    expect(sql.toLowerCase()).toContain('json_agg')
    expect(sql.toLowerCase()).toContain('json_build_object')
    expect(sql).toContain('ORDER BY p."order"')
    // The join must no longer restrict to type = 'text' — narration and
    // tool-call parts are needed too, to find the last tool-call boundary.
    expect(sql).not.toContain("AND p.type = 'text'")
  })

  it('excludes already-attempted message ids as a parameterized NOT IN list, never `= ANY(${array})`', async () => {
    const executedSql = captureSql()

    await messagesWithoutChunks('u1', 25, ['m1', 'm2', 'm3'])

    const sql = findSelect(executedSql)
    expect(sql.toLowerCase()).toContain('not in')
    expect(sql.toLowerCase()).not.toContain('any(')
  })

  it('omits the exclusion clause entirely when no ids are passed', async () => {
    const executedSql = captureSql()

    await messagesWithoutChunks('u1', 25)

    const sql = findSelect(executedSql)
    expect(sql.toLowerCase()).not.toContain('not in')
  })
})
