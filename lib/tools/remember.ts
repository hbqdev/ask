import { tool } from 'ai'
import { z } from 'zod'

import { isMemoryEnabled } from '@/lib/db/memory-actions'
import { saveCandidates } from '@/lib/memory/write'

/**
 * Lets the researcher save a durable user fact (user-directed: "remember that
 * I …", or a clearly lasting preference the model recognizes). Bound to the
 * current user; a missing userId makes it inert.
 *
 * `retrievalTurn` is the injection guard: on a turn where the answer is driven
 * by `search`/`fetch`, a `remember` call may have been induced by instructions
 * embedded in an untrusted retrieved page. In that case the memory is written
 * as a CANDIDATE (confirmed:false), so it requires graduation (repeated genuine
 * sightings) before `getMemoryInjection` ever puts it into a future system
 * prompt — closing the one-shot memory-poisoning path. On non-retrieval turns
 * (direct / stable-knowledge) a genuine user-directed remember stays an
 * immediate CONFIRMED write.
 */
export function createRememberTool(
  userId: string | undefined,
  retrievalTurn = false
) {
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
        { content, category, confirmed: !retrievalTurn }
      ])
      return { saved: n > 0 }
    }
  })
}
