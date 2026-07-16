import { generateText, Output } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { z } from 'zod'

import type { MemoryCandidate } from '../memory/types'
import { createTimeoutFetch } from '../utils/fetch-with-timeout'

const MODEL_ID = 'granite4.1:8b'
const TIMEOUT_MS = 10_000

const schema = z.object({
  memories: z.array(
    z.object({
      content: z.string(),
      category: z.enum(['preference', 'fact', 'interest'])
    })
  )
})

const SYSTEM_PROMPT = `You extract DURABLE facts about the USER that are worth remembering across future conversations.

Extract ONLY:
- stable preferences (how they like answers, tools/tech they favor)
- identity/role/context (their job, where they are, what they build)
- recurring interests
- lasting constraints

Do NOT extract:
- transient or one-off details tied to this specific question
- anything about the assistant's answer or the topic being researched
- sensitive personal data (health, politics, religion, finances) UNLESS the user explicitly states it as a lasting preference
- speculation — only what the user actually stated about themselves

Write each memory as a short third-person statement ("Prefers concise answers", "Self-hosts their infrastructure"). Return an empty array if nothing durable was stated — that is the common case; do not force memories.`

export async function extractMemories({
  userMessage,
  standaloneQuery,
  abortSignal
}: {
  userMessage: string
  standaloneQuery?: string
  abortSignal?: AbortSignal
}): Promise<MemoryCandidate[]> {
  const baseUrl =
    process.env.CLASSIFIER_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL
  if (!baseUrl || !userMessage.trim()) return []

  try {
    const provider = createOllama({
      baseURL: baseUrl,
      fetch: createTimeoutFetch(TIMEOUT_MS, abortSignal)
    })
    const { output } = await generateText({
      model: provider(MODEL_ID, { think: false, keep_alive: -1 }),
      system: SYSTEM_PROMPT,
      prompt: `User message: ${userMessage}${
        standaloneQuery ? `\nResolved form: ${standaloneQuery}` : ''
      }`,
      temperature: 0,
      abortSignal,
      output: Output.object({ schema })
    })
    return (output?.memories ?? [])
      .map(m => ({ content: m.content.trim(), category: m.category }))
      .filter(m => m.content.length > 0)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('memory extraction failed:', error)
    }
    return []
  }
}
