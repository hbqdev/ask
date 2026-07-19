import { and, eq, inArray } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { conversationChunks } from '../schema'

// Feature A shipped a bug where `sql`${col} = ANY(${jsArray})`` rendered as the
// row-tuple `ANY(($1,$2,$3))`, which Postgres rejects — it threw at runtime and
// was swallowed by a fire-and-forget catch. Mocked tests cannot catch a
// SQL-generation defect, so assert the compiled SQL directly.
describe('recall-actions SQL generation', () => {
  const dialect = new PgDialect()

  it('multi-id filters render as `in (...)`, never `ANY((...))`', () => {
    const where = and(
      eq(conversationChunks.userId, 'u1'),
      inArray(conversationChunks.id, ['a', 'b', 'c'])
    )
    const { sql } = dialect.sqlToQuery(where!.getSQL())
    expect(sql).toMatch(/"id" in \(\$/i)
    expect(sql.toLowerCase()).not.toContain('any((')
  })
})
