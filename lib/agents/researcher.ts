import { hasToolCall, stepCountIs, tool, ToolLoopAgent } from 'ai'

import type { ResearcherTools } from '@/lib/types/agent'
import { type Model } from '@/lib/types/models'

import { calculateTool } from '../tools/calculate'
import { fetchTool } from '../tools/fetch'
import { createQuestionTool } from '../tools/question'
import { createSearchTool } from '../tools/search'
import { synthesisReadyTool } from '../tools/synthesis-ready'
import { createTodoTools } from '../tools/todo'
import { weatherTool } from '../tools/weather'
import { SearchMode, SearchSources } from '../types/search'
import { getModel } from '../utils/registry'
import { isTracingEnabled } from '../utils/telemetry'

import {
  getAdaptiveModePrompt,
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

// Enforces source selection at the tool level so the model physically cannot deviate.
// 'academic' (exclusive) forces search_mode: 'academic' on every search call.
// 'social' (exclusive) appends reddit.com to include_domains on every search call.
// Mixed or web-only: returns the tool unchanged (model decides per query).
function wrapSearchToolForSources<T extends ReturnType<typeof createSearchTool>>(
  originalTool: T,
  sources: SearchSources
): T {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let modifiedParams: any = { ...params }

      if (academicOnly) {
        modifiedParams.search_mode = 'academic'
      } else if (socialOnly) {
        const existing: string[] = Array.isArray(modifiedParams.include_domains)
          ? modifiedParams.include_domains
          : []
        modifiedParams.include_domains = existing.includes('reddit.com')
          ? existing
          : [...existing, 'reddit.com']
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

function getSourcesPromptAddendum(sources: SearchSources): string {
  const hasAcademic = sources.includes('academic')
  const hasSocial = sources.includes('social')
  const hasWeb = sources.includes('web')

  if (!hasWeb && hasAcademic && !hasSocial) {
    return '\n\n**User-selected Academic focus**: The user has explicitly chosen academic sources. ALL searches are automatically routed to Google Scholar, arXiv, Semantic Scholar, and PubMed. Prioritize peer-reviewed papers, cite authors and publication years when available, and frame your answer in scholarly terms.'
  }
  if (!hasWeb && !hasAcademic && hasSocial) {
    return '\n\n**User-selected Social focus**: The user has explicitly chosen community discussions. ALL searches are automatically routed to Reddit. Prioritize real user opinions, personal experiences, and community consensus.'
  }
  if (hasAcademic && hasSocial) {
    return "\n\n**Multi-source mode**: The user has enabled Web + Academic + Social sources. For research/science questions use search_mode: 'academic'. For community perspectives add include_domains: ['reddit.com']. For general info use standard web search. Choose the appropriate source type per query."
  }
  if (hasAcademic) {
    return "\n\n**Academic sources enabled**: For research/science/medical questions use search_mode: 'academic' to get scholarly results. For other questions use standard web search."
  }
  if (hasSocial) {
    return "\n\n**Social sources enabled**: For opinion/experience/community questions add include_domains: ['reddit.com']. For factual questions use standard web search."
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
  systemInstructions
}: {
  model: string
  modelConfig?: Model
  parentTraceId?: string
  searchMode?: SearchMode
  sources?: SearchSources
  systemInstructions?: string
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
          `[Researcher] Speed mode: maxSteps=20, tools=[search, fetch, calculate, get_weather, synthesis_ready], sources=${JSON.stringify(sources)}`
        )
        systemPrompt = SPEED_MODE_PROMPT
        activeToolsList = ['search', 'fetch', 'calculate', 'get_weather', 'synthesis_ready']
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
        systemPrompt =
          getAdaptiveModePrompt() +
          '\n\n**Quality mode**: Provide the most comprehensive, well-researched answer possible. Use at least 8-10 searches from multiple angles. Fetch full page content for the most relevant sources. Aim for thoroughness over brevity.'
        activeToolsList = ['search', 'fetch', 'todoWrite', 'calculate', 'get_weather', 'synthesis_ready']
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
        activeToolsList = ['search', 'fetch', 'todoWrite', 'calculate', 'get_weather', 'synthesis_ready']
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
      synthesis_ready: synthesisReadyTool,
      ...todoTools
    } as ResearcherTools

    // Create ToolLoopAgent with all configuration
    const agent = new ToolLoopAgent({
      model: getModel(model),
      instructions: `${systemPrompt}\nCurrent date and time: ${currentDate}`,
      tools,
      activeTools: activeToolsList,
      // toolChoice: 'required' prevents the model from producing a text-only
      // step (which stops the loop prematurely in old chats with history).
      // hasToolCall('synthesis_ready') stops the loop the moment the model
      // signals it has finished research, even though toolChoice forces a call.
      toolChoice: 'required',
      stopWhen: [stepCountIs(maxSteps), hasToolCall('synthesis_ready')],
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
