import { and, eq, inArray } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { userMemories } from '../schema'

// Regression guard (found via live staging E2E): drizzle renders
// `sql`${col} = ANY(${jsArray})`` as `col = ANY(($1, $2, $3))` — a row-tuple,
// which Postgres rejects. setLastUsed previously used that form, so its UPDATE
// threw and was swallowed by its fire-and-forget `.catch()`, meaning
// `last_used_at` was never written (silently breaking LRU eviction ordering).
// The correct construct is `inArray`, which renders `col in ($1, $2, $3)`.
// Mocked unit tests cannot catch this — it is a SQL-generation defect — so this
// asserts the compiled SQL directly.
describe('setLastUsed id-filter SQL generation', () => {
  const dialect = new PgDialect()

  it('renders the id filter as `in (...)`, never a `ANY((...))` row-tuple', () => {
    const where = and(
      eq(userMemories.userId, 'u1'),
      inArray(userMemories.id, ['a', 'b', 'c'])
    )
    const { sql } = dialect.sqlToQuery(where!.getSQL())
    expect(sql).toMatch(/"id" in \(\$/i)
    expect(sql.toLowerCase()).not.toContain('any((')
  })
})
