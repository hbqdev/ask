import type { RecentChat } from './recent-chats-section'

/**
 * A per-chat optimistic override the sidebar layers on top of the
 * server-rendered Recent list. The server prop (`getRecentChats`) is
 * authoritative but LAGS: its revalidation is issued from the stream's
 * `onFinish` (after the response is committed) and reads are
 * stale-while-revalidate, so a `router.refresh()` can hand back the OLD order.
 * These overrides bridge that gap client-side until the server catches up.
 *
 * - `lastViewedAt` (epoch ms): an optimistic "this chat was just active" stamp —
 *   from a `chat-bump` reorder or a new-chat insert. Max-merged against the
 *   server value so a stale server row can't undo a fresher bump.
 * - `title` / `createdAt`: only for a new chat the server hasn't returned yet —
 *   a placeholder that the next refresh reconciles once the real row (and its
 *   generated title) lands.
 * - `deleted`: a tombstone so a just-deleted chat drops from the list instantly.
 */
export type OptimisticOverride = {
  /** Optimistic lastViewedAt in epoch ms (a bump or a new-chat insert time). */
  lastViewedAt?: number
  /** Placeholder title for a new chat not yet present in the server list. */
  title?: string
  /** Optimistic createdAt in epoch ms for an inserted (new) chat. */
  createdAt?: number
  /** Drop this chat from the list immediately (client-side delete). */
  deleted?: boolean
}

export type RecentOverrides = Record<string, OptimisticOverride>

/** Placeholder shown for a brand-new chat until the server returns its title. */
export const NEW_CHAT_PLACEHOLDER_TITLE = 'New chat'

const ms = (d: Date | string | null | undefined): number => {
  if (!d) return 0
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return Number.isNaN(t) ? 0 : t
}

/**
 * Server-parity comparator: `lastViewedAt DESC NULLS LAST, createdAt DESC` —
 * the exact order `getRecentChats` returns, so `applyOptimisticRecent(server,
 * {})` reproduces the server order untouched. The `RecentChatsSection` renders
 * in the order it's handed, so this ordering is load-bearing.
 */
function compareRecent(a: RecentChat, b: RecentChat): number {
  const aLv = a.lastViewedAt ? ms(a.lastViewedAt) : null
  const bLv = b.lastViewedAt ? ms(b.lastViewedAt) : null
  if (aLv !== null && bLv !== null) {
    if (aLv !== bLv) return bLv - aLv
  } else if (aLv !== null) {
    return -1
  } else if (bLv !== null) {
    return 1
  }
  return ms(b.createdAt) - ms(a.createdAt)
}

/**
 * PURE helper (no DOM, no React) that layers optimistic overrides onto the
 * server Recent list and returns a freshly-sorted list:
 *
 *  1. Bumped/updated chats present in the server list get their `lastViewedAt`
 *     MAX-merged with the optimistic stamp — a stale server prop can never undo
 *     a fresh optimistic bump, while genuinely newer server data still wins.
 *  2. Tombstoned (`deleted`) chats are dropped.
 *  3. Overrides whose id the server hasn't returned yet are inserted as new
 *     rows (with a placeholder title) so a brand-new chat shows at the top.
 *  4. The whole list is re-sorted to the server's own ordering.
 *
 * Kept separate from the component so it's unit-testable without a DOM.
 */
export function applyOptimisticRecent(
  server: RecentChat[],
  overrides: RecentOverrides
): RecentChat[] {
  const seen = new Set<string>()
  const merged: RecentChat[] = []

  for (const chat of server) {
    seen.add(chat.id)
    const ov = overrides[chat.id]
    if (ov?.deleted) continue

    const serverMs = ms(chat.lastViewedAt)
    const optimisticMs = ov?.lastViewedAt ?? 0
    // max-merge: only replace when the optimistic stamp is genuinely fresher.
    const lastViewedAt =
      optimisticMs > serverMs ? new Date(optimisticMs) : chat.lastViewedAt

    merged.push({ ...chat, lastViewedAt })
  }

  // New-chat inserts: any override the server list doesn't include yet. It must
  // carry a time (lastViewedAt) so it can be placed; a bare tombstone for an
  // already-gone chat is a no-op.
  for (const [id, ov] of Object.entries(overrides)) {
    if (seen.has(id) || ov.deleted || ov.lastViewedAt == null) continue
    merged.push({
      id,
      title: ov.title ?? NEW_CHAT_PLACEHOLDER_TITLE,
      lastViewedAt: new Date(ov.lastViewedAt),
      createdAt:
        ov.createdAt != null
          ? new Date(ov.createdAt)
          : new Date(ov.lastViewedAt)
    })
  }

  merged.sort(compareRecent)
  return merged
}

/**
 * Drop overrides the server has already caught up on, so the map doesn't grow
 * without bound. An override is reconciled (and dropped) when:
 *  - it's a tombstone AND the server no longer returns the chat, or
 *  - the server returns the chat with a `lastViewedAt` >= the optimistic stamp.
 * Inserts (server doesn't have the id yet) and still-fresher bumps are kept.
 */
export function pruneReconciledOverrides(
  server: RecentChat[],
  overrides: RecentOverrides
): RecentOverrides {
  const serverById = new Map(server.map(c => [c.id, c]))
  const next: RecentOverrides = {}
  let changed = false

  for (const [id, ov] of Object.entries(overrides)) {
    const row = serverById.get(id)

    if (ov.deleted) {
      if (row)
        next[id] = ov // keep the tombstone until the server drops it too
      else changed = true
      continue
    }

    if (!row) {
      next[id] = ov // insert not yet reflected by the server — keep it
      continue
    }

    if ((ov.lastViewedAt ?? 0) > ms(row.lastViewedAt)) {
      next[id] = ov // still fresher than the server — keep it
    } else {
      changed = true // reconciled — drop it
    }
  }

  // Preserve referential identity when nothing changed so the caller's effect
  // doesn't churn state on every server refresh.
  return changed ? next : overrides
}
