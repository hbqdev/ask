import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentUserId } from '@/lib/auth/get-current-user'
import * as memoryDb from '@/lib/db/memory-actions'
import type { UserMemory } from '@/lib/db/schema'

import {
  clearMemoriesAction,
  deleteMemoryAction,
  getMemories,
  getMemoryEnabled,
  setMemoryEnabledAction
} from '../memory'

// Mock the modules
vi.mock('@/lib/auth/get-current-user')
vi.mock('@/lib/db/memory-actions')

describe('Memory Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getMemories', () => {
    it('should return memories for authenticated user', async () => {
      const userId = 'user-123'
      const mockMemories: UserMemory[] = [
        {
          id: 'mem-1',
          userId,
          content: 'Likes TypeScript',
          category: 'preference',
          status: 'confirmed',
          sightings: 2,
          embedding: [],
          sourceChatId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastUsedAt: null
        }
      ]

      vi.mocked(getCurrentUserId).mockResolvedValue(userId)
      vi.mocked(memoryDb.listMemories).mockResolvedValue(mockMemories)

      const result = await getMemories()

      expect(result).toEqual(mockMemories)
      expect(memoryDb.listMemories).toHaveBeenCalledWith(userId)
    })

    it('should return empty array for unauthenticated user', async () => {
      vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

      const result = await getMemories()

      expect(result).toEqual([])
      expect(memoryDb.listMemories).not.toHaveBeenCalled()
    })
  })

  describe('getMemoryEnabled', () => {
    it('should delegate to isMemoryEnabled for authenticated user', async () => {
      const userId = 'user-123'
      vi.mocked(getCurrentUserId).mockResolvedValue(userId)
      vi.mocked(memoryDb.isMemoryEnabled).mockResolvedValue(false)

      const result = await getMemoryEnabled()

      expect(result).toBe(false)
      expect(memoryDb.isMemoryEnabled).toHaveBeenCalledWith(userId)
    })

    it('should default to true for unauthenticated user without calling the DB', async () => {
      vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

      const result = await getMemoryEnabled()

      expect(result).toBe(true)
      expect(memoryDb.isMemoryEnabled).not.toHaveBeenCalled()
    })
  })

  describe('deleteMemoryAction', () => {
    it('should delete the memory for authenticated user', async () => {
      const userId = 'user-123'
      vi.mocked(getCurrentUserId).mockResolvedValue(userId)
      vi.mocked(memoryDb.deleteMemory).mockResolvedValue(undefined)

      const result = await deleteMemoryAction('mem-1')

      expect(result).toEqual({ success: true })
      expect(memoryDb.deleteMemory).toHaveBeenCalledWith(userId, 'mem-1')
    })

    it('should return an error for unauthenticated user without calling the DB', async () => {
      vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

      const result = await deleteMemoryAction('mem-1')

      expect(result).toEqual({
        success: false,
        error: 'User not authenticated'
      })
      expect(memoryDb.deleteMemory).not.toHaveBeenCalled()
    })
  })

  describe('clearMemoriesAction', () => {
    it('should clear all memories for authenticated user', async () => {
      const userId = 'user-123'
      vi.mocked(getCurrentUserId).mockResolvedValue(userId)
      vi.mocked(memoryDb.clearMemories).mockResolvedValue(undefined)

      const result = await clearMemoriesAction()

      expect(result).toEqual({ success: true })
      expect(memoryDb.clearMemories).toHaveBeenCalledWith(userId)
    })

    it('should return an error for unauthenticated user without calling the DB', async () => {
      vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

      const result = await clearMemoriesAction()

      expect(result).toEqual({
        success: false,
        error: 'User not authenticated'
      })
      expect(memoryDb.clearMemories).not.toHaveBeenCalled()
    })
  })

  describe('setMemoryEnabledAction', () => {
    it('should set memory enabled for authenticated user', async () => {
      const userId = 'user-123'
      vi.mocked(getCurrentUserId).mockResolvedValue(userId)
      vi.mocked(memoryDb.setMemoryEnabled).mockResolvedValue(undefined)

      const result = await setMemoryEnabledAction(false)

      expect(result).toEqual({ success: true })
      expect(memoryDb.setMemoryEnabled).toHaveBeenCalledWith(userId, false)
    })

    it('should return an error for unauthenticated user without calling the DB', async () => {
      vi.mocked(getCurrentUserId).mockResolvedValue(undefined)

      const result = await setMemoryEnabledAction(true)

      expect(result).toEqual({
        success: false,
        error: 'User not authenticated'
      })
      expect(memoryDb.setMemoryEnabled).not.toHaveBeenCalled()
    })
  })
})
