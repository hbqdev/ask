// Memory's calls to Ask's memory routes (app/api/memory/**,
// app/api/settings/memory): what Ask remembers about the user, the two
// switches (memory, and recall of past chats), and the recall index, which is
// rebuilt one bounded batch per request.

import type { ApiClient } from '@/core/api/client'
import { ApiError } from '@/core/api/errors'
import { reasonOf } from '@/features/thread/share-api'

/** Something Ask remembers. Dates are ISO strings. */
export type Memory = {
  id: string
  content: string
  /** preference, fact or interest. */
  category: string
  /** A candidate is still being learned; a confirmed one is kept. */
  status: string
  updatedAt: string
  lastUsedAt: string | null
}

/** How much of the user's past chats the recall index holds. */
export type RecallStatus = { chunks: number; chats: number }

export type MemoryOverview = {
  /** Memory is on: Ask remembers things about the user. */
  enabled: boolean
  /** Recall is on: Ask searches the user's past chats. */
  recallEnabled: boolean
  recall: RecallStatus
  memories: Memory[]
}

export type MemorySettings = {
  memoryEnabled?: boolean
  recallEnabled?: boolean
}

/** One rebuild request's work: messages tried, chunks indexed. */
export type RecallBatch = { messages: number; chunks: number; done: boolean }

/** How a whole rebuild ended, with the messages it went through. */
export type RebuildOutcome = {
  /**
   * done: nothing is left to index. stalled: a batch tried messages but
   * indexed nothing (the embedding service is failing), so another would
   * only try them again. stopped: it ran into MAX_REBUILD_ROUNDS.
   */
  kind: 'done' | 'stalled' | 'stopped'
  messages: number
}

/**
 * How long one rebuild batch may take. One batch measured 46 s on the lab
 * (95 messages, 270 chunks), so this leaves room for a slower one.
 */
export const REBUILD_BATCH_TIMEOUT_MS = 120_000

/**
 * A circuit breaker on the rebuild loop (as on the web): 200 rounds of up to
 * 100 messages is far beyond any real history. The no-progress stop is the
 * real breaker; this one only makes an endless loop impossible.
 */
export const MAX_REBUILD_ROUNDS = 200

/**
 * How long a rebuild waits for the index's new size after a batch; past it the
 * old size stays and the rebuild goes on.
 */
export const RECALL_REFRESH_TIMEOUT_MS = 15_000

export const REBUILD_TIMED_OUT = 'Indexing took too long. Try again.'
const REFRESH_TIMED_OUT = 'Refreshing the index size took too long.'
/** A failed rebuild's reason when the app has none of its own to give. */
export const REBUILD_FAILED = 'Try again later.'
export const MEMORY_UNAVAILABLE =
  'Memory isn’t available for this account on this server.'

const CATEGORY_LABELS: Record<string, string> = {
  preference: 'Preference',
  fact: 'Fact',
  interest: 'Interest'
}

const RECALL_PATH = '/api/memory/recall'
const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** The settings, the recall index's size, and every memory. */
export function fetchMemory(
  client: ApiClient,
  signal?: AbortSignal
): Promise<MemoryOverview> {
  return client.json<MemoryOverview>('/api/memory', { signal })
}

/**
 * Turns memory or recall on or off; resolves with both switches as stored
 * (a server-wide kill switch can keep one off).
 */
export async function saveMemorySettings(
  client: ApiClient,
  settings: MemorySettings
): Promise<{ enabled: boolean; recallEnabled: boolean }> {
  const { enabled, recallEnabled } = await client.json<{
    enabled: boolean
    recallEnabled: boolean
  }>('/api/settings/memory', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(settings)
  })
  return { enabled, recallEnabled }
}

/** Forgets one memory; rejects with a 404 ApiError when it is gone. */
export async function deleteMemory(
  client: ApiClient,
  id: string
): Promise<void> {
  await client.json(`/api/memory/${encodeURIComponent(id)}`, {
    method: 'DELETE'
  })
}

/** Forgets every memory. */
export async function clearMemories(client: ApiClient): Promise<void> {
  await client.json('/api/memory', { method: 'DELETE' })
}

/** Deletes the recall index (the chats themselves stay). */
export async function clearRecallIndex(client: ApiClient): Promise<void> {
  await client.json(RECALL_PATH, { method: 'DELETE' })
}

/**
 * Runs `request` with a signal that aborts when the caller's `signal` does
 * (rejecting with the caller's reason) or after `timeoutMs` (rejecting with a
 * retryable status-0 ApiError saying `timedOut`).
 */
async function withDeadline<T>(
  request: (signal: AbortSignal) => Promise<T>,
  {
    signal,
    timeoutMs,
    timedOut
  }: { signal?: AbortSignal; timeoutMs: number; timedOut: string }
): Promise<T> {
  signal?.throwIfAborted()
  // One controller for both ends (AbortSignal.any needs iOS 17.4).
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new ApiError(0, timedOut, { retryable: true })),
    timeoutMs
  )
  const onAbort = () => controller.abort(signal!.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    return await request(controller.signal)
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Indexes one bounded batch of past messages. Rejects with the caller's
 * reason when `signal` aborts, and with a retryable REBUILD_TIMED_OUT
 * ApiError after `timeoutMs`.
 */
export function rebuildRecallBatch(
  client: ApiClient,
  {
    signal,
    timeoutMs = REBUILD_BATCH_TIMEOUT_MS
  }: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RecallBatch> {
  return withDeadline(
    timed =>
      client.json<RecallBatch>(RECALL_PATH, { method: 'POST', signal: timed }),
    { signal, timeoutMs, timedOut: REBUILD_TIMED_OUT }
  )
}

/**
 * The recall index's current size, for a rebuild's progress. Rejects with the
 * caller's reason when `signal` aborts, and with a retryable ApiError after
 * RECALL_REFRESH_TIMEOUT_MS.
 */
export async function refreshRecallStatus(
  client: ApiClient,
  { signal }: { signal?: AbortSignal } = {}
): Promise<RecallStatus> {
  const overview = await withDeadline(timed => fetchMemory(client, timed), {
    signal,
    timeoutMs: RECALL_REFRESH_TIMEOUT_MS,
    timedOut: REFRESH_TIMED_OUT
  })
  return overview.recall
}

/**
 * Rebuilds the recall index: batch after batch until one is done, stopping
 * on a batch that made no progress. `onBatch` hears each batch and the
 * messages so far, and is waited for before the next. Rejects when a batch
 * fails, and with the caller's reason when `signal` aborts.
 */
export async function rebuildRecallIndex(
  client: ApiClient,
  {
    signal,
    onBatch,
    timeoutMs,
    maxRounds = MAX_REBUILD_ROUNDS
  }: {
    signal?: AbortSignal
    onBatch?: (batch: RecallBatch, messages: number) => void | Promise<void>
    timeoutMs?: number
    maxRounds?: number
  } = {}
): Promise<RebuildOutcome> {
  let messages = 0
  for (let round = 0; round < maxRounds; round++) {
    const batch = await rebuildRecallBatch(client, { signal, timeoutMs })
    messages += batch.messages
    await onBatch?.(batch, messages)
    if (batch.done) return { kind: 'done', messages }
    if (batch.messages > 0 && batch.chunks === 0) {
      return { kind: 'stalled', messages }
    }
  }
  return { kind: 'stopped', messages }
}

/** A memory category's label; an unknown one as it is. */
export function categoryLabel(category: string): string {
  return Object.hasOwn(CATEGORY_LABELS, category)
    ? CATEGORY_LABELS[category]
    : category
}

/** What to tell the user about a failed memory call. */
export function memoryErrorText(error: unknown): string {
  if (
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403)
  ) {
    return MEMORY_UNAVAILABLE
  }
  return reasonOf(error)
}

/**
 * Why a rebuild failed, in the app's words: the server's text (e.g. "see
 * server logs") is never shown. A status-0 ApiError is the app's own (no
 * connection, or a batch that took too long).
 */
export function rebuildErrorText(error: unknown): string {
  if (!(error instanceof ApiError)) return REBUILD_FAILED
  if (error.status === 401 || error.status === 403) return MEMORY_UNAVAILABLE
  return error.status === 0 ? error.message : REBUILD_FAILED
}
