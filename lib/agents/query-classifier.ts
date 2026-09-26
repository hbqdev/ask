import { generateText, tool, UIMessage } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { z } from 'zod'

import { durableLatencySink } from '../telemetry/latency-store'
import { SEARCH_INTENTS } from '../tools/search/intent'
import { createTimeoutFetch } from '../utils/fetch-with-timeout'
import { getTextFromParts } from '../utils/message-utils'

import { isAlwaysSearchEnabled } from './always-search'
import { buildClassifierTelemetry } from './query-classifier-telemetry'

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
// now that the classifier host is GPU-accelerating it (was CPU-only
// due to a stale GPU driver, since fixed) — warm latency on
// GPU is back down in the sub-second range that made 3b viable on CPU.
const CLASSIFIER_MODEL_ID = process.env.CLASSIFIER_MODEL_ID ?? 'granite4.2:8b'

// Short — this is a small structured-output call, not a research turn. If
// it doesn't come back quickly, fall back rather than delay the real
// response (see classifyQuery's catch block). This is the OUTER hard bound on
// the HTTP call; the soft budget below caps the turn's wait well before it.
const CLASSIFIER_TIMEOUT_MS = 10_000

// Soft budget, tighter than the hard timeout above. The fused classify+expand
// call sits on the turn's critical path — search waits on skipSearch +
// standaloneQuery — and its tail is heavy: prod shows ~4.6s median with ~18% of
// turns riding the full 10s hard timeout. This caps that tail. If the call has
// not resolved within the budget, abort the in-flight request (freeing the
// shared classifier host) and proceed on the graceful always-search fallback,
// exactly as a real timeout would — just sooner. Set CLASSIFIER_BUDGET_MS <= 0
// (or >= CLASSIFIER_TIMEOUT_MS) to effectively disable the soft cap and rely on
// the hard timeout alone.
const CLASSIFIER_BUDGET_MS = (() => {
  const n = Number(process.env.CLASSIFIER_BUDGET_MS)
  return Number.isFinite(n) && n > 0 ? n : 4000
})()

// How many trailing messages (both user and assistant) to show the
// classifier. Wide enough that a follow-up referring to an EARLIER turn
// ("actually, back to my first question…") can still be recognized as
// answerable-from-context (skipSearch=true) rather than triggering a
// needless search — 20 messages ≈ ten prior Q&A pairs.
//
// This does NOT cost extra VRAM: the classifier host loads the model at 16384 context
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
// the classifier host runs the model at OLLAMA_CONTEXT_LENGTH=16384, so the
// budget is generous: the worst case (HISTORY_WINDOW messages all at this
// cap) + the system prompt is ~13k tokens, staying inside 16k with ~3k to
// spare. 2,500 chars keeps most of a real Q&A turn intact — enough for the
// classifier to see what a prior answer actually said (so "remind me about
// my first question" is recognized as answerable-from-context), not just a
// truncated stub. Prior messages are clipped; the latest message (the
// thing being classified) never is.
const MAX_HISTORY_CHARS_PER_MESSAGE = 2500

export const classifierSchema = z.object({
  skipSearch: z.boolean(),
  standaloneQuery: z.string(),
  needsRecent: z.boolean(),
  needsSources: z.boolean(),
  intent: z.enum(SEARCH_INTENTS),
  // Fused query expansion. Previously a SECOND serial call to this same
  // model on this same host (6.6-12.3s), which could not start until this
  // one resolved because it needed standaloneQuery. Emitting them here
  // removes that round trip entirely. Empty is valid — the caller falls
  // back to the standalone expander rather than narrowing the search.
  expandedQueries: z
    .array(z.string())
    .max(3)
    .describe(
      'Up to 3 ALTERNATIVE phrasings of standaloneQuery for parallel web search, each approaching the question differently. Empty array when skipSearch is true.'
    )
})

export interface QueryClassification {
  skipSearch: boolean
  standaloneQuery: string
  /**
   * Alternative phrasings for parallel search, produced by the SAME call
   * that classifies. See classifierSchema. May be empty — the caller then
   * falls back to the standalone expander.
   */
  expandedQueries?: string[]
  // True when the answer depends on current/recent information (news,
  // prices, versions, releases, schedules, "latest X"). Plumbs through to
  // SearXNG's time_range so this turn's searches prefer fresh pages.
  needsRecent: boolean
  /**
   * True when the answer turns on specifics a well-read expert could not
   * state reliably from memory — a version, price, date, statistic, or a
   * claim about a specific named product, paper or event.
   *
   * DELIBERATELY CONSERVATIVE. Measured on 46 blind pairwise judgements
   * comparing this instance against one that gates on this flag: on the 18
   * turns where THIS instance searched and the gated one did not, the gated
   * one won 13-2. Searching a stable-knowledge question does not merely cost
   * latency — it produces a worse answer, padded with citations to
   * introductory pages. On turns where both searched, the gated instance lost
   * 4-8, so this flag is the part of that experiment worth having and the
   * rest is not.
   *
   * `needsRecent` is about FRESHNESS; this is about whether sources would
   * IMPROVE the answer at all. They are independent: "what is TCP" is neither,
   * "current PostgreSQL version" is both.
   *
   * With ALWAYS_SEARCH on (the default, lib/agents/always-search.ts) this
   * gates NOTHING — decision D3 was reversed on 2026-09-26 and every question
   * searches. It is still produced and logged on the [latency] line; only
   * ALWAYS_SEARCH=off restores the gate described above.
   */
  needsSources: boolean
  // The kind of sources most useful for this turn. Maps to ONE additive
  // SearXNG category (intentToCategory) on top of the always-on general
  // baseline — never replaces it. 'general' adds nothing. A wrong guess is
  // harmless because the baseline always fires.
  intent: import('../tools/search/intent').SearchIntent
}

// LEGACY prompt — used only with ALWAYS_SEARCH=off, kept verbatim so that
// flag restores the previous behaviour exactly (with the D3 stable-knowledge
// gate in researcher.ts resolveTurnMode).
//
// Matches Anthropic's/OpenAI's own tool-calling guidance (let one model
// decide inline) for the common case, but adds the one narrow, structural
// carve-out that prose instructions inside the main research prompt kept
// failing to hold onto reliably: pure clarifications about the assistant's
// OWN prior answer. Validated live at temperature 0 — see conversation
// history for the test transcript this prompt is tuned against (new-entity
// follow-ups, pure confirmations, and casual chit-chat).
export const LEGACY_CLASSIFIER_SYSTEM_PROMPT = `You decide whether a NEW web search is needed to answer the latest user message, given the conversation so far.

Rule: if the latest message names a different subject/entity than what was already discussed, or asks for any fact not yet stated above, that is ALWAYS skipSearch=false - no exceptions, even if the question is short or looks like a follow-up — except a request only to generate, draw, or edit an image (covered by the skip-search rule below).

Rule: skipSearch=true ONLY when the latest message is casual small talk (greeting/thanks), OR purely asks to confirm/restate/compare something the assistant ALREADY explicitly stated above (with the new message introducing zero new subject), OR only asks to generate, draw, or edit an image (the assistant has an image tool; no web search is needed unless the request also asks for information).

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

You also set needsSources: true ONLY when the answer depends on specifics a well-read expert could NOT state reliably from memory — a version number, price, date, statistic, release note, schedule, or a claim about a specific named product, company, person, paper or event that a careful reader would want a citation for. Set it false for knowledge that is stable and widely taught: definitions, concepts, how something works, established science and history, general programming or engineering knowledge, mathematics, opinions and preferences, writing and rewriting tasks, and anything about this conversation or about text the user supplied. When skipSearch=true, needsSources is always false — the conversation itself answers it.

needsSources is about whether SOURCES WOULD IMPROVE THE ANSWER; needsRecent is about FRESHNESS (do the facts change over time). Sources are not free: a well-known topic answered from stable knowledge reads better than the same answer padded with citations to introductory web pages. So "what is TCP", "what does SOLID stand for" and "explain closures in JavaScript" are needsSources=false — a competent answer needs no page to point at. But "what is the current stable PostgreSQL version", "how much does a Framework Laptop 16 cost" and "does creatine improve recovery, any studies" are needsSources=true: each turns on a specific figure, price or body of evidence.

If uncertain about needsSources, default to needsSources=false — an answer from stable knowledge is better than one padded with sources it did not need.

Examples:
1) Assistant said "Mount Fuji is the tallest mountain in Japan." User: "what about South Korea" -> South Korea is a NEW entity never mentioned -> skipSearch=false, needsRecent=false (geography is stable), needsSources=true (a specific named peak and height, not something to recall loosely), intent="general", standaloneQuery="What is the tallest mountain in South Korea?"
2) Assistant said "Option 1: X. Option 2: Y. Best practice: do both." User: "so you are saying to do both, right?" -> no new entity, already answered -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="Confirm: should I do both X and Y?"
3) User: "hey how is it going" -> casual -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="greeting, no search needed"
4) Assistant said "The capital of France is Paris." User: "and Germany?" -> Germany is a NEW entity, so a search is allowed, but the fact itself is widely taught -> skipSearch=false, needsRecent=false, needsSources=false, intent="general", standaloneQuery="What is the capital of Germany?"
5) User: "what's the latest stable version of Node.js" -> version info changes constantly and this is a software question -> skipSearch=false, needsRecent=true, needsSources=true, intent="code", standaloneQuery="What is the latest stable version of Node.js?"
6) User: "did anything major happen in AI this week" -> current events -> skipSearch=false, needsRecent=true, needsSources=true, intent="news", standaloneQuery="Major AI news this week"
7) User: "what mechanical keyboard do people actually recommend" -> opinions/community consensus -> skipSearch=false, needsRecent=false, needsSources=true (which specific models people currently recommend is not stable knowledge), intent="discussion", standaloneQuery="Recommended mechanical keyboards according to users"
8) User: "does creatine actually improve muscle recovery, any studies" -> scientific evidence -> skipSearch=false, needsRecent=false, needsSources=true (research evidence), intent="academic", standaloneQuery="Does creatine improve muscle recovery (research evidence)?"
9) User: "draw me a picture of the Sydney Opera House" -> pure image-generation request; names a new entity but the assistant's image tool handles it, no web search -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="Generate an image of the Sydney Opera House"
10) User: "what is 17% of 4500" -> pure arithmetic, no external fact involved -> skipSearch=false, needsRecent=false, needsSources=false, intent="general", standaloneQuery="What is 17% of 4500?"
11) User: "what is the difference between TCP and UDP" -> a stable, widely taught concept; a competent answer needs no page to point at -> skipSearch=false, needsRecent=false, needsSources=false, intent="code", standaloneQuery="What is the difference between TCP and UDP?"
12) User: "what does SOLID stand for in software design" -> established terminology -> skipSearch=false, needsRecent=false, needsSources=false, intent="code", standaloneQuery="What does SOLID stand for in software design?"
13) User: "how much does a Framework Laptop 16 cost right now" -> a current price for a specific named product -> skipSearch=false, needsRecent=true, needsSources=true, intent="general", standaloneQuery="Current price of the Framework Laptop 16"

standaloneQuery is always a short plain string, never empty, never a meta-question back to the user.`

// ALWAYS_SEARCH prompt (the default). The owner's 2026-09-26 decision: any
// question must search; only a NON-question may skip. So skipSearch is
// redefined to exactly five kinds of non-question, and everything else —
// settled concepts, follow-ups that confirm/choose/apply the previous answer,
// questions the conversation seems to answer already — is a question and
// searches. needsSources no longer gates anything (it is logged only), so its
// guidance no longer steers the model away from sources.
//
// Evidence behind the change: over 60 prod days, 69 of 164 turns used no
// tools — 20 skipSearch turns and 47 routed to stable-knowledge — and many
// were named products, company policies, home repair/cleaning, health/safety
// and current fiction answered confidently from memory.
//
// The examples deliberately avoid the lab verification turns (TCP vs UDP, a
// game-server follow-up, melted plastic, "Thanks, that's helpful!", "remember
// that I prefer metric units", "remember that I'm vegetarian", "forget my
// address") so a check measures generalisation rather than a memorised example.
//
// The memory-instruction skip keeps "remember that …" a DIRECT turn: the
// `remember` tool writes a confirmed memory only off a retrieval turn
// (researcher.ts, createRememberTool's retrievalTurn), so a research turn
// would save it as an unconfirmed candidate — and run a meaningless forced
// search on "remember that …" first. The legacy prompt, and this one before
// the rule existed, already skipped these on the live classifier model, but
// only because the model read past the list; the rule makes it explicit.
export const CLASSIFIER_SYSTEM_PROMPT = `You classify the latest user message, given the conversation so far. Every message that asks for information gets a web search. Your main job is to recognise the few messages that are NOT requests for information.

skipSearch — set true ONLY when the latest message is one of these non-questions:
- Social talk that asks for nothing: a greeting, thanks, an acknowledgement, chit-chat, or venting / a rhetorical remark ("hello", "ok cool, got it", "ugh, the power company again, am I right?").
- A pure transform of text that is already present — text the user supplied, or the assistant's previous answer: rewrite, rephrase, shorten, translate, summarise, reformat, or turn it into a list/table/email ("rewrite that shorter", "summarise the plan you gave me as a numbered list", "translate this into Spanish: ..."). It must ask for NO new information. Asking for a recommendation, decision, verdict or reasoning is NOT a transform, even when phrased as "give me your final recommendation and the reasoning in short" — that asks for a judgement, so it is a question.
- Pure arithmetic or a unit conversion on numbers given in the message ("what is 17% of 4500", "convert 12 miles to km").
- A request only to generate, draw or edit an image ("draw me a picture of the Sydney Opera House").
- An explicit instruction about what to remember or forget about the user that asks nothing else ("remember that my daughter is allergic to peanuts", "please forget where I work", "don't remember that", "update my city to Lisbon"). It is saved to memory, not looked up.

Everything else is skipSearch=false, including:
- Any question at all, however simple, settled or widely known ("explain closures in JavaScript", "what is the capital of Germany").
- A follow-up question about the previous answer, including one that asks you to choose, recommend, confirm, clarify, or apply it to the user's situation ("so which of those would you pick for my case?", "so you mean rotating my hips, not my knees?", "so you're saying to do both, right?"). A question that re-asks or confirms something already said is still a question.
- A question the conversation already appears to answer.
- A transform request that ALSO asks for anything new ("summarise that and add current prices").
- Any request for advice, instructions, how-to, safety, health, cleaning or repair steps, product, company or policy information, opinions or recommendations.
- A message that mixes social talk with a question ("thanks! does it also work on wool?").
- A memory instruction that also asks a question ("remember I use a Mac — how do I take a screenshot?").

If uncertain, skipSearch=false.

You also set needsRecent: true when a correct answer depends on current or recent information — news, current events, prices, exchange rates, product/software versions or releases, schedules, weather, "latest/newest/current X", anything that changes month to month. false for stable facts (history, geography, definitions, science, how-things-work) and for skipSearch=true turns.

If uncertain about needsRecent, default to needsRecent=false.

You also set intent — the kind of sources most useful for answering:
- "code": programming, libraries, APIs, error messages, package/tooling questions, software how-to, technical documentation.
- "discussion": opinions, recommendations, personal experiences, "what do people think about X", community consensus.
- "news": current events, breaking news, recent happenings, "what happened with X".
- "academic": research papers, scientific or medical evidence, scholarly citations, studies.
- "general": everything else, or whenever you are not clearly in one of the above.

Only leave "general" when the intent is clearly one of the others. If uncertain, use "general".

You also set needsSources. It is recorded for analysis only and does NOT decide whether a search runs. true when the answer turns on specifics a careful reader would want a citation for — a version, price, date, statistic, schedule, a claim about a specific named product, company, person, paper or event — or on advice where a mistake could cause harm (health, safety, legal, money, home repair or cleaning chemicals). false for well-known concepts and for skipSearch=true turns. If uncertain, true.

standaloneQuery is the latest message rewritten so it makes complete sense with no conversation history: resolve pronouns and references ("that", "which one", "it", "my case") against the conversation. For skipSearch=false it is used as the web search query for this turn, so it must name the actual subject. Always a short plain string, never empty, never a meta-question back to the user.

Examples:
1) Assistant said "Mount Fuji is the tallest mountain in Japan." User: "what about South Korea" -> a question -> skipSearch=false, needsRecent=false, needsSources=true, intent="general", standaloneQuery="What is the tallest mountain in South Korea?"
2) Assistant compared PostgreSQL and MySQL for a small web app. User: "so which one would you pick for my case?" -> a follow-up question asking for a recommendation -> skipSearch=false, needsRecent=false, needsSources=true, intent="code", standaloneQuery="PostgreSQL or MySQL for a small web app: which to choose?"
3) Assistant said "Option 1: X. Option 2: Y. Best practice: do both." User: "so you are saying to do both, right?" -> confirming the previous answer is still a question -> skipSearch=false, needsRecent=false, needsSources=true, intent="general", standaloneQuery="Should I do both X and Y?"
4) User: "hey how is it going" -> greeting -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="Greeting, no search needed"
5) Assistant gave a detailed answer. User: "ok cool, thanks" -> acknowledgement, asks for nothing -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="Thanks, no search needed"
6) Assistant recommended a home-network setup. User: "summarise the setup you recommended as a numbered list" -> pure transform of the previous answer -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="Summarise the recommended home-network setup as a numbered list"
7) User: "what is 17% of 4500" -> pure arithmetic -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="What is 17% of 4500?"
8) User: "draw me a picture of the Sydney Opera House" -> image request only -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="Generate an image of the Sydney Opera House"
9) User: "explain closures in JavaScript" -> a question, even though the topic is settled -> skipSearch=false, needsRecent=false, needsSources=false, intent="code", standaloneQuery="How do closures work in JavaScript?"
10) User: "I spilled bleach on my carpet, how do I fix it?" -> a how-to question with a safety angle -> skipSearch=false, needsRecent=false, needsSources=true, intent="general", standaloneQuery="How to fix a bleach stain on carpet safely"
11) User: "what's the latest stable version of Node.js" -> version info changes constantly -> skipSearch=false, needsRecent=true, needsSources=true, intent="code", standaloneQuery="What is the latest stable version of Node.js?"
12) User: "did anything major happen in AI this week" -> current events -> skipSearch=false, needsRecent=true, needsSources=true, intent="news", standaloneQuery="Major AI news this week"
13) User: "what mechanical keyboard do people actually recommend" -> opinions/community consensus -> skipSearch=false, needsRecent=false, needsSources=true, intent="discussion", standaloneQuery="Recommended mechanical keyboards according to users"
14) User: "does creatine actually improve muscle recovery, any studies" -> scientific evidence -> skipSearch=false, needsRecent=false, needsSources=true, intent="academic", standaloneQuery="Does creatine improve muscle recovery (research evidence)?"
15) Assistant explained how to remove a wine stain from cotton. User: "thanks! does it also work on wool?" -> thanks plus a new question -> skipSearch=false, needsRecent=false, needsSources=true, intent="general", standaloneQuery="Does the wine stain removal method work on wool?"
16) Assistant compared two ways to back up a home server. User: "give me your final recommendation and the reasoning in short" -> asks for a decision, not a restatement -> skipSearch=false, needsRecent=false, needsSources=true, intent="general", standaloneQuery="Best way to back up a home server: recommendation and reasoning"
17) User: "remember that my daughter is allergic to peanuts" -> an instruction to remember a fact about the user, asks nothing -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="Remember that the user's daughter is allergic to peanuts"
18) User: "please forget where I work" -> an instruction to forget, asks nothing -> skipSearch=true, needsRecent=false, needsSources=false, intent="general", standaloneQuery="Forget the user's workplace"
19) User: "remember I use a Mac — how do I take a screenshot?" -> a memory instruction plus a question -> skipSearch=false, needsRecent=false, needsSources=true, intent="general", standaloneQuery="How to take a screenshot on a Mac"`

/**
 * The classifier system prompt for this turn: the ALWAYS_SEARCH prompt by
 * default, the legacy prompt when ALWAYS_SEARCH=off.
 */
export function getClassifierSystemPrompt(
  alwaysSearch: boolean = isAlwaysSearchEnabled()
): string {
  return alwaysSearch
    ? CLASSIFIER_SYSTEM_PROMPT
    : LEGACY_CLASSIFIER_SYSTEM_PROMPT
}

// Prior-turn text is clipped, never the latest message: the latest message
// is the thing being classified and must survive intact.
function clipHistoryText(text: string): string {
  return text.length > MAX_HISTORY_CHARS_PER_MESSAGE
    ? text.slice(0, MAX_HISTORY_CHARS_PER_MESSAGE) + '…[truncated]'
    : text
}

export function buildConversationTranscript(messages: UIMessage[]): {
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

/** Telemetry must never break a turn. */
function emitClassifierTelemetry(
  t: Parameters<typeof buildClassifierTelemetry>[0]
): void {
  try {
    // Durable, not console.log, for the same reason the per-turn [latency]
    // line is: Docker's json-file driver is per-container, so every rebuild
    // destroyed this history. That is why the classifier's own outcome field
    // ('ok' | 'empty' | 'failed') existed for weeks and still could not answer
    // "how often does the classifier fall back?" — the evidence was deleted on
    // each deploy. The sink logs first and pushes asynchronously with its own
    // catch, so this cannot fail a turn.
    durableLatencySink(buildClassifierTelemetry(t))
  } catch {
    // ignored
  }
}

export async function classifyQuery({
  messages,
  abortSignal
}: {
  messages: UIMessage[]
  abortSignal?: AbortSignal
}): Promise<QueryClassification> {
  const startedAt = performance.now()
  const { history, latestMessage } = buildConversationTranscript(messages)

  // Fallback matches today's existing behavior exactly: always search,
  // using the raw latest message as-is. A classifier failure can never
  // make search-scoping worse than it already was before this feature.
  const fallback: QueryClassification = {
    skipSearch: false,
    standaloneQuery: latestMessage,
    needsRecent: false,
    // TRUE here, even though the rule above defaults it FALSE, and the
    // difference is deliberate: the rule applies when we know what was asked,
    // this applies when we do not. For an unknown question correctness
    // outranks style — an ungrounded answer about a version or a price is
    // wrong, whereas a needlessly sourced answer about a concept is merely
    // worse written. A classifier failure must never silently stop the turn
    // from searching.
    needsSources: true,
    intent: 'general',
    // No expansions from a failed call; the caller's fallback expander runs.
    expandedQueries: []
  }

  // Runs on a dedicated GPU-backed Ollama host instead of
  // OLLAMA_BASE_URL so this classification never competes with the main
  // app's Ollama traffic/model loads. Falls back to OLLAMA_BASE_URL if
  // unset so local dev without a second host still works. Read fresh on
  // every call (not hoisted to module scope) so env changes take effect
  // without a process restart, matching the original behavior.
  const classifierBaseUrl =
    process.env.CLASSIFIER_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL

  if (!classifierBaseUrl) {
    emitClassifierTelemetry({
      totalMs: performance.now() - startedAt,
      modelMs: 0,
      model: CLASSIFIER_MODEL_ID,
      outcome: 'unconfigured'
    })
    return fallback
  }

  try {
    // Soft-budget the fused call: budgetController aborts the in-flight HTTP
    // request when CLASSIFIER_BUDGET_MS elapses, so a slow tail frees the shared
    // classifier host instead of running to the 10s hard timeout. Combined with
    // the caller's abortSignal so a client disconnect still cuts it short too.
    const budgetController = new AbortController()
    const combinedSignal = abortSignal
      ? AbortSignal.any([abortSignal, budgetController.signal])
      : budgetController.signal

    // createTimeoutFetch enforces CLASSIFIER_TIMEOUT_MS on the actual HTTP
    // call regardless of whether ai-sdk-ollama forwards the AI SDK's own
    // abortSignal (it doesn't — see the same fix in registry.ts), and also
    // merges in the combined signal (caller disconnect + soft budget) so either
    // cuts this short.
    const provider = createOllama({
      baseURL: classifierBaseUrl,
      fetch: createTimeoutFetch(CLASSIFIER_TIMEOUT_MS, combinedSignal)
    })

    // Tool calling, NOT Output.object. Ollama's `format: <json schema>`
    // constrains decoding only for LOCAL models — it is silently ignored by
    // cloud models, which return prose and a `thinking` field instead. A
    // schema-based classifier therefore fails closed on every turn the moment
    // CLASSIFIER_MODEL_ID points at a :cloud model. Tool calling is honoured
    // by both: verified against granite4.1:8b locally and glm-5.2,
    // deepseek-v4-flash, minimax-m3, kimi-k2.6, kimi-k2.7-code and
    // nemotron-3-ultra in the cloud.
    const modelStart = performance.now()
    let modelMs = 0
    let usage: { inputTokens?: number; outputTokens?: number } | undefined
    let classification: z.infer<typeof classifierSchema> | undefined
    let budgetExceeded = false
    let budgetTimer: ReturnType<typeof setTimeout> | undefined

    try {
      // Race the fused call against the soft budget. The gen arm maps BOTH
      // outcomes to a value so it never rejects — that way, when the budget arm
      // wins, the still-pending generateText cannot surface as an unhandled
      // rejection once it aborts.
      const genArm = generateText({
        // keep_alive: -1 keeps a LOCAL model resident in Ollama's memory —
        // otherwise the default 5-minute idle timeout unloads it and the next
        // classification pays a cold-load penalty. Harmless for cloud models.
        model: provider(CLASSIFIER_MODEL_ID, { think: false, keep_alive: -1 }),
        // THE CLASSIFIER HAS TO KNOW WHAT YEAR IT IS. It writes the search
        // queries this turn will run — standaloneQuery and expandedQueries —
        // and without a date it dates them from its training data. Observed
        // directly on lab, asked "what is happening with AI regulation right
        // now" in July 2026: "latest AI regulation developments in the United
        // States 2025", "EU AI Act implementation updates 2025", "recent AI
        // regulation developments in other countries 2025". Three queries, all
        // pinned to last year.
        //
        // Worse than merely unhelpful: it fights needsRecent, which narrows
        // SearXNG's time_range to the past month. The freshness window asks for
        // this month while the query text asks for last year.
        //
        // The answering model has had this all along (researcher.ts appends
        // "Current date and time"). Only the classifier was blind, and it is
        // the one writing the queries.
        system: `${getClassifierSystemPrompt()}\n\nCurrent date and time: ${new Date().toLocaleString()}`,
        prompt: `Conversation so far:\n${history}\n\nLatest message: ${latestMessage}`,
        temperature: 0,
        abortSignal: combinedSignal,
        tools: {
          classify: tool({
            description:
              "Report the classification of the user's latest message. Always call this tool exactly once.",
            inputSchema: classifierSchema
          })
        },
        // NOT enforcement — a hint at best. ai-sdk-ollama never forwards
        // toolChoice: getCallOptions destructures prompt/temperature/
        // maxOutputTokens/topP/topK/penalties/stopSequences/seed/responseFormat/
        // tools and nothing else, pushes no warning, and the only two
        // toolChoice references in the whole bundle sit in an unrelated
        // generateText helper — one of which explicitly filters it OUT of what
        // is forwarded. Kept because it costs nothing and is correct for any
        // provider that does honour it.
        //
        // So this call depends on the model VOLUNTEERING `classify`. When it
        // does not, toolCalls[0] is undefined, ok=false, and the fallback below
        // makes the turn always-search. That path is no longer silent: it emits
        // outcome:'empty' to the durable sink, so the rate is measurable rather
        // than assumed.
        toolChoice: 'required'
      }).then(
        result => ({ kind: 'ok' as const, result }),
        error => ({ kind: 'err' as const, error })
      )

      const budgetArm = new Promise<{ kind: 'budget' }>(resolve => {
        budgetTimer = setTimeout(() => {
          // Cut the wasted in-flight call loose from the shared host.
          budgetController.abort(
            new DOMException('classifier soft budget exceeded', 'TimeoutError')
          )
          resolve({ kind: 'budget' })
        }, CLASSIFIER_BUDGET_MS)
      })

      const raced = await Promise.race([genArm, budgetArm])
      modelMs = performance.now() - modelStart

      if (raced.kind === 'budget') {
        budgetExceeded = true
      } else if (raced.kind === 'err') {
        // A genuine failure within budget — route to the outer catch so it
        // reports outcome:'failed' exactly as before.
        throw raced.error
      } else {
        usage = raced.result.usage
        const call = raced.result.toolCalls?.[0]
        if (call && call.toolName === 'classify') {
          classification = call.input as z.infer<typeof classifierSchema>
        }
      }
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer)
      if (modelMs === 0) modelMs = performance.now() - modelStart
    }

    // Budget expired before the model answered: fall back to always-search,
    // same graceful path as a real timeout, and record it under a distinct
    // outcome so the soft cap's firing rate is measurable rather than assumed.
    if (budgetExceeded) {
      emitClassifierTelemetry({
        totalMs: performance.now() - startedAt,
        modelMs,
        model: CLASSIFIER_MODEL_ID,
        outcome: 'budget'
      })
      return fallback
    }

    const ok = Boolean(classification?.standaloneQuery.trim())
    emitClassifierTelemetry({
      totalMs: performance.now() - startedAt,
      modelMs,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      model: CLASSIFIER_MODEL_ID,
      outcome: ok ? 'ok' : 'empty'
    })

    if (!ok || !classification) {
      return fallback
    }

    return classification
  } catch (error) {
    emitClassifierTelemetry({
      totalMs: performance.now() - startedAt,
      modelMs: 0,
      model: CLASSIFIER_MODEL_ID,
      outcome: 'failed'
    })
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        'Query classifier failed, defaulting to always-search:',
        error
      )
    }
    return fallback
  }
}
