import { tool } from 'ai'
import { z } from 'zod'

import { isRecallEnabled } from '@/lib/db/recall-actions'
import { recallSearch } from '@/lib/memory/recall-search'

function toolTopK(): number {
  const n = Number(process.env.RECALL_TOOL_TOP_K)
  return Number.isFinite(n) && n > 0 ? n : 5
}

/**
 * Lets the researcher search the user's OWN past conversations. Bound to the
 * current user; a missing userId or a disabled toggle makes it inert (the
 * kill switch must gate the tool itself, not just injection).
 */
export function createRecallTool(
  userId: string | undefined,
  currentChatId: string | undefined
) {
  return tool({
    description:
      'Search the user\'s own past conversations for what was previously discussed or decided. Use when the user refers to earlier context ("what did we decide about X", "that tool you recommended"). Do NOT use for general web knowledge — use search for that.',
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          'What to look for in the past conversations, in plain language'
        )
    }),
    execute: async ({ query }) => {
      if (!userId || !(await isRecallEnabled(userId))) return { results: [] }
      const hits = await recallSearch(userId, query, {
        topK: toolTopK(),
        useRerank: true,
        excludeChatId: currentChatId
      })
      return {
        results: hits.map(h => ({
          chatId: h.chatId,
          chatTitle: h.chatTitle,
          role: h.role,
          date: h.createdAt.toISOString().slice(0, 10),
          content: h.content
        }))
      }
    }
  })
}
