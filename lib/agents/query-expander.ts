import { generateText, Output } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { z } from 'zod'

import { createTimeoutFetch } from '../utils/fetch-with-timeout'

// Same dedicated host as the query classifier (serenity GPU) but the
// SMALLER granite variant: benchmarked 2026-07-14 on the extended suite,
// 3b passes the expansion task 3/3 at ~3.4s while 8b takes ~10s — and
// expansion must resolve inside the first search's bounded wait to be
// useful. (3b is NOT good enough for the classifier itself: 18/24 there,
// including wrong-skips, so the classifier stays on 8b.) Both models stay
// VRAM-resident (~9GB of 16GB) and serenity runs OLLAMA_NUM_PARALLEL=2 so
// this call doesn't queue behind the classifier.
const EXPANDER_MODEL_ID = 'granite4.1:3b'

// Slightly tighter than the classifier's timeout: expansion is a
// nice-to-have — a missed expansion just means single-query search,
// exactly today's behavior.
const EXPANDER_TIMEOUT_MS = 8_000

const expanderSchema = z.object({
  queries: z.array(z.string()).max(3)
})

const EXPANDER_SYSTEM_PROMPT = `You generate ALTERNATIVE web search queries for a user's question, so that searching all of them in parallel covers more of the web than the original phrasing alone.

Rules:
- Produce 2 or 3 alternatives. Each must be genuinely DIFFERENT from the original and from each other: use synonyms, expanded entity names, a more specific technical framing, or a broader/narrower angle. Do NOT just reorder the original words.
- Keep each alternative short (a realistic search-box query, not a sentence).
- Same language as the original question.
- Never include the original query itself in the list.

Examples:
Original: "granite 4.1 ollama structured output"
-> ["IBM Granite 4.1 JSON schema output", "ollama structured outputs granite model support"]

Original: "why is my postgres database so big"
-> ["postgres disk usage breakdown query", "postgresql bloat vacuum reclaim space", "find largest tables indexes postgres"]

Original: "best budget mechanical keyboard 2026"
-> ["affordable mechanical keyboards under $100 review", "top rated cheap hot-swappable keyboard"]`

/**
 * Expand a resolved standalone query into 2-3 diverse reformulations for
 * parallel search (Perplexica-style multi-query retrieval). Returns []
 * on any failure or timeout — callers treat that as "search the original
 * query only", i.e. exactly the pre-expansion behavior.
 */
export async function expandQuery({
  standaloneQuery,
  abortSignal
}: {
  standaloneQuery: string
  abortSignal?: AbortSignal
}): Promise<string[]> {
  const expanderBaseUrl =
    process.env.CLASSIFIER_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL
  if (!expanderBaseUrl || !standaloneQuery.trim()) {
    return []
  }

  try {
    const provider = createOllama({
      baseURL: expanderBaseUrl,
      fetch: createTimeoutFetch(EXPANDER_TIMEOUT_MS, abortSignal)
    })

    const { output } = await generateText({
      model: provider(EXPANDER_MODEL_ID, { think: false, keep_alive: -1 }),
      system: EXPANDER_SYSTEM_PROMPT,
      prompt: `Original: "${standaloneQuery}"`,
      temperature: 0,
      abortSignal,
      output: Output.object({ schema: expanderSchema })
    })

    return (output?.queries ?? [])
      .map(q => q.trim())
      .filter(
        q =>
          q.length > 0 &&
          q.toLowerCase() !== standaloneQuery.trim().toLowerCase()
      )
      .slice(0, 3)
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('Query expansion failed, searching original only:', error)
    }
    return []
  }
}
