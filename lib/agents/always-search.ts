import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage
} from '@ai-sdk/provider'
import { randomUUID } from 'crypto'

/**
 * ALWAYS_SEARCH — the owner's 2026-09-26 decision: every question gets a web
 * search. Only a non-question (greeting/thanks/venting, a pure transform of
 * text already present, pure arithmetic, an image request, an explicit
 * remember/forget instruction) may skip it, and that call is made by the
 * classifier's `skipSearch` (see CLASSIFIER_SYSTEM_PROMPT in
 * query-classifier.ts).
 *
 * The search is GUARANTEED (step 0 is forced) unless the user supplied the
 * subject themselves — a URL, or an attachment the text only points at (see
 * detectUserSuppliedSource). Those turns stay research turns with `search`
 * available; the model just is not made to search first.
 *
 * DEFAULT ON. Unset, empty or any other value keeps it on; only the literal
 * `off` disables it — the same convention as RECALL_ENABLED / MEMORY_ENABLED
 * (create-chat-stream-response.ts). Off restores the previous behaviour
 * exactly: the legacy classifier prompt and the D3 stable-knowledge gate. Read
 * at call time so a container recreate with ALWAYS_SEARCH=off reverts it
 * without a rebuild.
 */
export function isAlwaysSearchEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.ALWAYS_SEARCH !== 'off'
}

const URL_PATTERN = /https?:\/\/\S+/gi

// Long enough for any real standalone query (the classifier writes "a short
// plain string"); bounds the degenerate case where a bypass path (speed, URL,
// Retry, classifier failure) hands over a pasted wall of text as the query.
export const FORCED_SEARCH_QUERY_MAX_CHARS = 400

/**
 * The query the guaranteed first search runs, or null when there is nothing
 * to search.
 *
 * Takes the classifier's standaloneQuery — the follow-up resolved against the
 * conversation ("which one should I use for a game server?" → "Should a
 * multiplayer game server use TCP or UDP?"). On the bypass paths it is the raw
 * message, which is what those paths searched before.
 *
 * URLs are stripped: a URL is not a search query (the dedup wrapper routes a
 * URL-only query to `fetch` guidance for the same reason). A URL in the
 * latest message already cancels the forced search outright
 * (detectUserSuppliedSource); this strip covers a URL the classifier carried
 * into its rewrite from an earlier turn. Null — no forced search — when
 * nothing searchable remains.
 */
export function resolveForcedSearchQuery(
  standaloneQuery: string | undefined | null
): string | null {
  const cleaned = (standaloneQuery ?? '')
    .replace(URL_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  if (cleaned.length <= FORCED_SEARCH_QUERY_MAX_CHARS) return cleaned
  const clipped = cleaned.slice(0, FORCED_SEARCH_QUERY_MAX_CHARS)
  const lastSpace = clipped.lastIndexOf(' ')
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim()
}

/**
 * Why a research turn's first step is NOT forced: the user supplied the
 * subject of the turn themselves.
 *  - 'url': the latest message carries a URL — typed/pasted inline, or a
 *    pasted link chip (`data-sourceUrl`). The mode prompts say "a URL → fetch
 *    it, do NOT search first", and a chip is also retrieved and injected as a
 *    citable documentRetrieval. A forced search would run the message minus
 *    its URL ("summarise this") and override both.
 *  - 'attachment-only': an attachment (file, pasted-content card, quoted
 *    passage) with no typed text. The classifier sees text parts only, so it
 *    would be classifying an empty message and invent a query.
 *  - 'attachment-reference': an attachment whose text only points at it
 *    ("what is this", "summarise this file") — see isAttachmentReferenceOnly.
 */
export type UserSuppliedSource =
  | 'url'
  | 'attachment-only'
  | 'attachment-reference'

// Same test as the classifier bypass in create-chat-stream-response.ts, so an
// inline URL means the same thing on both paths. Non-global on purpose:
// RegExp#test on a /g pattern is stateful.
const CONTAINS_URL = /https?:\/\/\S+/i

// Non-text parts a user attaches to a message (chat-panel.tsx composer). A
// `data-sourceUrl` chip is handled as a URL above, before this.
const ATTACHMENT_PART_TYPES = new Set([
  'file',
  'data-pastedContent',
  'data-quotedContext'
])

type MessagePartLike = { type: string; text?: unknown; data?: unknown }

/**
 * Whether the latest user message supplies its own subject (see
 * UserSuppliedSource), from its UI parts. null = it does not, and the forced
 * first search applies as usual.
 *
 * Reads the parts, not the classifier's output: the classifier sees text parts
 * only (buildConversationTranscript) and never runs on the bypass paths (URL,
 * Retry, speed), so it cannot report an attachment or a link chip.
 */
export function detectUserSuppliedSource(
  parts: readonly MessagePartLike[] | null | undefined
): UserSuppliedSource | null {
  const list = parts ?? []
  const typedText = list
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text as string)
    .join(' ')
  const hasLinkChip = list.some(
    p =>
      p.type === 'data-sourceUrl' &&
      typeof (p.data as { url?: unknown } | undefined)?.url === 'string' &&
      Boolean((p.data as { url: string }).url)
  )
  if (hasLinkChip || CONTAINS_URL.test(typedText)) return 'url'
  if (!list.some(p => ATTACHMENT_PART_TYPES.has(p.type))) return null
  if (!typedText.trim()) return 'attachment-only'
  if (isAttachmentReferenceOnly(typedText)) return 'attachment-reference'
  return null
}

// Every word a message may use and still be ONLY a pointer at its attachment:
// question frames, auxiliaries, pronouns and deictics, politeness, verbs that
// act on the attachment itself, and nouns that name the attachment's medium.
// Deliberately closed and free of subject words: "what is this plant", "is
// this mushroom safe" or "how much does this cost" contain a word outside it,
// so they stay questions and keep their forced search. Only English is
// recognised; any other language is treated as a question (forced).
const ATTACHMENT_REFERENCE_WORDS = new Set(
  [
    // question frames and auxiliaries ("what's" is normalised to "whats")
    'what whats who whos which is are was does do did can could would will',
    // pronouns, deictics, articles, prepositions
    'you u i me my it its this that thats these those here heres there theres',
    'above attached a an the in on of about for with from at',
    // politeness and filler
    'please pls plz hey hi ok okay so and just quickly briefly kindly',
    // acting on the attachment itself
    'read summarise summarize summary describe explain identify transcribe',
    'extract analyse analyze review check look see show tell say says mean',
    'means contain contains written going happening help',
    // the attachment's medium
    'attachment attachments picture pictures pic pics photo photos photograph',
    'image images screenshot screenshots file files document documents doc',
    'docs pdf page pages text article video chart graph diagram table',
    'spreadsheet slide slides scan'
  ]
    .join(' ')
    .split(' ')
)

// A reference to an attachment is a short phrase; anything longer is treated
// as a question in its own right even if every word is in the list.
const ATTACHMENT_REFERENCE_MAX_WORDS = 10

/**
 * True when `text` asks nothing beyond pointing at the message's attachment —
 * "what is this", "what's in this picture?", "read this", "summarise this
 * file", "?" — so a web search on it would be meaningless: the subject is the
 * attachment, which the answering model sees and can search about afterwards.
 *
 * Conservative by construction (a closed word list, a length cap): a wrong
 * `false` costs one unhelpful search, a wrong `true` would drop the guaranteed
 * search from a real question, so every doubt resolves to `false`.
 */
export function isAttachmentReferenceOnly(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/'s\b/g, 's')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length > ATTACHMENT_REFERENCE_MAX_WORDS) return false
  return words.every(w => ATTACHMENT_REFERENCE_WORDS.has(w))
}

/**
 * The complete `search` tool input for the forced call.
 *
 * Every field is spelled out, not left to schema defaults, so the call also
 * validates against the strict all-required schema used for OpenAI o-models
 * (lib/schema/search.tsx). `search_depth` carries the turn's firstSearchDepth
 * so the call is identical to what the model would have sent; with depth
 * tiering on (every env) the tool resolves the first search's depth itself.
 */
export function buildForcedSearchInput(
  query: string,
  searchDepth: 'basic' | 'advanced'
) {
  return {
    query,
    search_mode: 'web' as const,
    type: 'optimized' as const,
    content_types: ['web' as const],
    max_results: 20,
    search_depth: searchDepth,
    include_domains: [] as string[],
    exclude_domains: [] as string[]
  }
}

const ZERO_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: 0,
    noCache: 0,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 0, text: 0, reasoning: undefined }
}

const TOOL_CALLS_FINISH: LanguageModelV3FinishReason = {
  unified: 'tool-calls',
  raw: 'forced-first-search'
}

export const FORCED_SEARCH_PROVIDER = 'ask.forced-first-search'

/**
 * A LanguageModel whose only output is ONE `search` tool call. The researcher
 * hands it step 0 through prepareStep's per-step `model` override; from step 1
 * on the user's real model runs with that search's results in its context.
 *
 * WHY NOT toolChoice. The obvious lever — prepareStep returning
 * `toolChoice: { type: 'tool', toolName: 'search' }` — is dropped by the
 * provider every answering model uses: ai-sdk-ollama@3.8.4's getCallOptions
 * never reads `toolChoice` and its doStream sends Ollama no tool_choice
 * (node_modules/ai-sdk-ollama/dist/index.js:16108-16207, 16865-16877). The
 * classifier relies on the same finding (query-classifier.ts, toolChoice
 * comment), and flows/variants.ts measured toolChoice on this stack as "a
 * strong hint rather than a guarantee". A prompt mandate is weaker still —
 * the research prompts already say "your FIRST action MUST be search" and
 * carve out an exception the model applies to follow-ups.
 *
 * WHY THIS IS ROBUST. The AI SDK treats this call exactly like a model-issued
 * one: it validates the input against the tool schema, executes the FULL
 * wrapped tool (source forcing, dedup, answer deadline, round cap, expansion
 * fan-out, advanced depth, telemetry), streams the same tool-input-available /
 * tool-output-available UI parts, persists the part, and the result is
 * citable by its toolCallId. The stream mirrors what ai-sdk-ollama emits for a
 * real call (a bare `tool-call` part with a crypto.randomUUID() id), so the UI
 * and persistence cannot tell the difference. It is provider-agnostic — it
 * never reaches the provider — and it removes a model round trip: the step
 * that would have spent a cloud call deciding to search now costs ~0 ms.
 */
export function createForcedSearchModel({
  input,
  toolName = 'search',
  toolCallId = randomUUID()
}: {
  input: Record<string, unknown>
  toolName?: string
  toolCallId?: string
}): LanguageModelV3 {
  const serializedInput = JSON.stringify(input)
  return {
    specificationVersion: 'v3',
    provider: FORCED_SEARCH_PROVIDER,
    modelId: 'forced-first-search',
    // This model never reads its prompt, so claim every URL as supported:
    // otherwise the SDK would download unsupported file URLs for a step that
    // ignores them.
    supportedUrls: { '*/*': [/^/] },
    async doGenerate(_options: LanguageModelV3CallOptions) {
      return {
        content: [
          { type: 'tool-call', toolCallId, toolName, input: serializedInput }
        ],
        finishReason: TOOL_CALLS_FINISH,
        usage: ZERO_USAGE,
        warnings: []
      }
    },
    async doStream(_options: LanguageModelV3CallOptions) {
      const parts: LanguageModelV3StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId, toolName, input: serializedInput },
        { type: 'finish', finishReason: TOOL_CALLS_FINISH, usage: ZERO_USAGE }
      ]
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          }
        })
      }
    }
  }
}

/**
 * Appended to the system prompt when step 0 was a forced search. The mode
 * prompts were written for a model that decides whether to search, including
 * an exception telling it NOT to search follow-ups about its own prior answer;
 * this tells the answering model the search already happened and supersedes
 * that exception (later instructions win). The query is deliberately not
 * interpolated — it is user-derived text and the scope block already carries
 * it.
 */
export const FORCED_SEARCH_PROMPT_ADDENDUM = `

## A first web search has already been run for this turn
The \`search\` call at the start of this turn was run for you on the resolved query. Its results are real sources retrieved THIS turn: read them, ground your answer in them, and cite what you use as [n](#toolCallId) with that call's toolCallId. This holds for every message that reaches you this turn, including a follow-up about your own earlier answer — the "clarifying your own prior answer" exception above does not apply. Search again or fetch a page only if those results leave a specific gap you can name; if they turn out irrelevant, answer from what you know and do not cite them.`
