/**
 * Pure planning logic for the narration storage backfill
 * (`scripts/backfill-narration.ts`). No database access here, so the diff
 * rules can be unit-tested against DB-row fixtures.
 *
 * The plan for one stored message reuses the app's own code end to end:
 *   rows --buildUIMessageFromDB--> UIMessage   (the loader's mapper)
 *        --stripNarrationFromMessage--> view   (what narrationCleanView renders)
 * and turns the difference back into row operations: text part rows to
 * DELETE (inter-step narration dropped wholesale) and text part rows whose
 * `text_text` is REWRITTEN (a fused preamble cut). Nothing else may change:
 * only assistant messages, only `type='text'` rows, no reordering. The
 * loader sorts parts by `order` (`lib/db/actions.ts` loadChat /
 * loadChatWithMessages, `orderBy: asc(parts.order)`), so the gaps a delete
 * leaves in `order` are harmless and rows are never renumbered.
 *
 * Every plan is self-checked before it is returned: applying the row
 * operations and mapping the rows back must reproduce the render view
 * exactly, and that view must already be clean (running the cleanup on it
 * again changes nothing), so a second backfill run finds nothing to do.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { splitText } from '@/lib/embeddings/split-text'
import {
  extractIndexableText,
  type IndexablePart
} from '@/lib/memory/extract-indexable-text'
import { stripNarrationFromMessage } from '@/lib/streaming/helpers/strip-narration-from-message'
import { looksLikeNarrationStart } from '@/lib/streaming/helpers/strip-narration-preamble'
import type { UIMessage } from '@/lib/types/ai'
import type { DBMessagePartSelect } from '@/lib/types/message-persistence'
import { buildUIMessageFromDB } from '@/lib/utils/message-mapping'

/** A full `parts` row as Drizzle selects it (camelCase keys). */
export type PartRow = DBMessagePartSelect

/** The `messages` columns the loader's mapper reads. */
export interface MessageRow {
  id: string
  chatId: string
  role: string
  metadata?: Record<string, any> | null
  createdAt?: Date | string
}

export interface TextPartDrop {
  partId: string
  order: number
  text: string
}

export interface TextPartRewrite {
  partId: string
  order: number
  before: string
  after: string
}

export interface MessageCleanupPlan {
  messageId: string
  chatId: string
  /** Text part rows to delete (inter-step narration dropped wholesale). */
  drops: TextPartDrop[]
  /** Text part rows whose `text_text` changes (fused preamble cut). */
  rewrites: TextPartRewrite[]
  /** Characters removed across all drops and rewrites. */
  removedChars: number
  /**
   * The narration-free view of the message: exactly what the render path
   * (`narrationCleanView`) shows for the stored rows today, and exactly what
   * the loader must return once the plan is applied.
   */
  cleanedParts: UIMessage['parts']
  /** sha256 of the JSON of `cleanedParts` — compared after the apply. */
  renderViewHash: string
  /** Recall text (`extractIndexableText`, DB-row part types) before / after. */
  indexableBefore: string
  indexableAfter: string
}

export type PlanOutcome =
  | { status: 'unchanged' }
  | { status: 'change'; plan: MessageCleanupPlan }
  | { status: 'skip'; reason: string }

// Hidden provenance tag. Object spread copies own enumerable symbol keys, so a
// part the cleanup rewrites (`{ ...part, text }`) keeps the index of the row it
// came from, which is what maps the cleaned view back to row ids without
// guessing from text.
const ROW = Symbol('backfill-narration-row')

/** Sort rows the way the app's loader does (`order` ascending). */
export function sortRowsLikeLoader(rows: readonly PartRow[]): PartRow[] {
  return [...rows].sort((a, b) => a.order - b.order)
}

/** sha256 of a parts array's JSON — the render-view fingerprint. */
export function hashParts(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** Parts in the shape the recall backfill feeds `extractIndexableText`. */
export function indexablePartsOf(rows: readonly PartRow[]): IndexablePart[] {
  return rows.map(r => ({ type: r.type, text: r.text_text }))
}

/**
 * The rows as they will be after the plan is applied: dropped rows removed,
 * rewritten rows carrying their new text, everything else untouched and in
 * the same order.
 */
export function applyPlanToRows(
  rows: readonly PartRow[],
  plan: Pick<MessageCleanupPlan, 'drops' | 'rewrites'>
): PartRow[] {
  const dropped = new Set(plan.drops.map(d => d.partId))
  const rewritten = new Map(plan.rewrites.map(r => [r.partId, r.after]))
  return sortRowsLikeLoader(rows)
    .filter(r => !dropped.has(r.id))
    .map(r =>
      rewritten.has(r.id) ? { ...r, text_text: rewritten.get(r.id)! } : r
    )
}

function shallowEqualExcept(a: object, b: object, key: string): boolean {
  const ka = Object.keys(a).filter(k => k !== key)
  const kb = Object.keys(b).filter(k => k !== key)
  if (ka.length !== kb.length) return false
  return ka.every(k => (a as any)[k] === (b as any)[k])
}

/**
 * Plan the narration cleanup of one stored message. Returns `unchanged` for
 * a clean message and for every non-assistant message (never touched), `skip`
 * (with a reason) whenever the cleanup cannot be expressed safely as text-row
 * deletes/rewrites, and `change` with a self-checked plan otherwise.
 */
export function planMessageCleanup(
  message: MessageRow,
  rows: readonly PartRow[]
): PlanOutcome {
  if (message.role !== 'assistant') return { status: 'unchanged' }

  const sorted = sortRowsLikeLoader(rows)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].order === sorted[i - 1].order) {
      // The loader's ORDER BY would be ambiguous — can't know what renders.
      return {
        status: 'skip',
        reason: `duplicate part order ${sorted[i].order}`
      }
    }
  }

  let ui: UIMessage
  try {
    ui = buildUIMessageFromDB(message, sorted)
  } catch (error) {
    return {
      status: 'skip',
      reason: `unmappable: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const view = stripNarrationFromMessage(ui)
  if (view === ui) return { status: 'unchanged' }

  // Same cleanup over tagged copies, to learn which row each output part is.
  const taggedParts = ui.parts.map((p, i) => ({ ...p, [ROW]: i }))
  const tagged = stripNarrationFromMessage({
    ...ui,
    parts: taggedParts
  } as UIMessage)
  const out = tagged.parts as any[]
  if (out.length !== view.parts.length) {
    return { status: 'skip', reason: 'tagged cleanup diverged (length)' }
  }

  const drops: TextPartDrop[] = []
  const rewrites: TextPartRewrite[] = []
  const kept = new Set<number>()
  let previous = -1
  for (let k = 0; k < out.length; k++) {
    const part = out[k]
    const plain = view.parts[k] as any
    const i = part?.[ROW]
    if (typeof i !== 'number' || i <= previous) {
      return { status: 'skip', reason: 'cleanup reordered or invented a part' }
    }
    previous = i
    kept.add(i)
    if (part.type !== plain.type || part.text !== plain.text) {
      return { status: 'skip', reason: 'tagged cleanup diverged (content)' }
    }
    if (part === taggedParts[i]) continue // untouched

    // Rewritten: must be a text row, and only its text may differ.
    const row = sorted[i]
    if (
      row.type !== 'text' ||
      part.type !== 'text' ||
      typeof part.text !== 'string' ||
      !shallowEqualExcept(part, taggedParts[i], 'text')
    ) {
      return { status: 'skip', reason: `non-text change at order ${row.order}` }
    }
    if (part.text === row.text_text) continue
    rewrites.push({
      partId: row.id,
      order: row.order,
      before: row.text_text ?? '',
      after: part.text
    })
  }
  for (let i = 0; i < sorted.length; i++) {
    if (kept.has(i)) continue
    const row = sorted[i]
    if (row.type !== 'text') {
      return {
        status: 'skip',
        reason: `non-text part dropped at order ${row.order}`
      }
    }
    drops.push({ partId: row.id, order: row.order, text: row.text_text ?? '' })
  }
  if (drops.length === 0 && rewrites.length === 0) {
    return { status: 'skip', reason: 'cleanup changed the message but no row' }
  }

  // Idempotency: the stored result must already be clean, so the render path
  // shows it unchanged and a second backfill run finds nothing to do.
  if (stripNarrationFromMessage(view) !== view) {
    return {
      status: 'skip',
      reason: 'cleanup is not a fixpoint for this message'
    }
  }

  // Exactness: the rows after the apply must map back to the same view.
  const postRows = applyPlanToRows(sorted, { drops, rewrites })
  let post: UIMessage
  try {
    post = buildUIMessageFromDB(message, postRows)
  } catch (error) {
    return {
      status: 'skip',
      reason: `post-state unmappable: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!isDeepStrictEqual(post.parts, view.parts)) {
    return { status: 'skip', reason: 'post-state does not reproduce the view' }
  }

  const removedChars =
    drops.reduce((n, d) => n + d.text.length, 0) +
    rewrites.reduce((n, r) => n + (r.before.length - r.after.length), 0)

  return {
    status: 'change',
    plan: {
      messageId: message.id,
      chatId: message.chatId,
      drops,
      rewrites,
      removedChars,
      cleanedParts: view.parts,
      renderViewHash: hashParts(view.parts),
      indexableBefore: extractIndexableText(
        'assistant',
        indexablePartsOf(sorted)
      ),
      indexableAfter: extractIndexableText(
        'assistant',
        indexablePartsOf(postRows)
      )
    }
  }
}

/**
 * The recall chunks the app's own backfill path would write for these rows:
 * `extractIndexableText` over `{type, text_text}` in `order` (the shape
 * `messagesWithoutChunks` returns), then `splitText` with the recall chunk
 * size (`indexMessage`, `lib/memory/recall-index.ts`). Empty text → no chunks.
 */
export function expectedRecallChunks(
  role: 'user' | 'assistant',
  rows: readonly PartRow[],
  chunkTokens: number,
  chunkOverlap: number
): { text: string; chunks: string[] } {
  const text = extractIndexableText(
    role,
    indexablePartsOf(sortRowsLikeLoader(rows))
  )
  if (!text.trim()) return { text, chunks: [] }
  return { text, chunks: splitText(text, chunkTokens, chunkOverlap) }
}

/** Whitespace/citation normalisation matching what recall chunks store. */
export function normalizeForChunkMatch(text: string): string {
  return text
    .replace(/\[\d+\]\(#[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Short probes of the text a plan removes, for checking that recall chunks
 * no longer contain it. For a rewrite the removed text is the prefix in front
 * of the kept answer; for a drop it is the whole part. Up to two 60-char
 * windows per removed span (its start and its middle); spans shorter than 24
 * normalised chars are skipped as too generic to test for.
 */
export function removedTextProbes(
  plan: Pick<MessageCleanupPlan, 'drops' | 'rewrites'>
): string[] {
  const spans: string[] = plan.drops.map(d => d.text)
  for (const r of plan.rewrites) {
    const kept = r.after.trim()
    const at = kept ? r.before.lastIndexOf(kept) : -1
    spans.push(
      at > 0
        ? r.before.slice(0, at)
        : r.before.slice(0, Math.max(0, r.before.length - r.after.length))
    )
  }
  const probes = new Set<string>()
  const WINDOW = 60
  for (const span of spans) {
    const s = normalizeForChunkMatch(span)
    if (s.length < 24) continue
    probes.add(s.slice(0, WINDOW))
    if (s.length > WINDOW * 2) {
      const mid = Math.floor(s.length / 2)
      probes.add(s.slice(mid, mid + WINDOW))
    }
  }
  return [...probes]
}

/** How many of `contents` contain at least one probe. */
export function countChunksWithProbes(
  contents: readonly string[],
  probes: readonly string[]
): number {
  if (probes.length === 0) return 0
  return contents.filter(c => {
    const n = normalizeForChunkMatch(c)
    return probes.some(p => n.includes(p))
  }).length
}

export type RecallAction =
  | 'reindex'
  | 'fresh'
  | 'not-indexed'
  | 'stale-unrelated'

const THINK_TAG = /<\/?(?:think|mm:think)>/i

/**
 * Sentences of the stored recall chunks that the current indexing of the
 * message would NOT contain and that the app's own narration rules classify
 * as narration (`looksLikeNarrationStart`, or a stray think tag). Catches
 * chunks indexed from a message before it was cleaned — e.g. "I now have
 * comprehensive information… Here's my answer." in front of an answer that
 * is stored clean — while text dropped for unrelated reasons (an id the
 * extractor strips, a changed chunk boundary) is not counted.
 */
export function narrationOnlyInChunks(
  existing: readonly string[],
  expected: readonly string[]
): string[] {
  const current = normalizeForChunkMatch(expected.join(' '))
  const seen = new Set<string>()
  const out: string[] = []
  for (const sentence of existing.join('\n').split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim()
    const n = normalizeForChunkMatch(s)
    if (n.length < 12 || seen.has(n) || current.includes(n)) continue
    seen.add(n)
    if (looksLikeNarrationStart(s) || THINK_TAG.test(s)) out.push(s)
  }
  return out
}

/**
 * What the re-index step does with one cleaned message's recall chunks.
 *
 * - `not-indexed`: no chunks — left to the app's own recall backfill.
 * - `fresh`: the stored chunks already equal what the indexing path produces
 *   for the cleaned message (the usual case for a drop-only message: a status
 *   note before the last tool call was never indexed).
 * - `reindex`: they differ AND the difference is narration — an answer was
 *   rewritten, a stored chunk holds text this cleanup removes, or a stored
 *   chunk holds narration the current index would not (`narrationOnlyInChunks`).
 * - `stale-unrelated`: they differ only for other reasons (chunks written
 *   under older extraction rules). Out of this backfill's scope; left alone.
 */
export function recallAction(input: {
  existing: readonly string[]
  expected: readonly string[]
  rewrites: number
  chunksWithRemovedText: number
}): RecallAction {
  if (input.existing.length === 0) return 'not-indexed'
  if (isDeepStrictEqual([...input.existing], [...input.expected]))
    return 'fresh'
  if (
    input.rewrites > 0 ||
    input.chunksWithRemovedText > 0 ||
    narrationOnlyInChunks(input.existing, input.expected).length > 0
  ) {
    return 'reindex'
  }
  return 'stale-unrelated'
}
