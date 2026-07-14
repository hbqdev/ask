import { generateText, Output, UIMessage } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { z } from 'zod'

import { createTimeoutFetch } from '../utils/fetch-with-timeout'
import { getTextFromParts } from '../utils/message-utils'

// Dedicated, fixed model for this classification — deliberately NOT routed
// through registry.ts's getModel(), so this call stays independent of
// whatever model the user has selected for the chat itself, and of
// registry.ts's own think-mode handling. Runs against a separate Ollama
// host (see CLASSIFIER_OLLAMA_BASE_URL below), not the one used for the
// rest of the app's Ollama models.
//
// granite4.1 was chosen specifically for its native structured-JSON-
// output support — validated 8/8 against this exact prompt (new-entity,
// confirmation, and casual cases, 2 runs each at temperature 0), never
// broke schema compliance. qwen2.5:3b (previous choice) also passed but
// had no particular structured-output design behind it. qwen3.5:4b was
// tried and rejected: with thinking disabled it returns plain text like
// `skipSearch=true, standaloneQuery="..."` instead of a JSON object
// (AI_NoObjectGeneratedError, silently falls back to always-search); with
// thinking enabled it's far too slow for a per-turn gate (didn't finish 3
// calls in 6+ minutes). Running the 8b variant (also 8/8) rather than 3b
// now that serenity's Quadro P5000 is GPU-accelerating it (was CPU-only
// due to a stale Windows NVIDIA driver, since fixed) — warm latency on
// GPU is back down in the sub-second range that made 3b viable on CPU.
const CLASSIFIER_MODEL_ID = 'granite4.1:8b'

// Short — this is a small structured-output call, not a research turn. If
// it doesn't come back quickly, fall back rather than delay the real
// response (see classifyQuery's catch block).
const CLASSIFIER_TIMEOUT_MS = 10_000

// How many trailing messages (both user and assistant) to show the
// classifier. Bounded and small on purpose: this call's whole job is
// deciding what's needed for the CURRENT turn, not summarizing the whole
// conversation — matches the "last N raw messages" approach both
// open-webui and Perplexica use for the same step.
const HISTORY_WINDOW = 6

const classifierSchema = z.object({
  skipSearch: z.boolean(),
  standaloneQuery: z.string()
})

export interface QueryClassification {
  skipSearch: boolean
  standaloneQuery: string
}

// Matches Anthropic's/OpenAI's own tool-calling guidance (let one model
// decide inline) for the common case, but adds the one narrow, structural
// carve-out that prose instructions inside the main research prompt kept
// failing to hold onto reliably: pure clarifications about the assistant's
// OWN prior answer. Validated live at temperature 0 — see conversation
// history for the test transcript this prompt is tuned against (new-entity
// follow-ups, pure confirmations, and casual chit-chat).
const CLASSIFIER_SYSTEM_PROMPT = `You decide whether a NEW web search is needed to answer the latest user message, given the conversation so far.

Rule: if the latest message names a different subject/entity than what was already discussed, or asks for any fact not yet stated above, that is ALWAYS skipSearch=false - no exceptions, even if the question is short or looks like a follow-up.

Rule: skipSearch=true ONLY when the latest message is casual small talk (greeting/thanks) OR purely asks to confirm/restate/compare something the assistant ALREADY explicitly stated above, with the new message introducing zero new subject.

If uncertain which rule applies, default to skipSearch=false.

Examples:
1) Assistant said "Mount Fuji is the tallest mountain in Japan." User: "what about South Korea" -> South Korea is a NEW entity never mentioned -> skipSearch=false, standaloneQuery="What is the tallest mountain in South Korea?"
2) Assistant said "Option 1: X. Option 2: Y. Best practice: do both." User: "so you are saying to do both, right?" -> no new entity, already answered -> skipSearch=true, standaloneQuery="Confirm: should I do both X and Y?"
3) User: "hey how is it going" -> casual -> skipSearch=true, standaloneQuery="greeting, no search needed"
4) Assistant said "The capital of France is Paris." User: "and Germany?" -> Germany is a NEW entity -> skipSearch=false, standaloneQuery="What is the capital of Germany?"

standaloneQuery is always a short plain string, never empty, never a meta-question back to the user.`

function buildConversationTranscript(messages: UIMessage[]): {
  history: string
  latestMessage: string
} {
  const windowed = messages.slice(-HISTORY_WINDOW)
  const latest = windowed[windowed.length - 1]
  const priorTurns = windowed.slice(0, -1)

  const history = priorTurns.length
    ? priorTurns
        .map(
          m =>
            `${m.role === 'user' ? 'User' : 'Assistant'}: ${getTextFromParts(m.parts)}`
        )
        .join('\n')
    : '(no prior messages — this is the first message in the conversation)'

  return { history, latestMessage: getTextFromParts(latest?.parts) }
}

export async function classifyQuery({
  messages,
  abortSignal
}: {
  messages: UIMessage[]
  abortSignal?: AbortSignal
}): Promise<QueryClassification> {
  const { history, latestMessage } = buildConversationTranscript(messages)

  // Fallback matches today's existing behavior exactly: always search,
  // using the raw latest message as-is. A classifier failure can never
  // make search-scoping worse than it already was before this feature.
  const fallback: QueryClassification = {
    skipSearch: false,
    standaloneQuery: latestMessage
  }

  // Runs on a dedicated Ollama host (serenity, GPU-backed) instead of
  // OLLAMA_BASE_URL so this classification never competes with the main
  // app's Ollama traffic/model loads. Falls back to OLLAMA_BASE_URL if
  // unset so local dev without a second host still works. Read fresh on
  // every call (not hoisted to module scope) so env changes take effect
  // without a process restart, matching the original behavior.
  const classifierBaseUrl =
    process.env.CLASSIFIER_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL

  if (!classifierBaseUrl) {
    return fallback
  }

  try {
    // createTimeoutFetch enforces CLASSIFIER_TIMEOUT_MS on the actual HTTP
    // call regardless of whether ai-sdk-ollama forwards the AI SDK's own
    // abortSignal (it doesn't — see the same fix in registry.ts), and also
    // merges in the caller's abortSignal so a client disconnect still cuts
    // this short.
    const provider = createOllama({
      baseURL: classifierBaseUrl,
      fetch: createTimeoutFetch(CLASSIFIER_TIMEOUT_MS, abortSignal)
    })

    const { output: classification } = await generateText({
      // keep_alive: -1 keeps this model resident in Ollama's memory
      // indefinitely — otherwise Ollama's default 5-minute idle timeout
      // unloads it between calls, and the next classification pays a slow
      // cold-load penalty instead of the fast warm-inference path.
      model: provider(CLASSIFIER_MODEL_ID, { think: false, keep_alive: -1 }),
      system: CLASSIFIER_SYSTEM_PROMPT,
      prompt: `Conversation so far:\n${history}\n\nLatest message: ${latestMessage}`,
      temperature: 0,
      abortSignal,
      output: Output.object({ schema: classifierSchema })
    })

    if (!classification || !classification.standaloneQuery.trim()) {
      return fallback
    }

    return classification
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        'Query classifier failed, defaulting to always-search:',
        error
      )
    }
    return fallback
  }
}
