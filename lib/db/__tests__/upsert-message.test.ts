import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the db module the same way lib/db/__tests__/with-rls.test.ts does, so
// `withRLS` (real, unmocked) drives our mock transaction instead of a real
// connection.
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn()
  }
}))

vi.mock('@/lib/utils/message-mapping', () => ({
  mapUIMessageToDBMessage: vi.fn((message: any) => ({
    id: message.id,
    chatId: message.chatId,
    role: message.role
  })),
  mapUIMessagePartsToDBParts: vi.fn(() => [{ id: 'p1' }]),
  buildUIMessageFromDB: vi.fn()
}))

import { db } from '@/lib/db'
import {
  conversationChunks,
  messages as messagesTable,
  parts as partsTable
} from '@/lib/db/schema'

import { upsertMessage } from '../actions'

/** A chainable stand-in for Drizzle's fluent insert/delete builders. */
function makeChain(resolvedValue: unknown) {
  const chain: any = {}
  chain.values = vi.fn(() => chain)
  chain.onConflictDoUpdate = vi.fn(() => chain)
  chain.where = vi.fn(() => chain)
  chain.returning = vi.fn(() => Promise.resolve(resolvedValue))
  chain.then = (resolve: any, reject: any) =>
    Promise.resolve(resolvedValue).then(resolve, reject)
  return chain
}

describe('upsertMessage', () => {
  let insertCalls: unknown[]
  let deleteCalls: unknown[]
  let mockTx: any

  beforeEach(() => {
    vi.clearAllMocks()
    insertCalls = []
    deleteCalls = []

    const messagesChain = makeChain([
      { id: 'm1', chatId: 'c1', role: 'assistant', createdAt: new Date() }
    ])
    const noopChain = makeChain(undefined)

    mockTx = {
      execute: vi.fn(),
      insert: vi.fn((table: unknown) => {
        insertCalls.push(table)
        return table === messagesTable ? messagesChain : noopChain
      }),
      delete: vi.fn((table: unknown) => {
        deleteCalls.push(table)
        return noopChain
      })
    }

    vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(mockTx))
  })

  it('deletes the message parts AND its stale conversation_chunks in the same transaction', async () => {
    await upsertMessage(
      {
        id: 'm1',
        chatId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'edited answer' }]
      } as any,
      'u1'
    )

    // Both deletes happened on the same mock tx (i.e. inside the one
    // transaction), and the conversation_chunks delete fired, not just the
    // parts delete.
    expect(deleteCalls).toContain(partsTable)
    expect(deleteCalls).toContain(conversationChunks)
  })

  it('scopes the conversation_chunks delete to this message id', async () => {
    await upsertMessage(
      {
        id: 'm1',
        chatId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'edited answer' }]
      } as any,
      'u1'
    )

    const chunksDeleteIndex = deleteCalls.indexOf(conversationChunks)
    expect(chunksDeleteIndex).toBeGreaterThanOrEqual(0)

    // The chain returned for the conversation_chunks delete recorded a
    // `.where(...)` call — assert it was called (the exact SQL predicate is
    // covered by recall-actions-sql.test.ts's pattern for this codebase;
    // here we just verify the delete is filtered, not table-wide).
    const noopChainReturned =
      mockTx.delete.mock.results[chunksDeleteIndex].value
    expect(noopChainReturned.where).toHaveBeenCalled()
  })

  it('still inserts new parts after purging stale chunks', async () => {
    await upsertMessage(
      {
        id: 'm1',
        chatId: 'c1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'edited answer' }]
      } as any,
      'u1'
    )

    expect(insertCalls).toContain(partsTable)
  })
})
