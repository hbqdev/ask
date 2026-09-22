import { desc, eq } from 'drizzle-orm'

import { messages } from '@/lib/db/schema'
import { withRLS } from '@/lib/db/with-rls'

/** Id of the newest persisted message in a chat (one indexed row, RLS-scoped). */
export async function getLatestMessageId(
  chatId: string,
  userId: string
): Promise<string | null> {
  const [row] = await withRLS(userId, tx =>
    tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1)
  )
  return row?.id ?? null
}
