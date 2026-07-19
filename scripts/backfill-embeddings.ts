// Re-embed all stored vectors with a new embedding model, via the remote
// GPU embedding service. Used for the mxbai -> Qwen3-Embedding-0.6B
// migration (both 1024-d, so only vector VALUES change, not the schema).
//
// Deliberately self-contained (no lib/ imports): the runtime image ships
// only lib/db + lib/streaming, and this script runs inside the container:
//   docker exec ask bun scripts/backfill-embeddings.ts --apply
//
// Dry-run by default (prints row counts); pass --apply to write. Safe to
// re-run: every row is simply re-embedded and overwritten. Rows written by
// the app DURING a run come out in the new space already if EMBEDDING_MODEL
// has been flipped first, so run this right after the flip.
import * as dotenv from 'dotenv'
import postgres from 'postgres'

import 'dotenv/config'

if (!process.env.DATABASE_URL) {
  dotenv.config({ path: '.env.local' })
}

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const MODEL =
  process.argv
    .slice(2)
    .find(arg => arg.startsWith('--model='))
    ?.slice('--model='.length) ?? 'Qwen/Qwen3-Embedding-0.6B'

const BATCH = 32
const EXPECTED_DIMS = 1024

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}
if (
  !process.env.EMBEDDING_SERVICE_URL ||
  !process.env.EMBEDDING_SERVICE_TOKEN
) {
  console.error(
    'EMBEDDING_SERVICE_URL / EMBEDDING_SERVICE_TOKEN are required — the ' +
      'backfill embeds through the GPU service'
  )
  process.exit(1)
}

async function embedRemote(texts: string[]): Promise<number[][]> {
  const baseUrl = (process.env.EMBEDDING_SERVICE_URL as string).replace(
    /\/$/,
    ''
  )
  const response = await fetch(`${baseUrl}/embed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.EMBEDDING_SERVICE_TOKEN}`
    },
    body: JSON.stringify({ texts, model: MODEL, kind: 'document' })
  })
  if (!response.ok) throw new Error(`embedder HTTP ${response.status}`)
  const json = (await response.json()) as { embeddings?: number[][] }
  if (
    !Array.isArray(json.embeddings) ||
    json.embeddings.length !== texts.length
  ) {
    throw new Error('embedder returned a malformed embeddings array')
  }
  return json.embeddings
}

function toVecLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}

async function backfillTable(
  sql: postgres.Sql,
  table: 'user_memories' | 'conversation_chunks'
) {
  const rows = await sql<{ id: string; content: string }[]>`
    SELECT id, content FROM ${sql(table)} ORDER BY created_at
  `
  let updated = 0
  const started = Date.now()

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    if (!apply) continue
    const embeddings = await embedRemote(batch.map(r => r.content))
    for (let j = 0; j < batch.length; j++) {
      const vec = embeddings[j]
      if (!vec || vec.length !== EXPECTED_DIMS) {
        throw new Error(
          `${table} row ${batch[j].id}: got ${vec?.length ?? 0} dims, expected ${EXPECTED_DIMS}`
        )
      }
      await sql`
        UPDATE ${sql(table)}
        SET embedding = ${toVecLiteral(vec)}::vector
        WHERE id = ${batch[j].id}
      `
      updated++
    }
    console.log(`[${table}] ${Math.min(i + BATCH, rows.length)}/${rows.length}`)
  }

  return { total: rows.length, updated, seconds: (Date.now() - started) / 1000 }
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, {
    ssl:
      process.env.DATABASE_SSL_DISABLED === 'true'
        ? false
        : { rejectUnauthorized: false },
    prepare: false
  })

  try {
    const memories = await backfillTable(sql, 'user_memories')
    const chunks = await backfillTable(sql, 'conversation_chunks')
    console.log(
      JSON.stringify(
        { mode: apply ? 'apply' : 'dry-run', model: MODEL, memories, chunks },
        null,
        2
      )
    )
    if (!apply) console.log('Re-run with --apply to rewrite vectors.')
  } finally {
    await sql.end()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
