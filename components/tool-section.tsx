'use client'

import { UseChatHelpers } from '@ai-sdk/react'

import type { SearchResultItem } from '@/lib/types'
import type { ToolPart, UIDataTypes, UIMessage, UITools } from '@/lib/types/ai'

import FetchSection from './fetch-section'
import { QuestionConfirmation } from './question-confirmation'
import { type RecallToolResult, RecallToolSection } from './recall-tool-section'
import { SearchResults } from './search-results'
import { SearchSection } from './search-section'
import { Section } from './section'
import { ToolTodoDisplay } from './tool-todo-display'

interface ToolSectionProps {
  tool: ToolPart
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  status?: UseChatHelpers<UIMessage<unknown, UIDataTypes, UITools>>['status']
  addToolResult?: (params: { toolCallId: string; result: any }) => void
  borderless?: boolean
  isFirst?: boolean
  isLast?: boolean
}

export function ToolSection({
  tool,
  isOpen,
  onOpenChange,
  status,
  addToolResult,
  borderless = false,
  isFirst = false,
  isLast = false
}: ToolSectionProps) {
  // Special handling for ask_question tool
  if (tool.type === 'tool-askQuestion') {
    // When waiting for user input
    if (
      (tool.state === 'input-streaming' || tool.state === 'input-available') &&
      addToolResult
    ) {
      return (
        <QuestionConfirmation
          toolInvocation={tool as ToolPart<'askQuestion'>}
          onConfirm={(toolCallId, approved, response) => {
            addToolResult({
              toolCallId,
              result: approved
                ? response
                : {
                    declined: true,
                    skipped: response?.skipped,
                    message: 'User declined this question'
                  }
            })
          }}
        />
      )
    }

    // When result is available, display the result
    if (tool.state === 'output-available') {
      return (
        <QuestionConfirmation
          toolInvocation={tool as ToolPart<'askQuestion'>}
          isCompleted={true}
          onConfirm={() => {}} // Not used in result display mode
        />
      )
    }
  }

  // calculate is a registered tool but not in the statically-typed ToolPart
  // union, so it has no switch case below and would fall to `default: null` —
  // an empty step in the live stream. Render the expression -> result inline so
  // a freshly-run calculation shows inside the accordion (on reload it arrives
  // as a dynamic-tool and renders via DynamicToolDisplay).
  if ((tool.type as string) === 'tool-calculate') {
    const inp = (tool as { input?: { expression?: string } }).input
    const out = (tool as { output?: { expression?: string; result?: string } })
      .output
    const expr = out?.expression ?? inp?.expression
    if (!expr) return null
    return (
      <div className="my-1 flex flex-wrap items-baseline gap-x-2 rounded-md bg-muted/40 px-3 py-2 font-mono text-sm">
        <span className="text-muted-foreground">{expr}</span>
        {out?.result != null && (
          <>
            <span className="text-muted-foreground">=</span>
            <span className="font-semibold">{out.result}</span>
          </>
        )}
      </div>
    )
  }

  switch (tool.type) {
    case 'tool-search':
      return (
        <SearchSection
          tool={tool as ToolPart<'search'>}
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          status={status}
          borderless={borderless}
          isFirst={isFirst}
          isLast={isLast}
        />
      )
    case 'tool-fetch':
      return (
        <FetchSection
          tool={tool as ToolPart<'fetch'>}
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          status={status}
          borderless={borderless}
          isFirst={isFirst}
          isLast={isLast}
        />
      )
    case 'tool-recall':
      return (
        <RecallToolSection
          query={(tool.input as { query?: string } | undefined)?.query}
          output={tool.output as RecallToolResult | undefined}
          borderless={borderless}
          isFirst={isFirst}
          isLast={isLast}
        />
      )
    case 'tool-documentRetrieval': {
      // Task 5 injects this synthetic retrieval part for an attached document
      // or a pasted URL. Its output carries the identical
      // { results: SearchResultItem[] } shape as search/fetch, so render the
      // same "Sources" grid card here; the inline citation popover already
      // works from Task 2 and needs no separate component.
      const output =
        tool.state === 'output-available'
          ? (tool.output as { results?: SearchResultItem[] } | undefined)
          : undefined
      const results = output?.results
      if (!results || results.length === 0) {
        return null
      }
      return (
        <Section title="Sources">
          <SearchResults results={results} />
        </Section>
      )
    }
    case 'tool-todoWrite':
      return (
        <ToolTodoDisplay
          tool="todoWrite"
          state={tool.state}
          input={tool.input}
          output={tool.output}
          errorText={tool.errorText}
          toolCallId={tool.toolCallId}
          isOpen={isOpen}
          onOpenChange={onOpenChange}
          borderless={borderless}
          isFirst={isFirst}
          isLast={isLast}
        />
      )
    default:
      return null
  }
}
