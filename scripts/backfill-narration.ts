/**
 * Narration storage backfill (D20 addendum, 2026-09-28).
 *
 * New answers are persisted narration-free, and every reader cleans stored
 * answers at read time (`narrationCleanView`), but OLD rows still hold the
 * leaked "thinking out loud" text: inter-step status notes as their own text
 * parts, and preambles fused in front of the answer's `## ` heading. This
 * script removes them from storage with the app's own code:
 *
 *   rows → buildUIMessageFromDB → stripNarrationFromMessage → row diff
 *
 * (see `scripts/backfill-narration-plan.ts`). Only assistant messages, only
 * `type='text'` rows; a dropped part's row is DELETED, a cut part's
 * `text_text` is UPDATED; nothing is reordered (the loader sorts by `order`,
 * so gaps are harmless). User messages and non-text parts are never touched.
 *
 * Modes (combine as listed; the report is written on every run):
 *   (default)              dry run: counts, per-message summary, JSON report
 *   --backup <file>        also write a backup (full rows of every affected
 *                          part + the recall chunks of every affected
 *                          message). Read-only. Refuses to overwrite a file.
 *   --apply --backup <f>   delete/update exactly the planned rows, ONE
 *                          transaction per message; needs the backup file to
 *                          exist, match this database and hold the current
 *                          pre-image of every row it changes.
 *   --reindex --backup <f> rebuild (indexMessage, the app's own path) the
 *                          recall chunks of the backup's messages whose stored
 *                          chunks differ from what that path now produces AND
 *                          hold narration: an answer was rewritten, or a chunk
 *                          contains removed text (`recallAction`). Chunks
 *                          stale for unrelated reasons are left alone.
 *   --verify --backup <f>  read-only: reload every backup message through the
 *                          app's loader and check it equals the render view.
 * Options: --report <file>, --since YYYY-MM-DD, --chat <id> (repeatable),
 *          --spot <n> (with --verify: print n changed chats' parts).
 *
 * Connection: DATABASE_URL must be the OWNER role (dbAdmin); the script
 * refuses to run with DATABASE_RESTRICTED_URL set (app_user, RLS). Nothing
 * secret is printed. Run it through `scripts/backfill-narration.sh <env>`,
 * which reads the env's own app-container settings and runs this file in a
 * throwaway container on that stack's docker network with `bun
 * --no-env-file` (bun would otherwise auto-load the worktree's `.env`).
 *
 * Why one transaction per message: each message's cleanup is independent
 * and self-verifying, so a failure rolls back only that message and leaves
 * every other one either fully old or fully cleaned — a consistent state the
 * idempotent re-run simply continues from. Per-message transactions also
 * keep row locks short on a live database (the message row is locked FOR
 * UPDATE, which serialises against the app's own upsertMessage).
 */
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { chats, conversationChunks, messages, parts } from '@/lib/db/schema'
import { stripNarrationFromMessage } from '@/lib/streaming/helpers/strip-narration-from-message'
import { buildUIMessageFromDB } from '@/lib/utils/message-mapping'

import {
  applyPlanToRows,
  countChunksWithProbes,
  expectedRecallChunks,
  hashParts,
  type MessageCleanupPlan,
  type MessageRow,
  narrationOnlyInChunks,
  type PartRow,
  planMessageCleanup,
  type RecallAction,
  recallAction,
  removedTextProbes
} from './backfill-narration-plan'

// The recall embedder is data-locked to the vector(1024) columns.
const RECALL_MODEL = 'Qwen/Qwen3-Embedding-0.6B'
const RECALL_DIMS = 1024
// The last English narration rule landed 2026-09-17 (0290896c).
const ENGLISH_RULES_DATE = new Date('2026-09-17T00:00:00Z')
const MESSAGE_BATCH = 100

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface Args {
  apply: boolean
  reindex: boolean
  verify: boolean
  backup?: string
  report?: string
  since?: Date
  chats: string[]
  spot: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    reindex: false,
    verify: false,
    chats: [],
    spot: 0
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--dry-run') continue
    else if (a === '--apply') args.apply = true
    else if (a === '--reindex') args.reindex = true
    else if (a === '--verify') args.verify = true
    else if (a === '--backup') args.backup = path.resolve(value())
    else if (a === '--report') args.report = path.resolve(value())
    else if (a === '--chat') args.chats.push(value())
    else if (a === '--spot') args.spot = Number(value())
    else if (a === '--since') {
      const d = new Date(`${value()}T00:00:00Z`)
      if (Number.isNaN(d.getTime())) throw new Error('--since wants YYYY-MM-DD')
      args.since = d
    } else throw new Error(`unknown argument ${a}`)
  }
  if ((args.apply || args.reindex || args.verify) && !args.backup) {
    throw new Error(
      '--apply / --reindex / --verify need --backup <file> (an existing backup)'
    )
  }
  return args
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

interface DbIdentity {
  database: string
  systemIdentifier: string
  user: string
}

interface BackupMessage {
  messageId: string
  chatId: string
  userId: string
  createdAt: string
  plan: {
    drops: MessageCleanupPlan['drops']
    rewrites: MessageCleanupPlan['rewrites']
    renderViewHash: string
  }
}

interface BackupFile {
  kind: 'narration-backfill-backup'
  version: 1
  label: string
  createdAt: string
  db: DbIdentity
  messages: BackupMessage[]
  /** row_to_json of every part row the apply deletes or rewrites. */
  partRows: Record<string, any>[]
  /** row_to_json of every recall chunk of every affected message. */
  chunkRows: Record<string, any>[]
}

function writePrivateJson(file: string, data: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 })
}

function readBackup(file: string, identity: DbIdentity): BackupFile {
  if (!existsSync(file)) {
    throw new Error(
      `backup file not found: ${file} — run once with --backup (no --apply) first`
    )
  }
  const backup = JSON.parse(readFileSync(file, 'utf8')) as BackupFile
  if (backup.kind !== 'narration-backfill-backup' || backup.version !== 1) {
    throw new Error(`${file} is not a narration backfill backup`)
  }
  if (
    backup.db.systemIdentifier !== identity.systemIdentifier ||
    backup.db.database !== identity.database
  ) {
    throw new Error(
      `backup ${file} was taken from a different database ` +
        `(${backup.label}: ${backup.db.database}/${backup.db.systemIdentifier}) ` +
        `than this one (${identity.database}/${identity.systemIdentifier})`
    )
  }
  return backup
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

class SkipError extends Error {}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const label = process.env.BACKFILL_ENV || 'unlabelled'

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (process.env.DATABASE_RESTRICTED_URL) {
    throw new Error(
      'DATABASE_RESTRICTED_URL is set: this maintenance script must run as the ' +
        'owner role only (dbAdmin). Unset it (and run bun with --no-env-file).'
    )
  }
  if (process.env.ENABLE_AUTH === 'true') {
    // lib/db refuses to serve (process.exit) as the owner with auth on.
    throw new Error('unset ENABLE_AUTH for this script (it is not serving)')
  }
  if (args.reindex) {
    if (process.env.EMBEDDING_MODEL !== RECALL_MODEL) {
      throw new Error(
        `--reindex needs EMBEDDING_MODEL=${RECALL_MODEL} (the model the stored ` +
          'recall vectors are locked to); refusing to embed with anything else'
      )
    }
    if (
      !process.env.EMBEDDING_SERVICE_URL ||
      !process.env.EMBEDDING_SERVICE_TOKEN
    ) {
      throw new Error(
        '--reindex needs EMBEDDING_SERVICE_URL / EMBEDDING_SERVICE_TOKEN'
      )
    }
  }

  // Imported only now, after the env guards: lib/db connects on import.
  const { dbAdmin } = await import('@/lib/db')

  const [who] = (await dbAdmin.execute(sql`
    SELECT current_database() AS database,
           (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier",
           current_user AS "user",
           (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass,
           (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'parts') AS owner
  `)) as unknown as Array<DbIdentity & { bypass: boolean; owner: string }>
  if (!who?.bypass && who?.owner !== who?.user) {
    throw new Error(`connected as ${who?.user}, which is not the owner role`)
  }
  const identity: DbIdentity = {
    database: who.database,
    systemIdentifier: who.systemIdentifier,
    user: who.user
  }
  console.log(
    `[backfill-narration] env=${label} db=${identity.database} ` +
      `cluster=${identity.systemIdentifier} role=${identity.user}`
  )

  const backup =
    args.backup && (args.apply || args.reindex || args.verify)
      ? readBackup(args.backup, identity)
      : undefined
  if (args.backup && !backup && existsSync(args.backup)) {
    throw new Error(`refusing to overwrite existing backup ${args.backup}`)
  }

  // ---- Plan (one read-only, repeatable-read snapshot) ----------------------
  const scope = backup
    ? { messageIds: backup.messages.map(m => m.messageId) }
    : { since: args.since, chats: args.chats }
  const planned = await dbAdmin.transaction(
    tx => planAll(tx, scope, Boolean(args.backup && !backup)),
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  )

  const reportFile =
    args.report ??
    path.join(
      process.env.BACKFILL_OUT_DIR || process.cwd(),
      `narration-backfill-report-${label}-${stamp()}.json`
    )
  printPlan(planned, label)

  if (args.backup && !backup) {
    const file: BackupFile = {
      kind: 'narration-backfill-backup',
      version: 1,
      label,
      createdAt: new Date().toISOString(),
      db: identity,
      messages: planned.changes.map(c => ({
        messageId: c.plan.messageId,
        chatId: c.plan.chatId,
        userId: c.userId,
        createdAt: c.createdAt,
        plan: {
          drops: c.plan.drops,
          rewrites: c.plan.rewrites,
          renderViewHash: c.plan.renderViewHash
        }
      })),
      partRows: planned.backupPartRows ?? [],
      chunkRows: planned.backupChunkRows ?? []
    }
    writePrivateJson(args.backup, file)
    console.log(
      `[backup] wrote ${args.backup} — ${file.messages.length} messages, ` +
        `${file.partRows.length} part rows, ${file.chunkRows.length} chunk rows`
    )
  }

  const results: Record<string, unknown> = {}
  if (args.apply && backup) {
    results.apply = await applyAll(dbAdmin, planned, backup)
  }
  if (args.reindex && backup) {
    results.reindex = await reindexAll(dbAdmin, backup)
  }
  if (args.verify && backup) {
    results.verify = await verifyAll(dbAdmin, backup, args.spot)
  }

  writePrivateJson(reportFile, {
    kind: 'narration-backfill-report',
    label,
    generatedAt: new Date().toISOString(),
    db: identity,
    mode: {
      apply: args.apply,
      reindex: args.reindex,
      verify: args.verify,
      backup: args.backup ?? null
    },
    filters: { since: args.since?.toISOString() ?? null, chats: args.chats },
    totals: planned.totals,
    skipped: planned.skipped,
    messages: planned.changes.map(c => ({
      messageId: c.plan.messageId,
      chatId: c.plan.chatId,
      userId: c.userId,
      createdAt: c.createdAt,
      removedChars: c.plan.removedChars,
      drops: c.plan.drops,
      rewrites: c.plan.rewrites,
      renderViewHash: c.plan.renderViewHash,
      indexableChanged: c.plan.indexableBefore !== c.plan.indexableAfter,
      recall: c.recall
    })),
    results
  })
  console.log(`[report] ${reportFile}`)

  const failed = Object.values(results).some(
    r => (r as { failed?: number } | undefined)?.failed
  )
  process.exit(failed ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type Tx = any

interface RecallPlan {
  existing: number
  expected: number
  /** see `recallAction` (backfill-narration-plan.ts) */
  action: RecallAction
  /** existing chunks that contain text the cleanup removes */
  chunksWithRemovedText: number
  /** narration sentences only the stored chunks hold (first few, trimmed) */
  narrationInChunks: string[]
  /** where stored and expected chunk text first differ (stale only) */
  firstDiff?: { stored: string; expected: string }
}

function firstDiff(existing: string[], expected: string[]) {
  const a = existing.join(' ¶ ')
  const b = expected.join(' ¶ ')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const from = Math.max(0, i - 40)
  return { stored: a.slice(from, i + 120), expected: b.slice(from, i + 120) }
}

interface PlannedChange {
  plan: MessageCleanupPlan
  userId: string
  createdAt: string
  recall: RecallPlan
}

interface Planned {
  scanned: number
  changes: PlannedChange[]
  skipped: { messageId: string; chatId: string; reason: string }[]
  totals: Record<string, unknown>
  backupPartRows?: Record<string, any>[]
  backupChunkRows?: Record<string, any>[]
}

function recallChunkParams() {
  const t = Number(process.env.RECALL_CHUNK_TOKENS)
  const o = Number(process.env.RECALL_CHUNK_OVERLAP)
  return {
    tokens: Number.isFinite(t) && t > 0 ? t : 512,
    overlap: Number.isFinite(o) && o >= 0 ? o : 128
  }
}

async function loadMessageRows(
  tx: Tx,
  where: ReturnType<typeof and>
): Promise<(MessageRow & { userId: string })[]> {
  return tx
    .select({
      id: messages.id,
      chatId: messages.chatId,
      role: messages.role,
      metadata: messages.metadata,
      createdAt: messages.createdAt,
      userId: chats.userId
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(where)
    .orderBy(asc(messages.createdAt), asc(messages.id))
}

async function loadParts(tx: Tx, messageIds: string[]): Promise<PartRow[]> {
  if (messageIds.length === 0) return []
  return tx
    .select()
    .from(parts)
    .where(inArray(parts.messageId, messageIds))
    .orderBy(asc(parts.messageId), asc(parts.order))
}

async function loadChunkContents(
  tx: Tx,
  messageIds: string[]
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (messageIds.length === 0) return out
  const rows: { messageId: string; content: string }[] = await tx
    .select({
      messageId: conversationChunks.messageId,
      content: conversationChunks.content
    })
    .from(conversationChunks)
    .where(inArray(conversationChunks.messageId, messageIds))
    .orderBy(
      asc(conversationChunks.messageId),
      asc(conversationChunks.chunkIndex)
    )
  for (const r of rows) {
    const list = out.get(r.messageId) ?? []
    list.push(r.content)
    out.set(r.messageId, list)
  }
  return out
}

async function rowsAsJson(
  tx: Tx,
  table: 'parts' | 'conversation_chunks',
  column: 'id' | 'message_id',
  ids: string[]
): Promise<Record<string, any>[]> {
  if (ids.length === 0) return []
  // row_to_json keeps Postgres's own text forms (timestamps without a zone,
  // the vector literal), so a restore via json_populate_recordset(null::<table>)
  // round-trips exactly.
  const res = (await tx.execute(sql`
    SELECT row_to_json(t)::text AS j
    FROM ${sql.identifier(table)} t
    WHERE ${sql.identifier(column)} IN (${sql.join(
      ids.map(id => sql`${id}`),
      sql`, `
    )})
    ORDER BY ${sql.identifier(column)}
  `)) as unknown as { j: string }[]
  return res.map(r => JSON.parse(r.j))
}

async function planAll(
  tx: Tx,
  scope: { messageIds?: string[]; since?: Date; chats?: string[] },
  collectBackup: boolean
): Promise<Planned> {
  const conds = [eq(messages.role, 'assistant')]
  if (scope.messageIds) conds.push(inArray(messages.id, scope.messageIds))
  if (scope.since) conds.push(gte(messages.createdAt, scope.since))
  if (scope.chats?.length) conds.push(inArray(messages.chatId, scope.chats))
  const msgs =
    scope.messageIds && scope.messageIds.length === 0
      ? []
      : await loadMessageRows(tx, and(...conds))

  const { tokens, overlap } = recallChunkParams()
  const changes: PlannedChange[] = []
  const skipped: Planned['skipped'] = []

  for (let b = 0; b < msgs.length; b += MESSAGE_BATCH) {
    const batch = msgs.slice(b, b + MESSAGE_BATCH)
    const allParts = await loadParts(
      tx,
      batch.map(m => m.id)
    )
    const byMessage = new Map<string, PartRow[]>()
    for (const p of allParts) {
      const list = byMessage.get(p.messageId) ?? []
      list.push(p)
      byMessage.set(p.messageId, list)
    }

    const batchChanges: {
      m: (typeof batch)[number]
      plan: MessageCleanupPlan
      rows: PartRow[]
    }[] = []
    for (const m of batch) {
      const rows = byMessage.get(m.id) ?? []
      const outcome = planMessageCleanup(m, rows)
      if (outcome.status === 'skip') {
        skipped.push({
          messageId: m.id,
          chatId: m.chatId,
          reason: outcome.reason
        })
      } else if (outcome.status === 'change') {
        batchChanges.push({ m, plan: outcome.plan, rows })
      }
    }

    const chunkMap = await loadChunkContents(
      tx,
      batchChanges.map(c => c.m.id)
    )
    for (const { m, plan, rows } of batchChanges) {
      const existing = chunkMap.get(m.id) ?? []
      const expected = expectedRecallChunks(
        'assistant',
        applyPlanToRows(rows, plan),
        tokens,
        overlap
      ).chunks
      const chunksWithRemovedText = countChunksWithProbes(
        existing,
        removedTextProbes(plan)
      )
      changes.push({
        plan,
        userId: m.userId,
        createdAt: new Date(m.createdAt as any).toISOString(),
        recall: {
          existing: existing.length,
          expected: expected.length,
          action: recallAction({
            existing,
            expected,
            rewrites: plan.rewrites.length,
            chunksWithRemovedText
          }),
          chunksWithRemovedText,
          narrationInChunks: narrationOnlyInChunks(existing, expected)
            .slice(0, 3)
            .map(t => t.slice(0, 160)),
          ...(existing.length > 0 && !isDeepStrictEqual(existing, expected)
            ? { firstDiff: firstDiff(existing, expected) }
            : {})
        }
      })
    }
  }

  const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 3600 * 1000)
  const recent = changes.filter(c => new Date(c.createdAt) >= sixtyDaysAgo)
  const sum = (list: PlannedChange[], f: (c: PlannedChange) => number) =>
    list.reduce((n, c) => n + f(c), 0)
  const byAction = (action: RecallAction) =>
    changes.filter(c => c.recall.action === action)
  const totals = {
    assistantMessagesScanned: msgs.length,
    messagesChanged: changes.length,
    partDeletes: sum(changes, c => c.plan.drops.length),
    partRewrites: sum(changes, c => c.plan.rewrites.length),
    messagesWithRewrites: changes.filter(c => c.plan.rewrites.length > 0)
      .length,
    removedChars: sum(changes, c => c.plan.removedChars),
    savedBeforeEnglishRules: changes.filter(
      c => new Date(c.createdAt) < ENGLISH_RULES_DATE
    ).length,
    last60Days: {
      messagesChanged: recent.length,
      partDeletes: sum(recent, c => c.plan.drops.length),
      partRewrites: sum(recent, c => c.plan.rewrites.length)
    },
    skipped: skipped.length,
    recall: {
      reindexMessages: byAction('reindex').length,
      reindexChunksBefore: sum(byAction('reindex'), c => c.recall.existing),
      reindexChunksAfter: sum(byAction('reindex'), c => c.recall.expected),
      fresh: byAction('fresh').length,
      notIndexed: byAction('not-indexed').length,
      staleUnrelatedLeftAlone: byAction('stale-unrelated').length,
      chunksWithRemovedText: sum(changes, c => c.recall.chunksWithRemovedText),
      chunkParams: { tokens, overlap }
    }
  }

  const planned: Planned = { scanned: msgs.length, changes, skipped, totals }
  if (collectBackup) {
    planned.backupPartRows = await rowsAsJson(
      tx,
      'parts',
      'id',
      changes.flatMap(c => [
        ...c.plan.drops.map(d => d.partId),
        ...c.plan.rewrites.map(r => r.partId)
      ])
    )
    planned.backupChunkRows = await rowsAsJson(
      tx,
      'conversation_chunks',
      'message_id',
      changes.map(c => c.plan.messageId)
    )
  }
  return planned
}

function printPlan(planned: Planned, label: string) {
  for (const c of planned.changes) {
    const p = c.plan
    console.log(
      `  ${p.messageId} chat=${p.chatId} ${c.createdAt.slice(0, 10)} ` +
        `drop=${p.drops.length} rewrite=${p.rewrites.length} ` +
        `-${p.removedChars}ch recall=${c.recall.existing}` +
        `${c.recall.action === 'reindex' ? `→${c.recall.expected} REINDEX` : ''}` +
        `${c.recall.action === 'stale-unrelated' ? ' (stale, not narration: left alone)' : ''}` +
        `${c.recall.chunksWithRemovedText ? ` (${c.recall.chunksWithRemovedText} w/ removed text)` : ''}`
    )
  }
  for (const s of planned.skipped) {
    console.log(`  SKIP ${s.messageId} chat=${s.chatId}: ${s.reason}`)
  }
  console.log(`[plan] env=${label} ${JSON.stringify(planned.totals)}`)
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function applyAll(dbAdmin: any, planned: Planned, backup: BackupFile) {
  const backupRows = new Map(backup.partRows.map(r => [r.id as string, r]))
  let applied = 0
  let deleted = 0
  let rewritten = 0
  const skippedIds: { messageId: string; reason: string }[] = []

  for (const change of planned.changes) {
    const id = change.plan.messageId
    try {
      const r = await dbAdmin.transaction(async (tx: Tx) => {
        const locked: MessageRow[] = await tx
          .select({
            id: messages.id,
            chatId: messages.chatId,
            role: messages.role,
            metadata: messages.metadata,
            createdAt: messages.createdAt
          })
          .from(messages)
          .where(eq(messages.id, id))
          .for('update')
        if (locked.length === 0) throw new SkipError('message no longer exists')
        const msg = locked[0]

        const before: PartRow[] = await tx
          .select()
          .from(parts)
          .where(eq(parts.messageId, id))
          .orderBy(asc(parts.order))
        const fresh = planMessageCleanup(msg, before)
        if (fresh.status !== 'change') {
          throw new SkipError(
            `re-plan under lock: ${fresh.status}` +
              ('reason' in fresh ? ` (${fresh.reason})` : '')
          )
        }
        const plan = fresh.plan
        if (
          !isDeepStrictEqual(plan.drops, change.plan.drops) ||
          !isDeepStrictEqual(plan.rewrites, change.plan.rewrites)
        ) {
          throw new SkipError('message changed between planning and apply')
        }
        // Every row we change must have its current pre-image in the backup.
        const current = new Map(before.map(p => [p.id, p]))
        for (const partId of [
          ...plan.drops.map(d => d.partId),
          ...plan.rewrites.map(w => w.partId)
        ]) {
          const b = backupRows.get(partId)
          const now = current.get(partId)
          if (
            !b ||
            !now ||
            b.message_id !== id ||
            b.type !== 'text' ||
            b.text_text !== now.text_text
          ) {
            throw new SkipError(`part ${partId} is not covered by the backup`)
          }
        }

        const dropIds = plan.drops.map(d => d.partId)
        if (dropIds.length > 0) {
          const gone = await tx
            .delete(parts)
            .where(
              and(
                eq(parts.messageId, id),
                eq(parts.type, 'text'),
                inArray(parts.id, dropIds)
              )
            )
            .returning({ id: parts.id })
          if (gone.length !== dropIds.length) {
            throw new Error(`deleted ${gone.length} of ${dropIds.length} parts`)
          }
        }
        for (const w of plan.rewrites) {
          const updated = await tx
            .update(parts)
            .set({ text_text: w.after })
            .where(
              and(
                eq(parts.id, w.partId),
                eq(parts.messageId, id),
                eq(parts.type, 'text'),
                eq(parts.text_text, w.before)
              )
            )
            .returning({ id: parts.id })
          if (updated.length !== 1) {
            throw new Error(
              `rewrite of part ${w.partId} matched ${updated.length} rows`
            )
          }
        }

        // Verify inside the transaction: clean, exact, nothing else touched.
        const after: PartRow[] = await tx
          .select()
          .from(parts)
          .where(eq(parts.messageId, id))
          .orderBy(asc(parts.order))
        if (planMessageCleanup(msg, after).status !== 'unchanged') {
          throw new Error(
            'post-state is not clean (a second run would change it)'
          )
        }
        const view = buildUIMessageFromDB(msg, after)
        if (hashParts(view.parts) !== plan.renderViewHash) {
          throw new Error('post-state does not equal the pre-apply render view')
        }
        if (stripNarrationFromMessage(view) !== view) {
          throw new Error('render path would still change the stored message')
        }
        const nonText = (rows: PartRow[]) =>
          rows.filter(p => p.type !== 'text').map(p => p.id)
        if (!isDeepStrictEqual(nonText(before), nonText(after))) {
          throw new Error('non-text parts changed')
        }
        return { deleted: dropIds.length, rewritten: plan.rewrites.length }
      })
      applied++
      deleted += r.deleted
      rewritten += r.rewritten
      console.log(
        `  [apply] ${id} -${r.deleted} parts, ${r.rewritten} rewritten`
      )
    } catch (error) {
      if (error instanceof SkipError) {
        skippedIds.push({ messageId: id, reason: error.message })
        console.log(`  [apply] SKIP ${id}: ${error.message}`)
        continue
      }
      // An unexpected failure means an assumption broke. This message rolled
      // back; stop here (the run is idempotent — fix and re-run).
      console.error(`  [apply] FAILED ${id}:`, error)
      return {
        applied,
        deleted,
        rewritten,
        skipped: skippedIds,
        failed: 1,
        abortedAt: id
      }
    }
  }
  const summary = {
    applied,
    deleted,
    rewritten,
    skipped: skippedIds,
    failed: 0
  }
  console.log(
    `[apply] ${JSON.stringify({ ...summary, skipped: skippedIds.length })}`
  )
  return summary
}

// ---------------------------------------------------------------------------
// Recall re-index
// ---------------------------------------------------------------------------

function parseVector(text: string): number[] {
  return text
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(Number)
}

async function reindexAll(dbAdmin: any, backup: BackupFile) {
  // The app's own indexing path (imported late: it pulls lib/db too).
  const { indexMessage } = await import('@/lib/memory/recall-index')
  const { deleteChunksForMessage, isRecallEnabled } = await import(
    '@/lib/db/recall-actions'
  )
  const { embedTexts, getConfiguredModel } = await import(
    '@/lib/embeddings/transformers-embedding'
  )
  const { tokens, overlap } = recallChunkParams()
  const model = getConfiguredModel()
  if (model !== RECALL_MODEL) throw new Error(`configured model is ${model}`)

  // Embedding-space preflight: re-embed one stored chunk and require it to
  // land on its stored vector. Proves the service serves the same model the
  // stored vectors were made with before anything is written.
  const [probe] = (await dbAdmin.execute(sql`
    SELECT content, embedding::text AS embedding
    FROM conversation_chunks ORDER BY created_at DESC LIMIT 1
  `)) as unknown as { content: string; embedding: string }[]
  if (probe) {
    const [fresh] = await embedTexts([probe.content], model)
    const stored = parseVector(probe.embedding)
    const cos = fresh.reduce(
      (s: number, v: number, i: number) => s + v * stored[i],
      0
    )
    console.log(
      `[reindex] embedding-space check: cos=${cos.toFixed(4)} dims=${fresh.length}`
    )
    if (fresh.length !== RECALL_DIMS || cos < 0.98) {
      throw new Error(
        'embedder does not reproduce the stored vectors; refusing'
      )
    }
  }

  const summary = {
    considered: backup.messages.length,
    reindexed: 0,
    deletedOnly: 0,
    fresh: 0,
    notIndexed: 0,
    staleUnrelatedLeftAlone: 0,
    gone: 0,
    failed: 0,
    chunksBefore: 0,
    chunksAfter: 0,
    chunksWithRemovedTextBefore: 0,
    chunksWithRemovedTextAfter: 0,
    badDims: 0,
    messages: [] as Record<string, unknown>[]
  }

  for (const m of backup.messages) {
    const probes = removedTextProbes(m.plan)
    const [msg] = await loadMessageRows(
      dbAdmin,
      and(eq(messages.id, m.messageId))
    )
    if (!msg) {
      summary.gone++
      continue
    }
    const role = msg.role as 'user' | 'assistant'
    const rows = await loadParts(dbAdmin, [msg.id])
    const { text, chunks: expected } = expectedRecallChunks(
      role,
      rows,
      tokens,
      overlap
    )
    const existing =
      (await loadChunkContents(dbAdmin, [msg.id])).get(msg.id) ?? []
    const withRemovedBefore = countChunksWithProbes(existing, probes)
    summary.chunksWithRemovedTextBefore += withRemovedBefore

    const verdict = recallAction({
      existing,
      expected,
      rewrites: m.plan.rewrites.length,
      chunksWithRemovedText: withRemovedBefore
    })
    if (verdict === 'not-indexed') {
      // Never indexed: left to the app's recall backfill, like any other.
      summary.notIndexed++
      continue
    }
    if (verdict === 'fresh') {
      summary.fresh++
      continue
    }
    if (verdict === 'stale-unrelated') {
      // Chunks from older extraction rules, with no narration in them.
      summary.staleUnrelatedLeftAlone++
      continue
    }

    let action: string
    if (expected.length === 0) {
      await deleteChunksForMessage(msg.userId, msg.id)
      action = 'deleted (no indexable text)'
      summary.deletedOnly++
    } else {
      const written = await indexMessage(
        msg.userId,
        msg.chatId,
        msg.id,
        role,
        text
      )
      if (written > 0) {
        action = 'reindexed'
        summary.reindexed++
      } else if (!(await isRecallEnabled(msg.userId))) {
        // Recall is off for this user: drop the stale derived copies; the
        // app's backfill re-indexes the message if recall is turned back on.
        await deleteChunksForMessage(msg.userId, msg.id)
        action = 'deleted (recall disabled for user)'
        summary.deletedOnly++
      } else {
        summary.failed++
        console.error(
          `  [reindex] FAILED ${msg.id}: indexMessage wrote nothing (old chunks kept)`
        )
        summary.messages.push({ messageId: msg.id, action: 'failed' })
        continue
      }
    }

    const now = (await dbAdmin.execute(sql`
      SELECT content, vector_dims(embedding) AS dims
      FROM conversation_chunks WHERE message_id = ${msg.id}
      ORDER BY chunk_index
    `)) as unknown as { content: string; dims: number }[]
    const contents = now.map(r => r.content)
    const exact =
      action === 'reindexed'
        ? isDeepStrictEqual(contents, expected)
        : contents.length === 0
    const badDims = now.filter(r => Number(r.dims) !== RECALL_DIMS).length
    const withRemovedAfter = countChunksWithProbes(contents, probes)
    summary.chunksBefore += existing.length
    summary.chunksAfter += contents.length
    summary.chunksWithRemovedTextAfter += withRemovedAfter
    summary.badDims += badDims
    if (!exact || badDims > 0 || withRemovedAfter > 0) summary.failed++
    summary.messages.push({
      messageId: msg.id,
      chatId: msg.chatId,
      action,
      chunksBefore: existing.length,
      chunksAfter: contents.length,
      withRemovedTextBefore: withRemovedBefore,
      withRemovedTextAfter: withRemovedAfter,
      exact,
      badDims
    })
    console.log(
      `  [reindex] ${msg.id} ${action}: chunks ${existing.length}→${contents.length}, ` +
        `with removed text ${withRemovedBefore}→${withRemovedAfter}` +
        `${exact && badDims === 0 ? '' : ' MISMATCH'}`
    )
  }
  const { messages: _list, ...counts } = summary
  console.log(`[reindex] ${JSON.stringify(counts)}`)
  return summary
}

// ---------------------------------------------------------------------------
// Verify (read-only)
// ---------------------------------------------------------------------------

async function verifyAll(dbAdmin: any, backup: BackupFile, spot: number) {
  // The app's real loader, as the chat page / resume path call it.
  const { loadChatWithMessages } = await import('@/lib/db/actions')
  const summary = { checked: 0, ok: 0, failed: 0, problems: [] as string[] }
  const byChat = new Map<string, BackupMessage[]>()
  for (const m of backup.messages) {
    const list = byChat.get(m.chatId) ?? []
    list.push(m)
    byChat.set(m.chatId, list)
  }
  let spotted = 0
  for (const [chatId, list] of byChat) {
    const chat = await loadChatWithMessages(chatId, list[0].userId)
    const shown = spotted < spot
    if (shown) {
      spotted++
      console.log(
        `\n=== spot-check chat ${chatId} (${chat?.messages.length ?? 0} messages)`
      )
    }
    for (const m of list) {
      summary.checked++
      const problems: string[] = []
      const msg = chat?.messages.find(x => x.id === m.messageId)
      if (!msg) problems.push('message not returned by the loader')
      else {
        if (hashParts(msg.parts) !== m.plan.renderViewHash) {
          problems.push('loader result differs from the pre-apply render view')
        }
        if (stripNarrationFromMessage(msg) !== msg) {
          problems.push('render path would still clean the stored message')
        }
      }
      const ids = [
        ...m.plan.drops.map(d => d.partId),
        ...m.plan.rewrites.map(r => r.partId)
      ]
      const rows: PartRow[] = ids.length
        ? await dbAdmin.select().from(parts).where(inArray(parts.id, ids))
        : []
      const byId = new Map(rows.map(r => [r.id, r]))
      for (const d of m.plan.drops) {
        if (byId.has(d.partId))
          problems.push(`dropped part ${d.partId} still exists`)
      }
      for (const r of m.plan.rewrites) {
        if (byId.get(r.partId)?.text_text !== r.after) {
          problems.push(`part ${r.partId} does not hold the cleaned text`)
        }
      }
      if (problems.length) {
        summary.failed++
        summary.problems.push(`${m.messageId}: ${problems.join('; ')}`)
      } else summary.ok++
      if (shown && msg) {
        console.log(`--- ${msg.id} [${problems.length ? 'FAIL' : 'ok'}]`)
        for (const p of msg.parts as any[]) {
          const t =
            p.type === 'text'
              ? ` ${JSON.stringify(String(p.text).slice(0, 160))}${String(p.text).length > 160 ? '…' : ''}`
              : ''
          console.log(`    ${p.type}${t}`)
        }
      }
    }
  }
  for (const p of summary.problems) console.log(`  [verify] FAIL ${p}`)
  console.log(
    `[verify] ${JSON.stringify({ checked: summary.checked, ok: summary.ok, failed: summary.failed })}`
  )
  return summary
}

main().catch(error => {
  console.error(
    '[backfill-narration] failed:',
    error instanceof Error ? error.message : error
  )
  process.exit(1)
})
