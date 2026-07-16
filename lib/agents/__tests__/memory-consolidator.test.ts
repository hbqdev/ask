import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { consolidateUser } from '../memory-consolidator'

vi.mock('@/lib/db/memory-actions', () => ({
  listMemories: vi.fn(),
  deleteMemory: vi.fn(),
  evictOverCap: vi.fn()
}))

const { listMemories, deleteMemory, evictOverCap } = await import(
  '@/lib/db/memory-actions'
)
const mockListMemories = vi.mocked(listMemories)
const mockDeleteMemory = vi.mocked(deleteMemory)
const mockEvictOverCap = vi.mocked(evictOverCap)

describe('consolidateUser', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteMemory.mockResolvedValue(undefined)
    mockEvictOverCap.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('deletes older duplicate confirmed memories (case-insensitive, whitespace-trimmed)', async () => {
    const userId = 'user-123'
    // Memories are returned newest-first (desc updatedAt)
    mockListMemories.mockResolvedValue([
      {
        id: 'memory-1',
        userId,
        content: 'Self-hosts their infrastructure',
        category: 'fact' as const,
        status: 'confirmed' as const,
        sightings: 5,
        embedding: [0.1, 0.2],
        sourceChatId: null,
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02'),
        lastUsedAt: new Date('2024-01-02')
      },
      {
        id: 'memory-2',
        userId,
        content: '  self-hosts their infrastructure  ',
        category: 'fact' as const,
        status: 'confirmed' as const,
        sightings: 3,
        embedding: [0.1, 0.2],
        sourceChatId: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        lastUsedAt: new Date('2024-01-01')
      }
    ] as any)

    const result = await consolidateUser(userId)

    expect(result).toEqual({ merged: 1, evicted: 0 })
    expect(mockDeleteMemory).toHaveBeenCalledOnce()
    expect(mockDeleteMemory).toHaveBeenCalledWith(userId, 'memory-2')
    expect(mockEvictOverCap).toHaveBeenCalledOnce()
    expect(mockEvictOverCap).toHaveBeenCalledWith(userId, 30)
  })

  it('skips non-confirmed (candidate) memories', async () => {
    const userId = 'user-123'
    mockListMemories.mockResolvedValue([
      {
        id: 'memory-1',
        userId,
        content: 'Confirmed memory',
        category: 'fact' as const,
        status: 'confirmed' as const,
        sightings: 1,
        embedding: [0.1, 0.2],
        sourceChatId: null,
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-02'),
        lastUsedAt: null
      },
      {
        id: 'memory-2',
        userId,
        content: 'Confirmed memory',
        category: 'fact' as const,
        status: 'candidate' as const,
        sightings: 1,
        embedding: [0.1, 0.2],
        sourceChatId: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        lastUsedAt: null
      }
    ] as any)

    const result = await consolidateUser(userId)

    expect(result).toEqual({ merged: 0, evicted: 0 })
    expect(mockDeleteMemory).not.toHaveBeenCalled()
  })

  it('resolves to { merged: 0, evicted: 0 } when listMemories rejects (DB error)', async () => {
    const userId = 'user-123'
    mockListMemories.mockRejectedValue(new Error('Database connection failed'))

    const result = await consolidateUser(userId)

    expect(result).toEqual({ merged: 0, evicted: 0 })
    expect(mockDeleteMemory).not.toHaveBeenCalled()
  })

  it('respects MEMORY_MAX_PER_USER environment variable', async () => {
    const userId = 'user-123'
    process.env.MEMORY_MAX_PER_USER = '50'

    mockListMemories.mockResolvedValue([
      {
        id: 'memory-1',
        userId,
        content: 'Memory one',
        category: 'fact' as const,
        status: 'confirmed' as const,
        sightings: 1,
        embedding: [0.1, 0.2],
        sourceChatId: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        lastUsedAt: null
      }
    ] as any)

    await consolidateUser(userId)

    expect(mockEvictOverCap).toHaveBeenCalledWith(userId, 50)

    delete process.env.MEMORY_MAX_PER_USER
  })

  it('defaults to cap of 30 when MEMORY_MAX_PER_USER is not set or invalid', async () => {
    const userId = 'user-123'
    delete process.env.MEMORY_MAX_PER_USER

    mockListMemories.mockResolvedValue([
      {
        id: 'memory-1',
        userId,
        content: 'Memory one',
        category: 'fact' as const,
        status: 'confirmed' as const,
        sightings: 1,
        embedding: [0.1, 0.2],
        sourceChatId: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-01'),
        lastUsedAt: null
      }
    ] as any)

    await consolidateUser(userId)

    expect(mockEvictOverCap).toHaveBeenCalledWith(userId, 30)
  })
})
