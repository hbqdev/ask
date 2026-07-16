import { tool } from 'ai'
import { z } from 'zod'

import { isMemoryEnabled } from '@/lib/db/memory-actions'
import { saveCandidates } from '@/lib/memory/write'

/**
 * Lets the researcher save a durable user fact immediately (user-directed:
 * "remember that I …", or a clearly lasting preference the model recognizes).
 * Writes a CONFIRMED memory through the same dedup write path. Bound to the
 * current user; a missing userId makes it inert.
 */
export function createRememberTool(userId: string | undefined) {
  return tool({
    description:
      'Save a durable fact or preference about the user to long-term memory so future conversations remember it. Use when the user asks you to remember something, or states a clearly lasting preference/identity fact. Do NOT use for transient details about the current question.',
    inputSchema: z.object({
      content: z
        .string()
        .describe(
          'The fact as a short third-person statement, e.g. "Prefers concise answers"'
        ),
      category: z.enum(['preference', 'fact', 'interest'])
    }),
    execute: async ({ content, category }) => {
      if (!userId || !(await isMemoryEnabled(userId))) return { saved: false }
      const n = await saveCandidates(userId, [
        { content, category, confirmed: true }
      ])
      return { saved: n > 0 }
    }
  })
}
