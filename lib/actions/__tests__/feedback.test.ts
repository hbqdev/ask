import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the modules before any imports
vi.mock('@/lib/db')
vi.mock('langfuse')
vi.mock('@/lib/utils/telemetry')

// withOptionalRLS branches on userId: null runs callback(db) directly, a real
// id routes through withRLS -> db.transaction, which the auto-mocked db module
// cannot satisfy. These tests exercise the QUERY, not transaction plumbing, so
// both wrappers just hand the callback the mocked db.
vi.mock('@/lib/db/with-rls', async () => {
  const { db } = await import('@/lib/db')
  return {
    withOptionalRLS: (_userId: unknown, cb: (tx: unknown) => unknown) => cb(db),
    withRLS: (_userId: unknown, cb: (tx: unknown) => unknown) => cb(db)
  }
})

// Import after mocking
import { Langfuse } from 'langfuse'

import { db } from '@/lib/db'
import { isTracingEnabled } from '@/lib/utils/telemetry'

import { getMessageFeedback, updateMessageFeedback } from '../feedback'

// updateMessageFeedback is now owner-scoped: it refuses a null userId and
// resolves the message through an innerJoin on chats.userId, because the RLS
// policy meant to scope it never evaluates (app role is superuser, tables are
// relforcerowsecurity=f). getMessageFeedback below is unchanged.
const TEST_USER_ID = 'test-user-id'

describe('Feedback Actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('updateMessageFeedback', () => {
    it('should update message feedback successfully', async () => {
      const messageId = 'test-message-id'
      const chatId = 'test-chat-id'
      const score = 1

      // Mock db.select
      const mockLimit = vi.fn().mockResolvedValue([
        {
          metadata: { traceId: 'test-trace-id' },
          chatId
        }
      ])
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere })
      const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })

      // Mock db.update
      const mockUpdateWhere = vi.fn().mockResolvedValue(undefined)
      const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere })
      vi.mocked(db).update = vi.fn().mockReturnValue({ set: mockSet })

      // Mock tracing disabled
      vi.mocked(isTracingEnabled).mockReturnValue(false)

      const result = await updateMessageFeedback(messageId, score, TEST_USER_ID)

      expect(result).toEqual({ success: true })
      expect(db.select).toHaveBeenCalled()
      expect(db.update).toHaveBeenCalled()
    })

    it('should return error when message not found', async () => {
      const messageId = 'non-existent-id'
      const score = 1

      // Mock empty database response
      const mockLimit = vi.fn().mockResolvedValue([])
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere })
      const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })

      const result = await updateMessageFeedback(messageId, score, TEST_USER_ID)

      expect(result).toEqual({
        success: false,
        error: 'Message not found'
      })
    })

    it('should handle errors gracefully', async () => {
      const messageId = 'test-message-id'
      const score = -1

      // Mock database error
      const mockLimit = vi.fn().mockRejectedValue(new Error('Database error'))
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere })
      const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })

      const result = await updateMessageFeedback(messageId, score, TEST_USER_ID)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database error')
    })

    it('should send feedback to Langfuse when tracing is enabled', async () => {
      const messageId = 'test-message-id'
      const chatId = 'test-chat-id'
      const score = 1

      // Enable tracing
      vi.mocked(isTracingEnabled).mockReturnValue(true)

      // Mock Langfuse
      const mockScore = vi.fn()
      const mockFlush = vi.fn().mockResolvedValue(undefined)
      vi.mocked(Langfuse).mockImplementation(function () {
        return {
          score: mockScore,
          flushAsync: mockFlush
        } as any
      } as any)

      // Mock db.select
      const mockLimit = vi.fn().mockResolvedValue([
        {
          metadata: { traceId: 'test-trace-id' },
          chatId
        }
      ])
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere })
      const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })

      // Mock db.update
      const mockUpdateWhere = vi.fn().mockResolvedValue(undefined)
      const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere })
      vi.mocked(db).update = vi.fn().mockReturnValue({ set: mockSet })

      const result = await updateMessageFeedback(messageId, score, TEST_USER_ID)

      expect(result).toEqual({ success: true })
      expect(Langfuse).toHaveBeenCalled()
      expect(mockScore).toHaveBeenCalledWith({
        traceId: 'test-trace-id',
        name: 'user-feedback',
        value: score,
        comment: 'Thumbs up'
      })
      expect(mockFlush).toHaveBeenCalled()
    })

    it('refuses to write when the caller has no identity', async () => {
      // Regression guard. This endpoint previously accepted a null userId and
      // still reached the UPDATE, and the RLS policy meant to scope it never
      // evaluates (app role is superuser, tables are relforcerowsecurity=f).
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: vi.fn() })
      vi.mocked(db).update = vi.fn().mockReturnValue({ set: vi.fn() })

      const result = await updateMessageFeedback('some-message-id', 1, null)

      expect(result).toEqual({ success: false, error: 'Not authenticated' })
      expect(db.select).not.toHaveBeenCalled()
      expect(db.update).not.toHaveBeenCalled()
    })

    it('does not write a message belonging to another user', async () => {
      // The ownership join returns no row, so the update must never run.
      // Message ids of public chats are served to every viewer, which is how a
      // foreign id reaches this function in the first place.
      const mockLimit = vi.fn().mockResolvedValue([])
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockInnerJoin = vi.fn().mockReturnValue({ where: mockWhere })
      const mockFrom = vi.fn().mockReturnValue({ innerJoin: mockInnerJoin })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })
      vi.mocked(db).update = vi.fn().mockReturnValue({ set: vi.fn() })

      const result = await updateMessageFeedback(
        'someone-elses-message',
        1,
        TEST_USER_ID
      )

      expect(result).toEqual({ success: false, error: 'Message not found' })
      expect(mockInnerJoin).toHaveBeenCalled()
      expect(db.update).not.toHaveBeenCalled()
    })
  })

  describe('getMessageFeedback', () => {
    it('should retrieve feedback score successfully', async () => {
      const messageId = 'test-message-id'
      const feedbackScore = 1

      // Mock database response
      const mockLimit = vi.fn().mockResolvedValue([
        {
          metadata: { feedbackScore }
        }
      ])
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })

      const result = await getMessageFeedback(messageId)

      expect(result).toBe(feedbackScore)
    })

    it('should return null when message not found', async () => {
      const messageId = 'non-existent-id'

      // Mock empty database response
      const mockLimit = vi.fn().mockResolvedValue([])
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })

      const result = await getMessageFeedback(messageId)

      expect(result).toBeNull()
    })

    it('should return null when no feedback score exists', async () => {
      const messageId = 'test-message-id'

      // Mock database response without feedbackScore
      const mockLimit = vi.fn().mockResolvedValue([
        {
          metadata: {}
        }
      ])
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })

      const result = await getMessageFeedback(messageId)

      expect(result).toBeNull()
    })

    it('should handle errors and return null', async () => {
      const messageId = 'test-message-id'

      // Mock database error
      const mockLimit = vi.fn().mockRejectedValue(new Error('Database error'))
      const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit })
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere })
      vi.mocked(db).select = vi.fn().mockReturnValue({ from: mockFrom })

      const result = await getMessageFeedback(messageId)

      expect(result).toBeNull()
    })
  })
})
