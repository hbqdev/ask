import { describe, expect, test } from 'vitest'

import type { RecentChat } from '../recent-chats-section'
import {
  applyOptimisticRecent,
  NEW_CHAT_PLACEHOLDER_TITLE,
  pruneReconciledOverrides,
  type RecentOverrides
} from '../recent-optimistic'

const at = (iso: string) => new Date(iso)

// A stable server list, ordered as getRecentChats returns it:
// lastViewedAt DESC NULLS LAST, createdAt DESC.
const SERVER: RecentChat[] = [
  {
    id: 'a',
    title: 'A',
    lastViewedAt: at('2026-01-03T00:00:00Z'),
    createdAt: at('2026-01-01T00:00:00Z')
  },
  {
    id: 'b',
    title: 'B',
    lastViewedAt: at('2026-01-02T00:00:00Z'),
    createdAt: at('2026-01-01T00:00:00Z')
  },
  {
    id: 'c',
    title: 'C',
    lastViewedAt: at('2026-01-01T12:00:00Z'),
    createdAt: at('2026-01-01T00:00:00Z')
  }
]

const ids = (chats: RecentChat[]) => chats.map(c => c.id)

describe('applyOptimisticRecent', () => {
  test('with no overrides, returns the server order untouched', () => {
    const result = applyOptimisticRecent(SERVER, {})
    expect(ids(result)).toEqual(['a', 'b', 'c'])
  })

  test('orders lastViewedAt DESC then NULLS LAST by createdAt DESC', () => {
    const withNulls: RecentChat[] = [
      { id: 'x', title: 'X', lastViewedAt: null, createdAt: at('2026-05-01') },
      {
        id: 'y',
        title: 'Y',
        lastViewedAt: at('2026-01-01'),
        createdAt: at('2026-01-01')
      },
      { id: 'z', title: 'Z', lastViewedAt: null, createdAt: at('2026-06-01') }
    ]
    // y (has lastViewedAt) first; then nulls by createdAt DESC: z before x.
    expect(ids(applyOptimisticRecent(withNulls, {}))).toEqual(['y', 'z', 'x'])
  })

  test('a chat-bump override moves that chat to the top', () => {
    const overrides: RecentOverrides = {
      c: { lastViewedAt: at('2026-02-01T00:00:00Z').getTime() }
    }
    expect(ids(applyOptimisticRecent(SERVER, overrides))).toEqual([
      'c',
      'a',
      'b'
    ])
  })

  test('max-merge: a FRESH optimistic bump survives a STALE server list', () => {
    // Server still shows the pre-bump order (c is last). The optimistic bump for
    // c is newer than every server lastViewedAt, so c must stay pinned to top —
    // a naive setState(prop) would have reintroduced the stale order here.
    const overrides: RecentOverrides = {
      c: { lastViewedAt: at('2026-09-09T00:00:00Z').getTime() }
    }
    const result = applyOptimisticRecent(SERVER, overrides)
    expect(ids(result)).toEqual(['c', 'a', 'b'])
    // And the merged row carries the optimistic (max) time, not the stale one.
    const c = result.find(r => r.id === 'c')!
    expect(c.lastViewedAt!.getTime()).toBe(at('2026-09-09T00:00:00Z').getTime())
  })

  test('max-merge: a genuinely newer server value wins over an older bump', () => {
    // Server has already advanced c past the optimistic stamp — server wins.
    const server: RecentChat[] = [
      {
        id: 'c',
        title: 'C',
        lastViewedAt: at('2026-10-01T00:00:00Z'),
        createdAt: at('2026-01-01T00:00:00Z')
      }
    ]
    const overrides: RecentOverrides = {
      c: { lastViewedAt: at('2026-02-01T00:00:00Z').getTime() }
    }
    const result = applyOptimisticRecent(server, overrides)
    expect(result[0].lastViewedAt!.getTime()).toBe(
      at('2026-10-01T00:00:00Z').getTime()
    )
  })

  test('inserts a brand-new chat at the top with a placeholder title', () => {
    const overrides: RecentOverrides = {
      new1: { lastViewedAt: at('2026-09-09T00:00:00Z').getTime() }
    }
    const result = applyOptimisticRecent(SERVER, overrides)
    expect(ids(result)).toEqual(['new1', 'a', 'b', 'c'])
    expect(result[0].title).toBe(NEW_CHAT_PLACEHOLDER_TITLE)
  })

  test('title reconcile: once the server returns the new chat, its real title wins', () => {
    // The server now includes new1 with its generated title. The stale insert
    // override for new1 must NOT clobber it with the placeholder.
    const server: RecentChat[] = [
      {
        id: 'new1',
        title: 'Generated title',
        lastViewedAt: at('2026-09-09T00:00:00Z'),
        createdAt: at('2026-09-09T00:00:00Z')
      },
      ...SERVER
    ]
    const overrides: RecentOverrides = {
      new1: { lastViewedAt: at('2026-09-09T00:00:00Z').getTime() }
    }
    const result = applyOptimisticRecent(server, overrides)
    expect(result[0].id).toBe('new1')
    expect(result[0].title).toBe('Generated title')
  })

  test('a deleted override drops the chat from the list immediately', () => {
    const overrides: RecentOverrides = { b: { deleted: true } }
    expect(ids(applyOptimisticRecent(SERVER, overrides))).toEqual(['a', 'c'])
  })

  test('a tombstone for a chat the server no longer returns is a no-op', () => {
    const overrides: RecentOverrides = { ghost: { deleted: true } }
    expect(ids(applyOptimisticRecent(SERVER, overrides))).toEqual([
      'a',
      'b',
      'c'
    ])
  })
})

describe('pruneReconciledOverrides', () => {
  test('drops a bump the server has caught up on', () => {
    const overrides: RecentOverrides = {
      // server c is at 2026-01-01T12:00; this stale bump is older → reconciled.
      c: { lastViewedAt: at('2026-01-01T00:00:00Z').getTime() }
    }
    expect(pruneReconciledOverrides(SERVER, overrides)).toEqual({})
  })

  test('keeps a bump still fresher than the server', () => {
    const overrides: RecentOverrides = {
      c: { lastViewedAt: at('2026-09-09T00:00:00Z').getTime() }
    }
    expect(pruneReconciledOverrides(SERVER, overrides)).toBe(overrides)
  })

  test('keeps an insert the server has not returned yet', () => {
    const overrides: RecentOverrides = {
      new1: { lastViewedAt: at('2026-09-09T00:00:00Z').getTime() }
    }
    expect(pruneReconciledOverrides(SERVER, overrides)).toBe(overrides)
  })

  test('drops a tombstone once the server also stops returning the chat', () => {
    const overrides: RecentOverrides = { ghost: { deleted: true } }
    expect(pruneReconciledOverrides(SERVER, overrides)).toEqual({})
  })

  test('keeps a tombstone while the server still returns the chat', () => {
    const overrides: RecentOverrides = { b: { deleted: true } }
    expect(pruneReconciledOverrides(SERVER, overrides)).toBe(overrides)
  })

  test('preserves referential identity when nothing changed', () => {
    const overrides: RecentOverrides = {
      c: { lastViewedAt: at('2026-09-09T00:00:00Z').getTime() }
    }
    // Same reference back = the effect won't churn state on every refresh.
    expect(pruneReconciledOverrides(SERVER, overrides)).toBe(overrides)
  })
})
