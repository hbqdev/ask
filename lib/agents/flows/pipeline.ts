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
// SPECULATIVE START is the other half. Retrieval is fired on the user's RAW
// text before the classifier has returned — it does not wait to be understood.
// Measured preamble before the old first search: classify ~1.2s, recall ~5.0s
// (concurrent), first token ~7.7s. Starting at t=0 takes that off the critical
// path entirely; by the time understanding lands, sources are already in hand.
//
// The cost is searches we might not have needed. That trade is deliberate: a
// SearXNG query is cheap and parallel, a model round trip is ~10s and serial.
// Spending the cheap resource to save the expensive one is the whole idea.

import { generateId } from 'ai'

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
 * Does this turn's speculative retrieval reach the model's prompt?
 *
 * Retrieval always FIRES (that is the speculative half of the architecture);
 * this decides whether the sources are kept or discarded. `skipSearch` covers
 * turns answerable from the conversation itself. The other two are separate
 * signals on purpose:
 *
 *   * `needsRecent` is FRESHNESS — the answer depends on current facts.
 *   * `needsSources` is GROUNDING — the answer draws on external facts at all,
 *     fresh or not.
 *
 * Gating on freshness ALONE was measurably wrong. "compare Caddy, Traefik and
 * nginx" and "what is TCP" are not time-sensitive, so needsRecent declined
 * them — and because a turn with no sources and no other capability then got
 * handed the `search` tool as a last resort, the saving was inverted into a
 * whole extra model round trip (~10s) to re-fetch sources this architecture
 * had ALREADY retrieved speculatively and thrown away. Freshness was never the
 * question being asked here; grounding was.
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
    maxSteps: tools.length + 1,
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
 * Enforcement is `activeTools` rather than `toolChoice: 'none'` because the SDK
 * applies `activeTools` before any provider sees the request, whereas
 * `ai-sdk-ollama` silently drops `toolChoice` — its `getCallOptions` never
 * destructures it, with no warning. A guarantee that depends on a provider
 * honouring a hint is not a guarantee.
 */
export function applyAnswerStepReserve<T extends { activeTools?: string[] }>(
  overrides: T,
  { stepNumber, maxSteps }: { stepNumber: number; maxSteps: number }
): T {
  // maxSteps === 1 means no tools were provisioned: there is one step, it is
  // the answer, and there is nothing to reserve it from.
  if (maxSteps <= 1) return overrides
  // stepNumber is 0-indexed, so the last permitted step is maxSteps - 1.
  return stepNumber >= maxSteps - 1
    ? { ...overrides, activeTools: [] }
    : overrides
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
 * That is what puts retrieval and understanding on the same clock instead of
 * one behind the other.
 *
 * Never rejects. A failed retrieval must degrade to an unsourced answer, not
 * take the turn down: the old loop could at least try another tool, and this
 * architecture has no second chance by construction.
 */
export function startSpeculativeRetrieval(
  rawQuery: string,
  opts: {
    timeRange?: 'day' | 'week' | 'month' | 'year'
    intent?: SearchIntent
    chatId?: string
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

  return attempt()
    .then(async first => {
      if ((first?.results?.length ?? 0) > 0) return first
      console.log('[pipeline] first retrieval empty — retrying once')
      try {
        return await attempt()
      } catch {
        return first
      }
    })
    .then(results => {
      const ms = Date.now() - startedAt
      console.log(
        `[pipeline] speculative retrieval: ${results?.results?.length ?? 0} results in ${ms}ms`
      )
      return { query, results, ms, toolCallId }
    })
    .catch((e: unknown) => {
      const ms = Date.now() - startedAt
      const error = e instanceof Error ? e.message : String(e)
      console.log(
        `[pipeline] speculative retrieval FAILED in ${ms}ms: ${error}`
      )
      return { query, results: null, ms, error, toolCallId }
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

  const PER_SOURCE_CHARS = 1200
  const lines = rows.slice(0, PIPELINE_MAX_RESULTS).map((r, i) => {
    const content = (r.content || '')
      .replace(/\s+/g, ' ')
      .slice(0, PER_SOURCE_CHARS)
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
