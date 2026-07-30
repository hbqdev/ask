// PIPELINE ARCHITECTURE — retrieval is a system stage, not a model decision.
//
// This is not a variant of the agentic loop; it replaces the loop's control
// structure. The loop asks the model, at every step, "do I have enough or
// should I search again?" That question is why behaviour is not portable
// across models: on an identical probe set kimi-k2.6 answered it 19 times and
// minimax-m3 answered it 3 times. An architecture whose shape depends on which
// model is selected is not an architecture.
//
// So the model is never asked. The system retrieves, once, on a schedule it
// controls; the model gets one call at the end to write the answer with no
// tools available. Two properties follow, and both are the point:
//
//   * MODEL-AGNOSTIC. Step count is fixed by code. Swapping the model in the
//     UI changes prose quality and speed, never the flow.
//   * BOUNDED. One model round trip instead of 3-11. Measured on this stack a
//     round trip is ~10s and turn latency tracks prompt_tokens at r=0.76, so
//     removing round trips is the single largest lever available.
//
// RETRIEVAL WAITS TO BE UNDERSTOOD — BUT NOT FOR LONG.
//
// This started out as a SPECULATIVE start: retrieval fired at t=0 on the user's
// RAW text, before the classifier returned, on the reasoning that the preamble
// it skipped was expensive (classify ~1.2s, recall ~5.0s, first token ~7.7s).
//
// A 32-pair A/B against the loop showed that trade was WRONG, and why. Firing
// before the classifier means the retrieval cannot know `timeRange` or `intent`
// and must use raw text instead of the classifier's rewrite — the call site
// literally had nothing else to pass. The loop's search tool gets
// `timeRange: needsRecent ? 'month' : undefined`. So the pipeline was
// structurally unable to filter for freshness, and a blind pairwise judge
// scored it 3W-19L-9T overall and 1W-12L-4T on the current-facts probes
// specifically. Asked for EV sales "this year", it answered with full-year 2025
// figures and cited them faithfully; the loop answered with H1 2026.
//
// The assumption behind the trade also failed on measurement: classify_ms came
// in at 1.4-2.2s (worst 4.8s) across that run, against a retrieval stage of
// 20-40s. Paying ~2s to retrieve the RIGHT pages is obviously worth it.
//
// So retrieval now waits for the classifier, bounded by CLASSIFY_WAIT_MS, and
// falls back to the old raw-text behaviour if that deadline passes. A hung
// classifier delays understanding, never the turn. The bound is what keeps this
// from reintroducing the serial preamble the speculative start was invented to
// remove.
//
// One DEEP retrieval, widened rather than repeated. A second advanced pass
// would double load on the shared crawl4ai container — already the fleet's
// scarcest resource, and its saturation produces 125-second stalls. So breadth
// comes from the classifier's expandedQueries searched at BASIC depth alongside
// the main query and merged by URL, which is exactly what the loop's first
// search does (searchExpansionVariants) and what this architecture was missing:
// it retrieved on ONE phrasing while the loop retrieved on up to four.

import { generateId } from 'ai'

import { CLASSIFIER_TIMEOUT_MS } from '@/lib/agents/query-classifier'
import { searchExpansionVariants } from '@/lib/tools/search'
import {
  resolveOllamaSearchOptions,
  runAdvancedSearch
} from '@/lib/tools/search/advanced-search-client'
import { routeEmitsSearchTelemetry } from '@/lib/tools/search/basic-telemetry'
import type { SearchIntent } from '@/lib/tools/search/intent'
import {
  createSearchProvider,
  type SearchProviderType
} from '@/lib/tools/search/providers'
import type { SearchResults } from '@/lib/types'

/** How many results the single retrieval pass asks for. */
const PIPELINE_MAX_RESULTS = 20

/** Default per-source content budget in the prompt. */
export const DEFAULT_PIPELINE_SOURCE_CHARS = 1200

/**
 * How much of each source's text the model actually gets to read.
 *
 * THE SUSPECT THIS EXISTS TO TEST. The loop's search tool does not truncate at
 * all — the model sees full crawled pages. This architecture caps every source
 * at 1200 characters, so 20 sources is at most ~24k characters of evidence no
 * matter how substantial the pages were. That is INFORMATION LOSS relative to
 * the loop, and it is the leading unfalsified explanation for the strangest
 * result in the A/B: the pipeline losing a blind quality judge on turns where it
 * had MORE sources and MORE citations than the loop. Twenty shallow excerpts can
 * carry less usable evidence than ten full pages.
 *
 * Read from the environment, and NOT because configurability is a virtue here.
 * Turn latency tracks prompt_tokens at r=0.76, so this knob trades speed for
 * evidence and the exchange rate has to be measured rather than assumed. An env
 * var means an arm can be re-run by restarting the container instead of
 * rebuilding it, which is the difference between testing this today and
 * testing it eventually.
 *
 * Invalid or missing values fall back to the default rather than to "unbounded":
 * a typo must not silently hand the model a 500k-token prompt.
 */
export function pipelineSourceChars(): number {
  const raw = Number(process.env.PIPELINE_SOURCE_CHARS)
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEFAULT_PIPELINE_SOURCE_CHARS
}

/**
 * Is the pipeline architecture active? Separate from FLOW_VARIANT because the
 * variants are knobs INSIDE the loop, and this removes the loop. Keeping them
 * on different switches stops "pipeline" from being read as one more arm.
 */
export function pipelineArchEnabled(): boolean {
  return process.env.FLOW_ARCH === 'pipeline'
}

export type PipelineRetrieval = {
  query: string
  results: SearchResults | null
  ms: number
  error?: string
  /**
   * Identity of this retrieval, minted before it runs.
   *
   * It is not decoration: the whole downstream citation/sources stack is keyed
   * on a search tool call's id, and under this architecture there is no tool
   * call to take one from. The SAME id goes into the model's prompt (as the
   * anchor it must cite against) and into the synthesized `tool-search` UI part
   * (buildRetrievalToolPart), which is what makes `[1](#id)` resolve to a real
   * URL in lib/utils/citation.ts.
   */
  toolCallId: string
}

/**
 * Do this turn's retrieved sources reach the model's prompt?
 *
 * `skipSearch` covers turns answerable from the conversation itself. The other
 * two are separate signals on purpose:
 *
 *   * `needsRecent` is FRESHNESS — the answer depends on current facts.
 *   * `needsSources` is SPECIFICITY — the answer turns on a figure, version,
 *     price or named-entity claim an expert could not state reliably from
 *     memory.
 *
 * BOTH DIRECTIONS OF THIS GATE HAVE NOW BEEN WRONG, which is why the current
 * shape is stated carefully rather than confidently:
 *
 *   1. Freshness ALONE declined settled-knowledge turns, and the last-resort
 *      rule then handed those same turns the `search` tool — converting a saved
 *      source block into a whole extra model round trip. Fixed by keying the
 *      last resort on the retrieval RESULT rather than on this gate's verdict.
 *   2. Adding a liberal `needsSources` (default true, "would sources help?")
 *      overcorrected. On 32 pairs a blind pairwise judge scored the pipeline
 *      19-1 against the loop, with 11 of those losses on turns where it had MORE
 *      sources and MORE citations — and six where the loop had NONE and won
 *      anyway. Padding a stable-knowledge answer with citations to introductory
 *      pages makes it worse. `needsSources` is now deliberately conservative and
 *      defaults FALSE (see query-classifier.ts).
 *
 * The lesson both times: sources are not free, and "we already paid for the
 * search" is an argument about cost, not about answer quality.
 *
 * Exported as a predicate — rather than left inline at the one place that
 * gates — because the telemetry has to report the SAME decision the researcher
 * made. It previously reported the retrieval's own result count regardless of
 * this gate, which made a discarded turn indistinguishable from an injected
 * one and produced a "the gate never fired" reading of a run where it fired on
 * 9 of 16 probes.
 */
export function shouldInjectRetrieval({
  skipSearch,
  needsRecent,
  needsSources
}: {
  skipSearch: boolean
  needsRecent: boolean
  needsSources: boolean
}): boolean {
  return !skipSearch && (needsRecent || needsSources)
}

/**
 * Every tool name this architecture is allowed to hand out.
 *
 * A closed list, not `keyof ResearcherTools`, because the omissions are the
 * design:
 *   * `todoWrite` is how a turn re-opens the multi-step planning loop this
 *     architecture exists to remove. Under the pipeline, planning is the
 *     system's job — a plan the model writes is a plan it then wants steps to
 *     execute.
 *   * `askQuestion` ends the turn with a question instead of an answer, which
 *     is a second round trip wearing a different name.
 *   * `recall` is left out because it is already covered without a step: the
 *     streaming layer resolves it into `recallBlock` and getMemoryInjection
 *     resolves memories into the prompt BEFORE the model is called.
 *     Provisioning it would only buy the model a way to spend its answer step
 *     re-fetching what it was already handed. `remember` IS listed, because
 *     the symmetry is false — extraction runs after the turn, but a user who
 *     says "remember I'm on Postgres 18" expects the assistant to act and
 *     confirm, and without the tool that silently falls to a background
 *     extractor with no acknowledgement either way.
 *
 * researcher.ts assigns the provisioned array to `(keyof ResearcherTools)[]`,
 * which is where a typo or a renamed tool is caught at compile time.
 */
export type PipelineToolName =
  | 'search'
  | 'fetch'
  | 'calculate'
  | 'get_weather'
  | 'generateImage'
  | 'remember'

export type TurnProvisioning = {
  /** Exactly what the model may call this turn. */
  tools: PipelineToolName[]
  /** Ceiling on steps, derived from `tools` and never stated independently. */
  maxSteps: number
  /** One line for the audit log: which signals produced this set. */
  reason: string
}

// CAPABILITY CUES ARE READ FROM THE MESSAGE TEXT, not from the classifier.
//
// SEARCH_INTENTS (lib/tools/search/intent.ts) is a SOURCE taxonomy — it picks
// which SearXNG category to add on top of the baseline. general / code /
// discussion / news / academic all describe where to look, and none of them
// implies a capability: a "code" question needs no tool the pipeline has not
// already run, and there is no arithmetic, weather or image intent to map. So
// intent is recorded in the audit line and deliberately drives nothing.
//
// These patterns are tuned to prefer a false POSITIVE over a false negative.
// A spurious tool costs one extra permitted step that the model will almost
// certainly not spend; a missing one costs the turn its only way to answer.

const URL_IN_MESSAGE = /https?:\/\/\S+/i

// Verb-and-object, so "how does React render a component" and "draw a
// conclusion" do not read as image requests.
const IMAGE_SUBJECT =
  '(?:image|picture|photo|photograph|drawing|illustration|painting|artwork|logo|icon|poster|wallpaper|portrait|avatar|comic|sketch|render)'
const IMAGE_REQUEST = new RegExp(
  `\\b(?:draw|sketch|paint|illustrate|render|generate|create|make|design|produce|edit|restyle|upscale|imagine)\\b[^.?!]{0,40}\\b${IMAGE_SUBJECT}\\b` +
    `|\\b${IMAGE_SUBJECT}\\s+of\\b` +
    `|\\bdraw\\s+(?:me|a|an|the)\\b`,
  'i'
)

const WEATHER_REQUEST =
  /\b(?:weather|forecast|temperature|humidity|how (?:hot|cold|warm)|rain(?:ing|fall)?|snow(?:ing)?|wind speed|uv index)\b/i

// Explicit "remember this about me" requests.
//
// `recall` is deliberately NOT provisionable: getRecallInjection already runs
// in the streaming layer and its output reaches the model as `recallBlock`
// before the first token, so past-conversation context arrives without
// spending a step. `remember` is a different case — memory EXTRACTION runs
// automatically after the turn, but a user saying "remember I'm on Postgres
// 18" expects the model to act on it and confirm. Without the tool that
// request silently falls to a background extractor that may not catch it, and
// the user is told nothing. That is a capability loss, not saved waste.
const REMEMBER_REQUEST =
  /\b(remember|keep in mind|note|save|store|don'?t forget)\b[^.?!]{0,40}\b(that |this |i |i'?m |i'?ve |my |me\b)/i

// `+` and `-` require surrounding spaces so version strings, date ranges and
// "COVID-19" are not read as sums. `convert` requires a nearby digit so
// "convert this to TypeScript" is not read as a unit conversion.
const ARITHMETIC_REQUEST =
  /\d\s*[*\/^×÷]\s*\d|\d\s+[+-]\s+\d|\b\d+(?:\.\d+)?\s*(?:%|percent)\s+of\b|\b(?:calculate|compute|square root|sqrt|factorial|multiplied by|divided by|sum of|average of)\b|\bconvert\b[^.?!]{0,24}\d/i

/**
 * Decide what this turn may call, and how many steps that buys it.
 *
 * THE POINT OF THIS FUNCTION. Handing the model nine tools and a ceiling of 50
 * steps makes the shape of a turn a property of the MODEL: on an identical
 * probe set kimi-k2.6 made 19 tool calls and minimax-m3 made 3. Here the system
 * reads the turn and hands over exactly the capabilities it needs; the model
 * uses what it is given. Same flow on every model.
 *
 * Tools and cap are returned TOGETHER, from one place, because a cap that does
 * not match the provisioned set is the bug class worth designing out: a ceiling
 * of 50 with no tools wastes nothing but says nothing either, and a ceiling of
 * 1 with a tool provisioned means the tool result can never be turned into
 * prose. `maxSteps = tools.length + 1` — one step per capability, plus the step
 * that writes the answer. With no tools that is exactly ONE model call, which
 * is what most turns should be: retrieval already happened.
 *
 * `search` is normally ABSENT — retrieval ran before the model was called, and
 * re-searching is the are-we-done judgement this architecture removes. It comes
 * back only as a GENUINE last resort: this turn wanted sources, and retrieval
 * came back with none even after its own internal retry. Then and only then
 * does the model have neither grounding nor any way to obtain it.
 *
 * That condition used to be "wanted no sources and got none", which fired on
 * every settled-knowledge question — "what is TCP" was handed `search` and a
 * two-step loop. It was the single largest source of avoidable round trips in
 * the architecture, and it fired precisely on the turns the freshness gate had
 * just declined. Keying on the RETRIEVAL RESULT instead of on the gate's
 * verdict is what makes it rare, which is what a last resort should be.
 */
export function provisionTurnTools({
  message,
  intent,
  skipSearch,
  needsRecent,
  needsSources,
  imageGenAvailable,
  sourcesRetrieved
}: {
  /** The user's raw message this turn — the only place capability cues exist. */
  message: string
  /** Classifier's source taxonomy. Recorded, not acted on — see above. */
  intent: SearchIntent
  /** Classifier: answerable from the conversation itself. */
  skipSearch: boolean
  /** Classifier: the answer depends on current facts. */
  needsRecent: boolean
  /** Classifier: the answer draws on external facts, fresh or not. */
  needsSources: boolean
  /** generateImage is registered for this turn (configured AND signed in). */
  imageGenAvailable: boolean
  /**
   * How many sources the awaited retrieval actually returned, or `null` when
   * this turn declined sources and therefore never awaited it.
   *
   * The null case is NOT "zero": a turn that wanted no sources has no gap to
   * fill, and treating "didn't ask" as "asked and got nothing" is exactly the
   * conflation that made the escape hatch fire on every settled-knowledge
   * question.
   */
  sourcesRetrieved: number | null
}): TurnProvisioning {
  const text = message ?? ''
  const sourcesInjected = shouldInjectRetrieval({
    skipSearch,
    needsRecent,
    needsSources
  })
  const tools: PipelineToolName[] = []
  const why: string[] = []

  // Checked BEFORE anything keyed on skipSearch: the classifier is instructed
  // to set skipSearch=true for a pure "draw me X" request (it needs no web
  // search), so a skipSearch-implies-no-tools rule would strip the one tool
  // such a turn exists to use.
  if (imageGenAvailable && IMAGE_REQUEST.test(text)) {
    tools.push('generateImage')
    why.push('image request')
  }
  if (URL_IN_MESSAGE.test(text)) {
    tools.push('fetch')
    why.push('url in message')
  }
  if (REMEMBER_REQUEST.test(text)) {
    tools.push('remember')
    why.push('explicit memory request')
  }
  if (ARITHMETIC_REQUEST.test(text)) {
    tools.push('calculate')
    why.push('numeric computation')
  }
  if (WEATHER_REQUEST.test(text)) {
    tools.push('get_weather')
    why.push('weather question')
  }

  if (sourcesRetrieved === 0 && tools.length === 0) {
    tools.push('search')
    why.push('last resort: sources wanted, retrieval returned none')
  }

  return {
    tools,
    // `Math.max(2, ...)` and not `tools.length + 1`, because activeTools turns
    // out to be ADVERTISING rather than ENFORCEMENT.
    //
    // In the SDK, `activeTools` is consulted only by prepareToolsAndToolChoice,
    // which filters which tool DEFINITIONS reach the provider. Execution is
    // `tools[toolCall.toolName]` against the FULL tool map and never looks at
    // activeTools; NoSuchToolError fires only when the name is absent from the
    // map altogether. So a model can emit a call for a tool that was never
    // offered, and the SDK will happily run it.
    //
    // MEASURED. Probe p09, a sourced turn provisioned with NO tools: the
    // persisted message is step-start -> reasoning -> tool-search(basic) and no
    // text part at all. kimi-k2.6 called `search` unprompted, the SDK executed
    // it, and with a ceiling of 1 the loop stopped there — a zero-character
    // answer after 32s. Several comments in this file previously asserted that
    // activeTools "holds for every model, unlike a prompt"; that was wrong.
    //
    // A floor of 2 costs nothing in the normal case. maxSteps is a CEILING, not
    // a target: the loop ends the moment a step produces text with no tool
    // calls, so a well-behaved turn still finishes in one step. What the floor
    // buys is that a stray call can never consume the only step, because
    // applyAnswerStepReserve empties the last step's tools and attaches
    // FINAL_STEP_NOTE — so there is always a step whose only possible output is
    // prose.
    maxSteps: Math.max(2, tools.length + 1),
    reason:
      `intent=${intent} skipSearch=${skipSearch} needsRecent=${needsRecent} ` +
      `needsSources=${needsSources} ` +
      `sources=${sourcesInjected ? `injected(${sourcesRetrieved ?? '?'})` : 'declined'} — ` +
      (why.length ? why.join(' + ') : 'no capability needed')
  }
}

/**
 * Guarantee that the step budget can never be spent entirely on tool calls.
 *
 * MEASURED, not theorised. Across two probe runs every 0-character answer had
 * the same shape — `steps=2, tools=2` — and every answer with prose had at
 * most one tool call. With `maxSteps = tools.length + 1` a model that calls one
 * tool twice consumes the whole budget and the turn ends before a word is
 * written: the arithmetic probe called `calculate` twice and returned nothing.
 *
 * An earlier attempt at this was recorded in researcher.ts as having made
 * things WORSE (0-character answers 1 of 12 -> 4 of 13) and was reverted. That
 * conclusion was wrong: the guard never executed. researcher.ts wired
 * `prepareStep` only when the active FLOW_VARIANT defined one, the lab runs
 * `baseline`, and `baseline` defines none — so the spread evaluated to `{}` and
 * no per-step hook reached the SDK at all. The proof is in the failing run's
 * own numbers: those turns still show a tool call on their SECOND step, which
 * is impossible if `activeTools` had been emptied there. The 1-vs-4 difference
 * was run-to-run variance being read as an effect.
 *
 * `activeTools` is used rather than `toolChoice: 'none'` because ai-sdk-ollama
 * silently drops toolChoice — its getCallOptions never destructures it, with no
 * warning.
 *
 * BUT activeTools IS NOT ENFORCEMENT, and this comment used to claim it was.
 * The SDK consults it only in prepareToolsAndToolChoice, to decide which tool
 * DEFINITIONS reach the provider. Execution is `tools[toolCall.toolName]`
 * against the full tool map and never checks activeTools. A model that emits a
 * call for a tool it was never offered gets that call EXECUTED. Measured on
 * probe p09 — see the maxSteps note in provisionTurnTools.
 *
 * Which is why this reserve matters more, not less: emptying the last step's
 * tools makes a stray call unlikely, and the accompanying FINAL_STEP_NOTE plus
 * the floor of 2 steps is what makes prose certain even when one happens.
 *
 * TAKING THE TOOLS AWAY IS NOT ENOUGH ON ITS OWN. Observed on the arithmetic
 * turn: `calculate` rejected the expression, and the model spent its last step
 * reasoning "the calculate tool didn't accept it, let me try a different
 * format" — then emitted no prose at all, because as far as it was concerned
 * the turn was not finished. A model that is silently prevented from acting
 * does not infer that it should now answer; it has to be told. Hence the note.
 */
export const FINAL_STEP_NOTE = [
  '',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  'FINAL STEP — WRITE THE ANSWER NOW',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  'Your tools for this turn are used up and have been removed. Another tool call is impossible — it will not run, and this is your last step.',
  '',
  '- Write the complete final answer now, from the tool results already in this conversation.',
  '- Do NOT describe what you were about to do, do NOT propose retrying in a different format, and do NOT ask to continue.',
  '- Do NOT mention tools, their results, or their absence.',
  '- If a tool failed or returned something unusable, work it out yourself and answer anyway, noting any genuine uncertainty in one short clause.'
].join('\n')

export function applyAnswerStepReserve<
  T extends { activeTools?: string[]; system?: string }
>(
  overrides: T,
  {
    stepNumber,
    maxSteps,
    systemPrompt
  }: {
    stepNumber: number
    maxSteps: number
    /**
     * The turn's system prompt, needed because `system` here REPLACES the
     * instructions for the step rather than adding to them — appending the
     * note alone would silently drop the source block and every prompt rule
     * with it.
     */
    systemPrompt: string
  }
): T {
  // maxSteps === 1 means no tools were provisioned: there is one step, it is
  // the answer, and there is nothing to reserve it from.
  if (maxSteps <= 1) return overrides
  // stepNumber is 0-indexed (the SDK passes `recordedSteps.length`), so the
  // last permitted step is maxSteps - 1.
  if (stepNumber < maxSteps - 1) return overrides
  return {
    ...overrides,
    activeTools: [],
    // A variant that already replaced the prompt keeps its replacement; the
    // note is appended to whichever prompt is actually in force.
    system: `${overrides.system ?? systemPrompt}${FINAL_STEP_NOTE}`
  }
}

/**
 * Tell the model, in the prompt, exactly what it was given.
 *
 * Not decoration. The prompts in force were written for the agentic loop and
 * name tools this turn may not have: the search-mode prompts order `search`
 * first, and DIRECT_ANSWER_PROMPT (the skipSearch prompt) offers
 * `search`/`fetch`/`calculate` as escape hatches. `activeTools` makes those
 * calls physically impossible, and a model told to do the impossible hedges,
 * apologises and narrates about tools instead of answering — the same failure
 * pipelineTurnHeader exists to prevent for sourced turns. This is that header's
 * counterpart for the turns that get no source block.
 */
export function buildProvisionedToolsNote(
  tools: readonly PipelineToolName[]
): string {
  const scope =
    tools.length === 0
      ? 'You have NO tools this turn. Every tool named anywhere above — `search`, `fetch`, `todoWrite`, `calculate`, `get_weather`, `generateImage` — has been removed, and any attempt to call one will not run.'
      : `The ONLY tool available to you this turn is ${tools.map(t => `\`${t}\``).join(' and ')}. Every other tool named anywhere above — including \`search\`, \`fetch\` and \`todoWrite\` — has been removed, and any attempt to call one will not run.`

  return [
    '',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'TOOLS FOR THIS TURN — THIS OVERRIDES EVERY EARLIER STATEMENT ABOUT TOOLS',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    scope,
    '',
    '- Instructions above that require, suggest or offer a removed tool do NOT apply to this turn. Ignore them.',
    '- Do NOT mention tools, searching, browsing, or their absence in your answer, and do NOT apologise for not using one. Answer as though this were simply the work in front of you.'
  ].join('\n')
}

/**
 * Fire retrieval immediately, on the raw user text.
 *
 * Deliberately NOT awaited by the caller — the returned promise is handed to
 * the researcher, which awaits it only when it is ready to build the prompt.
 * That is what keeps retrieval overlapping recall and prompt assembly instead
 * of running behind them.
 *
 * This is the MECHANISM. The policy — which query, and with what freshness
 * window — belongs to startInformedRetrieval below.
 *
 * Never rejects. A failed retrieval must degrade to an unsourced answer, not
 * take the turn down: the old loop could at least try another tool, and this
 * architecture has no second chance by construction.
 */
export function runPipelineRetrieval(
  rawQuery: string,
  opts: {
    timeRange?: 'day' | 'week' | 'month' | 'year'
    intent?: SearchIntent
    chatId?: string
    /**
     * Alternative phrasings from the classifier, searched alongside the main
     * query and merged by URL.
     *
     * NOT an optimisation — closing a measured deficit. This architecture was
     * retrieving on ONE query while the loop's first search retrieves on up to
     * four (searchExpansionVariants), and a blind judge scored it 0W-13L-3T on
     * the current-facts probes. 11 of its 20 losses were turns where it had MORE
     * sources and MORE citations than the loop, so what it lacked was breadth of
     * DISCOVERY: different phrasings surface different pages, and one phrasing
     * cannot find what it does not ask for.
     */
    expandedQueries?: string[]
  } = {}
): Promise<PipelineRetrieval> {
  const query = rawQuery.trim()
  const startedAt = Date.now()
  // Minted here, not when the results land, so the id exists even for the
  // empty-query and failure paths — every caller can rely on it being present.
  const toolCallId = generateId()

  if (!query) {
    return Promise.resolve({ query, results: null, ms: 0, toolCallId })
  }

  // ONE system-level retry when the first pass returns nothing.
  //
  // Measured: 7 of 16 probes retrieved zero sources, with retrieval_ms sitting
  // at ~4000ms — exactly searxng's `outgoing.request_timeout: 4.0`. One of them
  // asked for the current PostgreSQL version, which cannot be answered from
  // parametric knowledge, and it was answered ungrounded.
  //
  // The loop recovered from this by searching again. Removing the loop removed
  // that recovery, so it comes back as CODE. Deliberately NOT handed to the
  // model: "did that work, should I try again?" is the exact judgment whose
  // per-model variance this architecture exists to eliminate. A fixed retry
  // behaves identically on every model; a model deciding does not.
  //
  // One retry, not a loop. If the second pass is also empty the honest outcome
  // is an unsourced answer that says so, which buildSourceBlock handles.
  //
  // Routed through /api/advanced-search — the SAME path the search tool's
  // first search of a turn takes (lib/tools/search.ts), via the shared client.
  // This used to call `createSearchProvider(searchAPI).search(q, 20,
  // 'advanced', …)` directly, which looks equivalent and is not: the provider
  // ignores the depth argument, so there was no crawl, no snippet gate and no
  // cross-encoder rerank, and the "sources" were 100-300 char engine snippets.
  // The per-source 1200-char cap in buildSourceBlock never once had anything
  // to truncate. Depth was the entire reason the loop's first search was worth
  // replacing; retrieving shallower than it would have made the comparison
  // meaningless.
  //
  // `stream: false` because this fires before the UI message stream exists —
  // there is nowhere to put a preview. The synthesized tool part
  // (buildRetrievalToolPart) is written once, from the final payload.
  const searchAPI = (process.env.SEARCH_API || 'searxng') as SearchProviderType
  // The SAME predicate that decides where the search TOOL sends a search, so
  // the two cannot drift. Only searxng+advanced belongs to the route; a
  // deployment configured for Tavily/Exa keeps the direct provider call it
  // always had, because sending it to /api/advanced-search would silently
  // substitute SearXNG for its configured provider — or 500, if SearXNG is not
  // configured on that host at all.
  const useAdvancedRoute = routeEmitsSearchTelemetry(searchAPI, 'advanced')

  const attempt = (): Promise<SearchResults> =>
    useAdvancedRoute
      ? runAdvancedSearch({
          query,
          maxResults: PIPELINE_MAX_RESULTS,
          searchDepth: 'advanced',
          timeRange: opts.timeRange,
          intent: opts.intent,
          chatId: opts.chatId,
          ...resolveOllamaSearchOptions(),
          stream: false
        }).then(r => r.results)
      : createSearchProvider(searchAPI).search(
          query,
          PIPELINE_MAX_RESULTS,
          'advanced',
          [],
          [],
          { time_range: opts.timeRange, intent: opts.intent }
        )

  // Variants run CONCURRENTLY with the main search, so breadth costs
  // wall-clock only when a variant is slower than the deep-crawl it runs
  // beside — which it rarely is, because variants search at BASIC depth
  // (snippets, cached, no crawl). That is also why this does not multiply load
  // on the shared crawl4ai container the way a second advanced pass would.
  const variants: Promise<SearchResults['results']> = opts.expandedQueries
    ?.length
    ? searchExpansionVariants(
        opts.expandedQueries,
        opts.timeRange,
        opts.chatId
      ).catch(() => [])
    : Promise.resolve([])

  const retrieved: Promise<PipelineRetrieval> = attempt()
    .then(async first => {
      if ((first?.results?.length ?? 0) > 0) return first
      console.log('[pipeline] first retrieval empty — retrying once')
      try {
        return await attempt()
      } catch {
        return first
      }
    })
    .then(async main => {
      const extra = await variants
      if (extra.length === 0) return main
      // Main results FIRST, then unique variant results. Order is not cosmetic:
      // citations resolve positionally, so the deep-crawled and reranked pages
      // must hold the low numbers the model reaches for most, and snippet-depth
      // discoveries fill in behind them.
      const seen = new Set((main?.results ?? []).map(r => r.url))
      const merged = [...(main?.results ?? [])]
      let added = 0
      for (const r of extra) {
        if (r?.url && !seen.has(r.url)) {
          seen.add(r.url)
          merged.push(r)
          added++
        }
      }
      if (added > 0) {
        console.log(
          `[pipeline] merged ${added} unique results from ${opts.expandedQueries?.length ?? 0} expansion variants`
        )
      }
      return {
        ...(main ?? { query: rawQuery, images: [], number_of_results: 0 }),
        results: merged,
        number_of_results: merged.length
      } as SearchResults
    })
    .then(results => {
      const ms = Date.now() - startedAt
      console.log(
        `[pipeline] retrieval: ${results?.results?.length ?? 0} results in ${ms}ms` +
          ` (q=${JSON.stringify(query)} range=${opts.timeRange ?? 'any'} intent=${opts.intent ?? 'general'})`
      )
      return { query, results, ms, toolCallId }
    })
    .catch((e: unknown) => {
      const ms = Date.now() - startedAt
      const error = e instanceof Error ? e.message : String(e)
      console.log(`[pipeline] retrieval FAILED in ${ms}ms: ${error}`)
      return { query, results: null, ms, error, toolCallId }
    })

  // The deadline is applied to the WHOLE chain above, main search and variant
  // merge together, because either can be the thing that stalls. Racing rather
  // than aborting: there is no cancellation path through the advanced-search
  // route, so the in-flight work is abandoned to finish or fail on its own
  // while the turn stops waiting for it. Wasteful, and far less wasteful than
  // a five-minute blank page.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<PipelineRetrieval>(resolve => {
    deadlineTimer = setTimeout(() => {
      const ms = Date.now() - startedAt
      console.log(
        `[pipeline] retrieval EXCEEDED ${RETRIEVAL_DEADLINE_MS}ms — answering unsourced`
      )
      resolve({
        query,
        results: null,
        ms,
        error: `retrieval deadline ${RETRIEVAL_DEADLINE_MS}ms exceeded`,
        toolCallId
      })
    }, RETRIEVAL_DEADLINE_MS)
  })

  return Promise.race([retrieved, expired]).finally(() => {
    // Without this the timer holds the event loop open for the rest of the
    // deadline on every fast turn, which is most of them.
    if (deadlineTimer) clearTimeout(deadlineTimer)
  })
}

/**
 * Ceiling on the whole retrieval stage, after which the turn answers unsourced.
 *
 * WHY THIS EXISTS. Under the loop a stalled search costs one step and the model
 * carries on; under this architecture the answer DEPENDS on the single
 * retrieval, so a stall took the entire turn down. Measured: probe p08 returned
 * `wall 300.0s, steps=1, tool_calls=0, sources=0` and a ZERO-CHARACTER answer —
 * it sat in retrieval until route.ts's GENERATION_TIMEOUT_MS (300s) aborted
 * everything, and that abort persists nothing at all. The user waited five
 * minutes for a blank page.
 *
 * 90s is chosen against the observed distribution rather than as a round
 * number: healthy retrieval on this stack runs 10-40s, the worst legitimate
 * completion seen was 71s, and a crawler-saturation stall runs 110-140s before
 * the crawl stage gives up on its own. 90s therefore sits above every real
 * retrieval and below every stall, and it leaves the model most of the 300s
 * turn budget to actually write with.
 *
 * Degrading beats failing: buildSourceBlock already renders an honest "no
 * sources were retrieved" prompt that tells the model to answer from its own
 * knowledge and say so. An unsourced answer is a worse answer; a blank page is
 * not an answer.
 */
export const RETRIEVAL_DEADLINE_MS = 90_000

/**
 * How long retrieval will wait for the classifier before giving up on it.
 *
 * DERIVED from the classifier's own timeout rather than chosen independently,
 * because choosing independently was a bug. This was 5s while classifyQuery is
 * bounded at CLASSIFIER_TIMEOUT_MS (10s) by createTimeoutFetch AND returns a
 * fallback instead of rejecting — so a 5s deadline could not protect against a
 * hang (there cannot be one past 10s) and could only fire in the 5-10s window
 * where the classifier was about to answer. Measured effect: classify_ms median
 * 1525ms with a spike to 9069ms, tripping the deadline on 1 turn in 8 and
 * throwing away that turn's query rewrite and freshness window for nothing.
 *
 * The margin covers the scheduling gap between the fetch timing out inside
 * classifyQuery and the fallback surfacing here, so the classifier's own
 * fallback always wins the race and this deadline stays what it should be: a
 * backstop against a caller passing an UNBOUNDED promise, not a participant in
 * normal operation.
 */
export const CLASSIFY_WAIT_MS = CLASSIFIER_TIMEOUT_MS + 1000

/**
 * Retrieve for this turn, using the classifier's reading of it when that
 * arrives in time.
 *
 * WHAT THIS FIXES. Retrieval used to fire at t=0 on raw text, which meant it
 * could not pass `timeRange` or `intent` — they do not exist yet — so the
 * pipeline had no freshness filter at all while the loop's search tool had one.
 * A blind pairwise judge scored the pipeline 1W-12L-4T on the current-facts
 * probes as a result: asked for figures "this year" it retrieved and faithfully
 * cited last year's.
 *
 * Three things the classifier supplies, all of which change which pages come
 * back:
 *   * `standaloneQuery` — references and pronouns resolved, so a follow-up like
 *     "and Germany?" retrieves for Germany rather than for two words.
 *   * `needsRecent` -> timeRange 'month', the SAME mapping the loop's search
 *     tool uses (researcher.ts), so the two paths cannot drift apart.
 *   * `intent` -> one additive SearXNG category on top of the general baseline.
 *
 * Never rejects, and never waits forever: on classifier failure OR timeout it
 * falls back to exactly the old behaviour (raw text, no freshness window),
 * which is strictly better than no sources.
 */
export function startInformedRetrieval({
  rawQuery,
  classification,
  chatId
}: {
  rawQuery: string
  /**
   * The in-flight classification. Taken as a PROMISE rather than a resolved
   * value so the caller does not have to await it first — awaiting at the call
   * site would serialise the classifier ahead of everything else on the turn,
   * including recall.
   */
  classification: Promise<{
    standaloneQuery?: string
    needsRecent?: boolean
    intent?: SearchIntent
    expandedQueries?: string[]
  }>
  chatId?: string
}): Promise<PipelineRetrieval> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), CLASSIFY_WAIT_MS)
  })

  return Promise.race([
    // A classifier failure is not this function's problem to report — the
    // streaming layer already logs it — so it degrades to the raw-text path.
    classification.catch(() => null),
    deadline
  ]).then(c => {
    // Always clear it: an un-cleared timer keeps the event loop alive in tests
    // and holds the closure for the rest of the request in production.
    if (timer) clearTimeout(timer)
    if (!c) {
      console.log(
        `[pipeline] classifier not ready within ${CLASSIFY_WAIT_MS}ms — retrieving on raw text`
      )
    }
    // standaloneQuery is preferred but never trusted blindly: the classifier is
    // instructed never to return it empty, and a blank query would silently
    // retrieve nothing at all.
    const query = c?.standaloneQuery?.trim() || rawQuery
    const timeRange = c?.needsRecent ? 'month' : undefined
    return runPipelineRetrieval(query, {
      chatId,
      timeRange,
      intent: c?.intent,
      expandedQueries: c?.expandedQueries
    })
  })
}

/**
 * The header that cancels the loop's instructions.
 *
 * The search-mode prompts (lib/agents/prompts/search-mode-prompts.ts) are
 * written for the agentic loop and say, repeatedly, that the FIRST action of
 * every turn MUST be the `search` tool and that answering from memory instead
 * of verifying with a fresh search is forbidden. Under this architecture
 * `search` and `fetch` are removed from activeTools before the provider ever
 * sees the request, so those lines order the model to do something it
 * physically cannot — and a model told to do the impossible hedges, apologises
 * and narrates about tools instead of answering.
 *
 * Cancelled HERE, in what the pipeline path appends, rather than by editing
 * the shared prompts: the loop is still the default architecture and its
 * prompt must keep working unchanged. This block is appended last, and "later
 * instructions supersede earlier ones" is already the convention those prompts
 * rely on (quality mode overrides balanced the same way).
 */
function pipelineTurnHeader(): string[] {
  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'RESEARCH IS ALREADY DONE — THIS SECTION OVERRIDES EVERYTHING ABOVE',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    // Precise about WHICH tools are gone: the researcher strips `search` and
    // `fetch` from activeTools, and nothing else. Claiming "no tools at all"
    // would be false wherever calculate/generateImage are still registered,
    // and a prompt the model can catch being wrong is a prompt it starts
    // second-guessing.
    'The research for this turn was carried out before you were called. `search` and `fetch` have been REMOVED from your tools for this turn — you cannot call them, and any attempt will not run.',
    '',
    '- Every instruction above about calling `search` first, searching before answering, verifying claims with a fresh search, fetching a page for depth, or never answering without searching does NOT apply to this turn. Ignore it.',
    '- Do NOT mention tools, searching, browsing, or their absence in your answer. Do NOT apologise for not searching. Write as though the research were simply done — it is.',
    '- Write the final answer now, from the sources below. There is no second research pass.'
  ]
}

/**
 * Render retrieved sources into the system prompt.
 *
 * Numbered because the citation contract downstream is positional — the model
 * cites what it is shown, and inventing an anchor for a source it was not given
 * is the failure mode worth designing against. Content is truncated per source
 * rather than globally so one long page cannot crowd out the rest; turn latency
 * tracks prompt_tokens closely enough that an unbounded context is a latency
 * bug, not just a cost one.
 *
 * The citation format is `[N](#toolCallId)` — the SAME format the base prompts
 * mandate, and the only one lib/utils/citation.ts can resolve. It previously
 * said "cite as [1], [2]", which contradicted the base prompt two paragraphs
 * earlier AND produced markers that processCitations leaves untouched: a bare
 * [1] never becomes a link. One retrieval means one anchor, so every source
 * number on this turn shares the same id.
 */
export function buildSourceBlock(retrieval: PipelineRetrieval): string {
  const rows = retrieval.results?.results ?? []
  if (rows.length === 0) {
    return [
      ...pipelineTurnHeader(),
      '',
      '## Retrieved sources',
      '',
      'No sources were retrieved for this question.',
      'Answer from your own knowledge, and say plainly that you could not consult sources.',
      'Do NOT invent citations — write no citation markers at all this turn.'
    ].join('\n')
  }

  const lines = rows.slice(0, PIPELINE_MAX_RESULTS).map((r, i) => {
    const content = (r.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, pipelineSourceChars())
    return `[${i + 1}] ${r.title || '(untitled)'}\nURL: ${r.url}\n${content}`
  })

  const id = retrieval.toolCallId

  return [
    ...pipelineTurnHeader(),
    '',
    '## Retrieved sources',
    '',
    `These ${lines.length} sources were retrieved for this question BEFORE you were called. They are all you have.`,
    'If they do not answer part of the question, say so in one clause rather than guessing.',
    '',
    'CITATION FORMAT for this turn — this REPLACES every citation instruction above:',
    `- Cite inline as [N](#${id}) where N is a source number below and the anchor is exactly \`${id}\` every time.`,
    // The example cites [1], which is always a source that exists — this
    // branch only runs with at least one row. An example citing a number the
    // list does not contain is the exact mistake the next line forbids.
    `- Example: "PostgreSQL 18.4 fixed the planner regression. [1](#${id})"`,
    '- All sources this turn share that one anchor. Never write a bare [N] with no anchor, never invent a different anchor, and never cite a number that is not listed below.',
    '- Placement is unchanged: finish the sentence, add the period, then the citation.',
    '- You were given no image URLs this turn, so do not emit an inline image spec block and never invent image URLs.',
    '',
    lines.join('\n\n')
  ].join('\n')
}

/** The tool part's shape as the UI and the persistence layer expect it. */
export type SynthesizedSearchToolPart = {
  toolCallId: string
  toolName: 'search'
  input: {
    query: string
    search_mode: 'web'
    type: 'optimized'
    content_types: ['web']
    max_results: number
    search_depth: 'advanced'
    include_domains: string[]
    exclude_domains: string[]
  }
  output: SearchResults & { state: 'complete' }
}

/**
 * Forge the `tool-search` message part the rest of the app is built around.
 *
 * WHY THIS EXISTS — the entire provenance stack keys on a search TOOL CALL,
 * and this architecture has none:
 *   - lib/utils/citation.ts:42-49 builds citation maps ONLY from parts whose
 *     type is `tool-search` with state `output-available`, keyed by
 *     `toolCallId`, deriving citation N from `output.results[N-1]`. With no
 *     such part extractCitationMaps returns {} and processCitations
 *     early-returns the text unchanged (citation.ts:102-104) — so `[1](#id)`
 *     is rendered as literal text, or stripped, never as a link.
 *   - components/render-message.tsx:254-266 buffers only `tool-*`,
 *     `reasoning` and `data-*` parts into ResearchProcessSection. With no tool
 *     part there is no sources panel, no images and no videos — a pipeline
 *     answer had ZERO visible provenance.
 *   - components/search-section.tsx:54-57 reads results only when
 *     `output.state === 'complete'`, hence the marker on the output below.
 *
 * The alternative — teaching the citation stack about a second, retrieval-
 * shaped source of truth — means touching citation extraction, the research
 * panel, the inspector, the DB part mapping and the artifact view. Producing
 * the shape they already consume is one function and no new contract.
 *
 * The `input` is what the model WOULD have had to pass to get this retrieval,
 * so the panel header renders the query and the inspector shows a coherent
 * call. Nothing reads it back as an instruction.
 *
 * The slice must match buildSourceBlock's: citations resolve POSITIONALLY
 * (citation N -> results[N-1]), so if the prompt showed a different set, or a
 * different order, than this part carries, every citation would point at the
 * wrong page while still looking perfectly valid.
 */
export function buildRetrievalToolPart(
  retrieval: PipelineRetrieval
): SynthesizedSearchToolPart {
  const results = (retrieval.results?.results ?? []).slice(
    0,
    PIPELINE_MAX_RESULTS
  )

  return {
    toolCallId: retrieval.toolCallId,
    toolName: 'search',
    input: {
      query: retrieval.query,
      search_mode: 'web',
      type: 'optimized',
      content_types: ['web'],
      max_results: PIPELINE_MAX_RESULTS,
      search_depth: 'advanced',
      include_domains: [],
      exclude_domains: []
    },
    output: {
      // 'complete' is the streaming marker the real search tool ends on; the
      // UI treats anything else as still-searching and renders a skeleton
      // forever.
      state: 'complete',
      results,
      images: retrieval.results?.images ?? [],
      query: retrieval.query,
      number_of_results: results.length,
      // Same id inside the payload as on the part, matching what the search
      // tool attaches (lib/tools/search.ts) — persisted-message consumers read
      // it from either place.
      toolCallId: retrieval.toolCallId
    }
  }
}
