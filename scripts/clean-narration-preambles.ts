/**
 * One-shot DB cleanup: strip "thinking out loud" narration preambles from
 * existing text parts. The same `stripNarrationPreamble` helper used in the
 * live stream transform runs here over every text-text row, idempotently.
 *
 * Usage:
 *   # Dry run (default) — show what would change, do not write
 *   bun run scripts/clean-narration-preambles.ts
 *
 *   # Apply changes
 *   bun run scripts/clean-narration-preambles.ts --apply
 */
import * as dotenv from 'dotenv'
import postgres from 'postgres'

import 'dotenv/config'

import { stripNarrationPreamble } from '../lib/streaming/helpers/strip-narration-preamble'

if (!process.env.DATABASE_URL) {
  dotenv.config({ path: '.env.local' })
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (set it in .env.local or the shell)')
  process.exit(1)
}

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })

  try {
    // Pull all text-text rows. We need (id, text_text) to compute diffs.
    const rows = await sql<{ id: string; text_text: string | null }[]>`
      SELECT id, text_text
      FROM parts
      WHERE type = 'text'
        AND text_text IS NOT NULL
    `

    let changed = 0
    let totalBytesRemoved = 0

    for (const row of rows) {
      if (!row.text_text) continue
      const cleaned = stripNarrationPreamble(row.text_text)
      if (cleaned === row.text_text) continue

      const removed = row.text_text.length - cleaned.length
      changed += 1
      totalBytesRemoved += removed

      console.log(
        `[${apply ? 'APPLY' : 'DRY'}] part=${row.id} ` +
          `before=${row.text_text.length}b after=${cleaned.length}b ` +
          `removed=${removed}b`
      )

      if (apply) {
        await sql`
          UPDATE parts
          SET text_text = ${cleaned}
          WHERE id = ${row.id}
        `
      }
    }

    console.log('')
    console.log(
      `Summary: ${changed} of ${rows.length} text parts would be ${
        apply ? 'updated' : 'updated (dry run)'
      }, ${totalBytesRemoved} bytes stripped total.`
    )
    if (!apply && changed > 0) {
      console.log('Re-run with --apply to persist the changes.')
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch(err => {
  console.error('Clean script failed:', err)
  process.exit(1)
})
