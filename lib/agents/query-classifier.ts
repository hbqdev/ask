import { generateText, Output, UIMessage } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { z } from 'zod'

import { SEARCH_INTENTS } from '../tools/search/intent'
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
// classifier. Wide enough that a follow-up referring to an EARLIER turn
// ("actually, back to my first question…") can still be recognized as
// answerable-from-context (skipSearch=true) rather than triggering a
// needless search — 20 messages ≈ ten prior Q&A pairs.
//
// This does NOT cost extra VRAM: serenity loads the model at 16384 context
// regardless, and 20 × MAX_HISTORY_CHARS_PER_MESSAGE + the system prompt
// stays inside that budget — widening the window just fills more of the
// context already allocated, at a small per-turn prefill cost. Beyond ~10
// pairs the returns are marginal while that latency is paid on every turn,
// so this is the ceiling. (The answering model always gets the FULL,
// unclipped history regardless — the classifier's view only gates
// search-vs-skip, it is not what answers.)
const HISTORY_WINDOW = 20

// Per-message cap on the history text shown to the classifier.
//
// This exists because bounding the message COUNT alone is not enough: an
// assistant turn here is a full research report (5,000-7,000 chars each),
// so a handful of them uncapped overflows the model's context and makes it
// silently return garbage — it resolved the PREVIOUS turn's topic and set
// skipSearch=true on a genuinely new question, so the researcher answered
// both topics at once (reproduced against the live model on the real
// conversation that surfaced this).
//
// serenity runs the classifier model at OLLAMA_CONTEXT_LENGTH=16384, so the
// budget is generous: the worst case (HISTORY_WINDOW messages all at this
// cap) + the system prompt is ~13k tokens, staying inside 16k with ~3k to
// spare. 2,500 chars keeps most of a real Q&A turn intact — enough for the
// classifier to see what a prior answer actually said (so "remind me about
// my first question" is recognized as answerable-from-context), not just a
// truncated stub. Prior messages are clipped; the latest message (the
// thing being classified) never is.
const MAX_HISTORY_CHARS_PER_MESSAGE = 2500

const classifierSchema = z.object({
  skipSearch: z.boolean(),
  standaloneQuery: z.string(),
  needsRecent: z.boolean(),
  intent: z.enum(SEARCH_INTENTS)
})

export interface QueryClassification {
  skipSearch: boolean
  standaloneQuery: string
  // True when the answer depends on current/recent information (news,
  // prices, versions, releases, schedules, "latest X"). Plumbs through to
  // SearXNG's time_range so this turn's searches prefer fresh pages.
  needsRecent: boolean
  // The kind of sources most useful for this turn. Maps to ONE additive
  // SearXNG category (intentToCategory) on top of the always-on general
  // baseline — never replaces it. 'general' adds nothing. A wrong guess is
  // harmless because the baseline always fires.
  intent: import('../tools/search/intent').SearchIntent
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

You also set needsRecent: true when a correct answer depends on current or recent information — news, current events, prices, exchange rates, product/software versions or releases, schedules, weather, "latest/newest/current X", anything that changes month to month. false for stable facts (history, geography, definitions, science, how-things-work) and for skipSearch=true turns.

You also set intent — the kind of sources most useful for answering:
- "code": programming, libraries, APIs, error messages, package/tooling questions, software how-to, technical documentation.
- "discussion": opinions, recommendations, personal experiences, "what do people think about X", community consensus.
- "news": current events, breaking news, recent happenings, "what happened with X".
- "academic": research papers, scientific or medical evidence, scholarly citations, studies.
- "general": everything else, or whenever you are not clearly in one of the above.

Only leave "general" when the intent is clearly one of the others. If uncertain, use "general".

If uncertain about needsRecent, default to needsRecent=false.

Examples:
1) Assistant said "Mount Fuji is the tallest mountain in Japan." User: "what about South Korea" -> South Korea is a NEW entity never mentioned -> skipSearch=false, needsRecent=false (geography is stable), intent="general", standaloneQuery="What is the tallest mountain in South Korea?"
2) Assistant said "Option 1: X. Option 2: Y. Best practice: do both." User: "so you are saying to do both, right?" -> no new entity, already answered -> skipSearch=true, needsRecent=false, intent="general", standaloneQuery="Confirm: should I do both X and Y?"
3) User: "hey how is it going" -> casual -> skipSearch=true, needsRecent=false, intent="general", standaloneQuery="greeting, no search needed"
4) Assistant said "The capital of France is Paris." User: "and Germany?" -> Germany is a NEW entity -> skipSearch=false, needsRecent=false, intent="general", standaloneQuery="What is the capital of Germany?"
5) User: "what's the latest stable version of Node.js" -> version info changes constantly and this is a software question -> skipSearch=false, needsRecent=true, intent="code", standaloneQuery="What is the latest stable version of Node.js?"
6) User: "did anything major happen in AI this week" -> current events -> skipSearch=false, needsRecent=true, intent="news", standaloneQuery="Major AI news this week"
7) User: "what mechanical keyboard do people actually recommend" -> opinions/community consensus -> skipSearch=false, needsRecent=false, intent="discussion", standaloneQuery="Recommended mechanical keyboards according to users"
8) User: "does creatine actually improve muscle recovery, any studies" -> scientific evidence -> skipSearch=false, needsRecent=false, intent="academic", standaloneQuery="Does creatine improve muscle recovery (research evidence)?"

standaloneQuery is always a short plain string, never empty, never a meta-question back to the user.`

// Prior-turn text is clipped, never the latest message: the latest message
// is the thing being classified and must survive intact.
function clipHistoryText(text: string): string {
  return text.length > MAX_HISTORY_CHARS_PER_MESSAGE
    ? text.slice(0, MAX_HISTORY_CHARS_PER_MESSAGE) + '…[truncated]'
    : text
}

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
            `${m.role === 'user' ? 'User' : 'Assistant'}: ${clipHistoryText(getTextFromParts(m.parts))}`
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
    standaloneQuery: latestMessage,
    needsRecent: false,
    intent: 'general'
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
