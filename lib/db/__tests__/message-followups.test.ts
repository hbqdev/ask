import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// withRLS (real, unmocked) calls db.transaction(cb); the mock hands cb a fake
// tx so each test controls what select/update resolve to.
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn()
  }
}))

import { db } from '@/lib/db'

import { getMessageFollowups, saveMessageFollowups } from '../actions'

const dialect = new PgDialect()

/** Render a Drizzle SQL fragment so the test can see what it actually says. */
function render(fragment: any) {
  return dialect.sqlToQuery(fragment)
}

/** Column names (and their table) inside a Drizzle predicate. */
function columnsIn(predicate: any): string[] {
  const found: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.name === 'string' && node.table) found.push(node.name)
    const chunks = node.queryChunks ?? node.chunks
    if (Array.isArray(chunks)) chunks.forEach(walk)
    if (Array.isArray(node)) node.forEach(walk)
  }
  walk(predicate)
  return found
}

/** Chainable stand-in for Drizzle's fluent builders. */
function makeChain(resolved: () => unknown, onWhere?: (p: any) => void) {
  const chain: any = {}
  chain.from = vi.fn(() => chain)
  chain.innerJoin = vi.fn(() => chain)
  chain.set = vi.fn(() => chain)
  chain.where = vi.fn((p: any) => {
    onWhere?.(p)
    return chain
  })
  chain.limit = vi.fn(() => Promise.resolve(resolved()))
  chain.returning = vi.fn(() => Promise.resolve(resolved()))
  chain.then = (res: any, rej: any) =>
    Promise.resolve(resolved()).then(res, rej)
  return chain
}

let executed: any[]
let tx: any

function installTx(parts: { select?: () => any; update?: () => any }) {
  executed = []
  tx = {
    execute: vi.fn(async (q: any) => {
      executed.push(q)
    }),
    select: vi.fn(parts.select ?? (() => makeChain(() => []))),
    update: vi.fn(parts.update ?? (() => makeChain(() => [])))
  }
  vi.mocked(db).transaction = vi.fn(async (cb: any) => cb(tx)) as any
}

/** The user id set via set_config at the start of each RLS transaction. */
function rlsUserIds(): unknown[] {
  return executed.map(q => render(q).params[0])
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('getMessageFollowups', () => {
  it("returns metadata.followups for the owner's message", async () => {
    const wheres: any[] = []
    installTx({
      select: () =>
        makeChain(
          () => [
            {
              metadata: {
                modelId: 'm',
                followups: ['What next?', 'Why so?', 'How much?']
              }
            }
          ],
          p => wheres.push(p)
        )
    })

    const result = await getMessageFollowups('chat-A', 'msg-1', 'user-1')

    expect(result).toEqual(['What next?', 'Why so?', 'How much?'])
    expect(rlsUserIds()).toEqual(['user-1'])
    const cols = columnsIn(wheres[0])
    expect(cols).toContain('id')
    expect(cols).toContain('chat_id')
    expect(cols).toContain('user_id')
    const { params } = render(wheres[0])
    expect(params).toEqual(
      expect.arrayContaining(['msg-1', 'chat-A', 'user-1'])
    )
  })

  it("returns null for a message in another user's chat", async () => {
    // The join on chats + chats.userId filter (and RLS) yields no row.
    installTx({ select: () => makeChain(() => []) })

    const result = await getMessageFollowups('chat-B', 'msg-2', 'user-1')

    expect(result).toBeNull()
    expect(rlsUserIds()).toEqual(['user-1'])
  })

  it('returns null when the message has no followups yet', async () => {
    installTx({
      select: () => makeChain(() => [{ metadata: { modelId: 'm' } }])
    })

    expect(await getMessageFollowups('chat-A', 'msg-1', 'user-1')).toBeNull()
  })

  it('returns null when metadata is null', async () => {
    installTx({ select: () => makeChain(() => [{ metadata: null }]) })

    expect(await getMessageFollowups('chat-A', 'msg-1', 'user-1')).toBeNull()
  })
})

describe('saveMessageFollowups', () => {
  it('merges followups into existing metadata', async () => {
    let setArg: any
    const wheres: any[] = []
    installTx({
      update: () => {
        const chain = makeChain(
          () => [{ id: 'msg-1' }],
          p => wheres.push(p)
        )
        chain.set = vi.fn((arg: any) => {
          setArg = arg
          return chain
        })
        return chain
      }
    })

    const ok = await saveMessageFollowups('chat-A', 'msg-1', 'user-1', [
      'Q1?',
      'Q2?'
    ])

    expect(ok).toBe(true)
    expect(rlsUserIds()).toEqual(['user-1'])
    // Only metadata is touched, and it is a jsonb MERGE over the existing
    // value (so modelId / traceId survive), not a replacement object.
    expect(Object.keys(setArg)).toEqual(['metadata'])
    const { sql: text, params } = render(setArg.metadata)
    expect(text).toContain(`coalesce("messages"."metadata", '{}'::jsonb) ||`)
    expect(text).toContain(`jsonb_build_object('followups',`)
    expect(params).toContain(JSON.stringify(['Q1?', 'Q2?']))
    // Scoped to this message, this chat, and a chat owned by this user.
    const cols = columnsIn(wheres[0])
    expect(cols).toContain('id')
    expect(cols).toContain('chat_id')
    expect(cols).toContain('user_id')
    const where = render(wheres[0])
    expect(where.params).toEqual(
      expect.arrayContaining(['msg-1', 'chat-A', 'user-1'])
    )
  })

  it('retries until the message exists', async () => {
    vi.useFakeTimers()
    const results = [[], [], [{ id: 'msg-1' }]]
    let calls = 0
    installTx({ update: () => makeChain(() => results[calls++] ?? []) })

    const p = saveMessageFollowups('chat-A', 'msg-1', 'user-1', ['Q?'], {
      delayMs: 500
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(500)

    await expect(p).resolves.toBe(true)
    expect(calls).toBe(3)
  })

  it('gives up after retries and returns false', async () => {
    vi.useFakeTimers()
    let calls = 0
    installTx({
      update: () =>
        makeChain(() => {
          calls++
          return []
        })
    })

    const p = saveMessageFollowups('chat-A', 'msg-1', 'user-1', ['Q?'])
    // Defaults: 30 retries x 500 ms = 15 s of waiting.
    await vi.advanceTimersByTimeAsync(14_999)
    expect(calls).toBe(30)
    await vi.advanceTimersByTimeAsync(1)

    await expect(p).resolves.toBe(false)
    expect(calls).toBe(31) // first attempt + 30 retries
  })
})
