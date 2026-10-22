import { beforeEach, describe, expect, it, vi } from 'vitest'

// getMemories runs the real listMemories over a fake RLS-scoped tx that
// returns, like Postgres, only the columns the query projects. So this checks
// what the web settings panel actually receives.
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/with-rls', () => ({
  withOptionalRLS: vi.fn((_userId: string, cb: (tx: any) => unknown) =>
    cb(fakeTx)
  )
}))
vi.mock('@/lib/embeddings/transformers-embedding', () => ({
  embedTexts: vi.fn(),
  getConfiguredModel: vi.fn()
}))

import { getCurrentUserId } from '@/lib/auth/get-current-user'

import { getMemories } from '../memory'

const STORED: Record<string, unknown> = {
  id: 'mem-1',
  userId: 'user-1',
  content: 'Prefers concise answers',
  category: 'preference',
  status: 'candidate',
  sightings: 1,
  embedding: Array.from({ length: 1024 }, () => 0.5),
  sourceChatId: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-02T00:00:00Z'),
  lastUsedAt: null
}

let fakeTx: any

beforeEach(() => {
  vi.clearAllMocks()
  fakeTx = {
    select: (projection?: Record<string, unknown>) => {
      const row = projection
        ? Object.fromEntries(Object.keys(projection).map(k => [k, STORED[k]]))
        : STORED
      const chain: any = {
        from: () => chain,
        where: () => chain,
        orderBy: () => Promise.resolve([row])
      }
      return chain
    }
  }
})

describe('getMemories', () => {
  it('omits embedding', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue('user-1')

    const memories = await getMemories()

    expect(memories).toHaveLength(1)
    expect(memories[0]).not.toHaveProperty('embedding')
    expect(memories[0]).toMatchObject({
      id: 'mem-1',
      content: 'Prefers concise answers',
      status: 'candidate'
    })
  })
})
