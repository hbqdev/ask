import { stepCountIs, tool, ToolLoopAgent } from 'ai'

import type { ResearcherTools } from '@/lib/types/agent'
import { type Model } from '@/lib/types/models'

import { calculateTool } from '../tools/calculate'
import { fetchTool } from '../tools/fetch'
import { createQuestionTool } from '../tools/question'
import { createSearchTool } from '../tools/search'
import { createTodoTools } from '../tools/todo'
import { weatherTool } from '../tools/weather'
import { SearchMode, SearchSources } from '../types/search'
import { getModel } from '../utils/registry'
import { isTracingEnabled } from '../utils/telemetry'

import {
  getAdaptiveModePrompt,
  getQualityModePrompt,
  SPEED_MODE_PROMPT
} from './prompts/search-mode-prompts'

// Wraps the search tool to deduplicate results across calls within one request.
// When the same URL appears in a later search, it's filtered out so the model
// doesn't see redundant content.
function wrapSearchToolWithDedup<T extends ReturnType<typeof createSearchTool>>(
  originalTool: T,
  seenUrls: Set<string>
): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tool({
    description: originalTool.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: originalTool.inputSchema as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toModelOutput: originalTool.toModelOutput as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *execute(params: any, context: any) {
      const executeFunc = originalTool.execute
      if (!executeFunc) throw new Error('Search tool execute is not defined')

      const result = executeFunc(params, context)
      const iterable =
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in (result as object)
          ? (result as AsyncIterable<unknown>)
          : (async function* () {
              yield await result
            })()

      for await (const chunk of iterable) {
        const c = chunk as { state?: string; results?: Array<{ url?: string }> }
        if (c.state === 'complete' && Array.isArray(c.results)) {
          const deduped = c.results.filter(r => {
            if (!r.url) return true
            if (seenUrls.has(r.url)) return false
            seenUrls.add(r.url)
            return true
          })
          yield { ...c, results: deduped }
        } else {
          yield chunk
        }
      }
    }
  }) as T
}

// Enhanced wrapper function with better type safety and streaming support
function wrapSearchToolForQuickMode<
  T extends ReturnType<typeof createSearchTool>
>(originalTool: T): T {
  return tool({
    description: originalTool.description,
    inputSchema: originalTool.inputSchema,
    // Preserve the original tool's model-output trimming (strips the duplicated
    // citationMap / UI-only images) so quick mode gets the same payload savings.
    toModelOutput: originalTool.toModelOutput,
    async *execute(params, context) {
      const executeFunc = originalTool.execute
      if (!executeFunc) {
        throw new Error('Search tool execute function is not defined')
      }

      // Force optimized type for quick mode
      const modifiedParams = {
        ...params,
        type: 'optimized' as const
      }

      // Execute the original tool and pass through all yielded values
      const result = executeFunc(modifiedParams, context)

      // Handle AsyncIterable (streaming) case
      if (
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in result
      ) {
        for await (const chunk of result) {
          yield chunk
        }
      } else {
        // Fallback for non-streaming (shouldn't happen with new implementation)
        const finalResult = await result
        yield finalResult || {
          state: 'complete' as const,
          results: [],
          images: [],
          query: params.query,
          number_of_results: 0
        }
      }
    }
  }) as T
}

// Enforces source selection at the tool level so the model physically cannot
// deviate — but only when exactly one non-web source is selected alone
// (Web off). 'academic' (exclusive) forces search_mode: 'academic' on every
// search call. 'social' (exclusive) forces search_mode: 'social' on every
// search call. Two non-web sources together (Academic+Social, Web off)
// don't get a single fixed search_mode forced — a single search_mode can't
// represent "pick either of these two", so that combination stays advisory
// (model chooses per query, same as any combination that includes Web).
export function wrapSearchToolForSources<
  T extends ReturnType<typeof createSearchTool>
>(originalTool: T, sources: SearchSources): T {
  const hasWeb = sources.includes('web')
  const hasAcademic = sources.includes('academic')
  const hasSocial = sources.includes('social')

  const academicOnly = !hasWeb && hasAcademic && !hasSocial
  const socialOnly = !hasWeb && !hasAcademic && hasSocial

  if (!academicOnly && !socialOnly) return originalTool

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tool({
    description: originalTool.description,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: originalTool.inputSchema as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toModelOutput: originalTool.toModelOutput as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *execute(params: any, context: any) {
      const modifiedParams = {
        ...params,
        search_mode: academicOnly ? ('academic' as const) : ('social' as const)
      }

      const executeFunc = originalTool.execute
      if (!executeFunc) throw new Error('Search tool execute is not defined')

      const result = executeFunc(modifiedParams, context)
      const iterable =
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in (result as object)
          ? (result as AsyncIterable<unknown>)
          : (async function* () {
              yield await result
            })()

      for await (const chunk of iterable) {
        yield chunk
      }
    }
  }) as T
}

export function getSourcesPromptAddendum(sources: SearchSources): string {
  const hasAcademic = sources.includes('academic')
  const hasSocial = sources.includes('social')
  const hasWeb = sources.includes('web')

  const zeroResultsGuidance =
    '\n\nIf a search returns zero or very few results: retry ONCE with shorter, simpler, less-quoted terms (drop exact-phrase quoting and extra qualifiers first). If results are still sparse after that retry, do not keep second-guessing the date, the model name, or your own knowledge — write the best answer you can from what you found (or say clearly that source coverage was limited for this query) and move on. Never let a thin result set turn into open-ended self-doubt in your response.'

  if (!hasWeb && hasAcademic && !hasSocial) {
    return `\n\n**User-selected Academic focus**: The user has explicitly chosen academic sources. ALL searches are automatically routed to search_mode: 'academic' (Google Scholar, arXiv, Semantic Scholar, PubMed, and other science sources) regardless of what you pass. Prioritize peer-reviewed papers, cite authors and publication years when available, and frame your answer in scholarly terms.${zeroResultsGuidance}`
  }
  if (!hasWeb && !hasAcademic && hasSocial) {
    return `\n\n**User-selected Social focus**: The user has explicitly chosen community discussions. ALL searches are automatically routed to search_mode: 'social' (Reddit, Lemmy, Mastodon, Hacker News) regardless of what you pass. Prioritize real user opinions, personal experiences, and community consensus.${zeroResultsGuidance}`
  }
  if (!hasWeb && hasAcademic && hasSocial) {
    return "\n\n**Academic + Social focus (no Web)**: The user has excluded general web results. For research/science questions use search_mode: 'academic'. For opinions/experiences/community questions use search_mode: 'social'. Choose the appropriate one per query — do not use standard web search."
  }
  if (hasAcademic && hasSocial) {
    return "\n\n**Multi-source mode**: The user has enabled Web + Academic + Social sources. For research/science questions use search_mode: 'academic'. For community perspectives use search_mode: 'social'. For general info use standard web search (search_mode: 'web'). Choose the appropriate source type per query."
  }
  if (hasAcademic) {
    return "\n\n**Academic sources enabled**: For research/science/medical questions use search_mode: 'academic' to get scholarly results. For other questions use standard web search."
  }
  if (hasSocial) {
    return "\n\n**Social sources enabled**: For opinion/experience/community questions use search_mode: 'social'. For factual questions use standard web search."
  }
  return ''
}

// Enhanced researcher function with improved type safety using ToolLoopAgent
// Note: abortSignal should be passed to agent.stream() or agent.generate() calls, not to the agent constructor
export function createResearcher({
  model,
  modelConfig,
  parentTraceId,
  searchMode = 'balanced',
  sources = ['web'],
  systemInstructions,
  abortSignal
}: {
  model: string
  modelConfig?: Model
  parentTraceId?: string
  searchMode?: SearchMode
  sources?: SearchSources
  systemInstructions?: string
  abortSignal?: AbortSignal
}) {
  try {
    const currentDate = new Date().toLocaleString()

    // Create model-specific tools with proper typing
    const originalSearchTool = createSearchTool(model)
    const askQuestionTool = createQuestionTool(model)
    const todoTools = createTodoTools()

    // Per-request URL dedup: same URL found by multiple searches won't be sent
    // to the model twice (redundant context wastes tokens and confuses citations).
    const seenUrls = new Set<string>()

    let systemPrompt: string
    let activeToolsList: (keyof ResearcherTools)[] = []
    let maxSteps: number
    let searchTool = originalSearchTool

    // Configure based on search mode
    switch (searchMode) {
      case 'speed':
        console.log(
          `[Researcher] Speed mode: maxSteps=20, tools=[search, fetch, calculate, get_weather], sources=${JSON.stringify(sources)}`
        )
        systemPrompt = SPEED_MODE_PROMPT
        activeToolsList = ['search', 'fetch', 'calculate', 'get_weather']
        maxSteps = 20
        searchTool = wrapSearchToolForSources(
          wrapSearchToolWithDedup(
            wrapSearchToolForQuickMode(originalSearchTool),
            seenUrls
          ),
          sources
        )
        break

      case 'quality':
        systemPrompt = getQualityModePrompt()
        activeToolsList = [
          'search',
          'fetch',
          'todoWrite',
          'calculate',
          'get_weather'
        ]
        console.log(
          `[Researcher] Quality mode: maxSteps=100, tools=[${activeToolsList.join(', ')}], sources=${JSON.stringify(sources)}`
        )
        maxSteps = 100
        searchTool = wrapSearchToolForSources(
          wrapSearchToolWithDedup(originalSearchTool, seenUrls),
          sources
        )
        break

      case 'balanced':
      default:
        systemPrompt = getAdaptiveModePrompt()
        activeToolsList = [
          'search',
          'fetch',
          'todoWrite',
          'calculate',
          'get_weather'
        ]
        console.log(
          `[Researcher] Balanced mode: maxSteps=50, tools=[${activeToolsList.join(', ')}], sources=${JSON.stringify(sources)}`
        )
        maxSteps = 50
        searchTool = wrapSearchToolForSources(
          wrapSearchToolWithDedup(originalSearchTool, seenUrls),
          sources
        )
        break
    }

    // Append source instructions to system prompt
    systemPrompt = systemPrompt + getSourcesPromptAddendum(sources)

    // Append user's custom instructions at lower priority (per Vane pattern)
    if (systemInstructions?.trim()) {
      systemPrompt =
        systemPrompt +
        `\n\n### User instructions\nThese instructions are provided by the user. Follow them but give them lower priority than the above system guidelines.\n${systemInstructions.trim()}`
    }

    // Build tools object with proper typing
    const tools: ResearcherTools = {
      search: searchTool,
      fetch: fetchTool,
      askQuestion: askQuestionTool,
      calculate: calculateTool,
      get_weather: weatherTool,
      ...todoTools
    } as ResearcherTools

    // Create ToolLoopAgent with all configuration
    const agent = new ToolLoopAgent({
      model: getModel(model, abortSignal),
      instructions: `${systemPrompt}\nCurrent date and time: ${currentDate}`,
      tools,
      activeTools: activeToolsList,
      // No toolChoice forcing and no dedicated "done" tool — matches upstream
      // Morphic's proven pattern. The loop naturally stops the moment the
      // model responds with plain text and no tool calls; forcing a tool
      // call on every step (as a prior version did) left weaker models with
      // no valid way to finish except an unfamiliar "stop" tool, causing
      // them to loop on search/fetch instead of ever producing an answer.
      stopWhen: stepCountIs(maxSteps),
      ...(modelConfig?.providerOptions && {
        providerOptions: modelConfig.providerOptions
      }),
      experimental_telemetry: {
        isEnabled: isTracingEnabled(),
        functionId: 'research-agent',
        metadata: {
          modelId: model,
          agentType: 'researcher',
          searchMode,
          ...(parentTraceId && {
            langfuseTraceId: parentTraceId,
            langfuseUpdateParent: false
          })
        }
      }
    })

    return agent
  } catch (error) {
    console.error('Error in createResearcher:', error)
    throw error
  }
}

// Helper function to access agent tools
export function getResearcherTools(
  agent: ToolLoopAgent<never, ResearcherTools, never>
): ResearcherTools {
  return agent.tools
}

// Export the legacy function name for backward compatibility
export const researcher = createResearcher
