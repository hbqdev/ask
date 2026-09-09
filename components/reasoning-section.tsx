'use client'

import { useEffect, useState } from 'react'

import type { ReasoningPart } from '@ai-sdk/provider-utils'

import { cn } from '@/lib/utils'

import { useArtifact } from '@/components/artifact/artifact-context'

import { CollapsibleMessage } from './collapsible-message'
import { DefaultSkeleton } from './default-skeleton'
import { MarkdownMessage } from './message'
import ProcessHeader from './process-header'

interface ReasoningContent {
  reasoning: string
  isDone: boolean
}

// Raw chain-of-thought is HIDDEN from the chat transcript by default. A
// reasoning model can emit tens of thousands of characters of thinking in a
// single turn; shown inline it dominates the message and reads as if the
// answer itself contains the intermediate steps. We still PERSIST reasoning as
// separate parts (see the DB layer) — this flag only controls whether the raw
// text is rendered in the transcript.
//
// Default (unset / anything but 'true') = hidden: render only a compact,
// non-expandable "Thinking…/Thought" indicator, with NO disclosure that could
// reveal the raw text in the normal chat view. Set NEXT_PUBLIC_SHOW_REASONING=
// 'true' to restore the legacy collapsible raw-reasoning view.
//
// NEXT_PUBLIC_* is inlined by `next build` from the build context's .env, so
// prod/staging get the hidden default with no env change; the lab can flip it
// on in .env to eyeball raw thoughts. The code default is authoritative. Read
// inside the component (like the voice flag in render-message) so it inlines
// per-occurrence and stays togglable in tests.

export interface ReasoningSectionProps {
  content: ReasoningContent
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  showIcon?: boolean
  variant?: 'default' | 'minimal' | 'process' | 'process-sub'
  isSingle?: boolean // Whether this is a single item or part of a group
  isFirst?: boolean
  isLast?: boolean
}

export function ReasoningSection({
  content,
  isOpen,
  onOpenChange,
  showIcon = false,
  variant = 'default',
  isSingle = true,
  isFirst = false,
  isLast = false
}: ReasoningSectionProps) {
  const { open } = useArtifact()
  const showReasoning = process.env.NEXT_PUBLIC_SHOW_REASONING === 'true'
  // Show a short preview when collapsed; switch to a generic label when expanded
  const HEADER_PREVIEW_CHARS = 120
  const SANITIZE_MARKDOWN_PREVIEW = true
  const [preview, setPreview] = useState<string | null>(null)

  const toPreview = (text: string) => {
    const firstLine = (text || '').split(/\r?\n/)[0] || ''
    if (!SANITIZE_MARKDOWN_PREVIEW) return firstLine
    return firstLine
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1') // links [text](url)
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/\*\*([^*]+)\*\*/g, '$1') // bold **text**
      .replace(/__([^_]+)__/g, '$1') // bold __text__
      .replace(/^#{1,6}\s*/, '') // heading markers at start
  }

  // Lock a preview during streaming to avoid frequent churn; refresh once when done
  useEffect(() => {
    const text = content?.reasoning || ''
    if (!text) return
    const prepared = toPreview(text)
    if (!content.isDone) {
      // Set once during streaming
      if (!preview) setPreview(prepared.slice(0, HEADER_PREVIEW_CHARS))
    } else {
      // On completion, ensure preview reflects the final string (single update)
      const finalPreview = prepared.slice(0, HEADER_PREVIEW_CHARS)
      if (preview !== finalPreview) setPreview(finalPreview)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content.reasoning, content.isDone])

  const headerLabel = isOpen
    ? 'Thoughts'
    : preview && preview.length > 0
      ? preview
      : !content.isDone
        ? 'Thinking...'
        : 'Thoughts'

  const reasoningHeader = (
    <ProcessHeader
      label={
        <div className="flex items-center gap-2 min-w-0">
          <div className="size-4 shrink-0 flex items-center justify-center relative">
            <div className="size-1.5 rounded-full bg-muted-foreground" />
          </div>
          <span className="truncate block min-w-0 max-w-full">
            {headerLabel}
          </span>
        </div>
      }
      onInspect={() =>
        open({ type: 'reasoning', text: content.reasoning } as ReasoningPart)
      }
      isLoading={!content.isDone}
      ariaExpanded={isOpen}
    />
  )

  if (!content) return <DefaultSkeleton />

  // Return null if done and reasoning text is empty
  if (content.isDone && !content.reasoning?.trim()) return null

  // Default path: raw reasoning stays out of the transcript. Render a compact,
  // NON-expandable indicator only — no CollapsibleMessage body, no markdown
  // render of the thoughts, and no inspector-open of the raw text. This covers
  // both the live-streaming path and the reloaded-from-DB path (identical
  // `reasoning` parts flow through here either way), and it applies whether the
  // part renders standalone or grouped inside the research-process accordion.
  if (!showReasoning) {
    return (
      <div className="relative">
        {!isFirst && (
          <div className="absolute left-[19.5px] w-px bg-border h-2 top-0" />
        )}
        {!isLast && (
          <div className="absolute left-[19.5px] w-px bg-border h-2 bottom-0" />
        )}
        <div className="flex items-center gap-2 px-1 py-1 min-w-0">
          <div className="size-4 shrink-0 flex items-center justify-center">
            <div
              className={cn(
                'size-1.5 rounded-full bg-muted-foreground',
                !content.isDone && 'animate-pulse'
              )}
            />
          </div>
          <span className="text-sm text-muted-foreground/80 truncate">
            {content.isDone ? 'Thought' : 'Thinking…'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="relative">
      {/* Rails for header - show based on position */}
      {!isFirst && (
        <div className="absolute left-[19.5px] w-px bg-border h-2 top-0" />
      )}
      {!isLast && (
        <div className="absolute left-[19.5px] w-px bg-border h-2 bottom-0" />
      )}
      <CollapsibleMessage
        role="assistant"
        isCollapsible={true}
        header={reasoningHeader}
        isOpen={isOpen}
        onOpenChange={onOpenChange}
        showBorder={isSingle}
        showIcon={showIcon}
        variant={variant}
        showSeparator={false}
        headerClickBehavior="split"
      >
        <div className="flex">
          {/* Rail space */}
          <div className="w-[16px] shrink-0 flex justify-center">
            <div
              className={cn(
                'w-px bg-border/50 transition-opacity duration-200',
                isOpen ? 'opacity-100' : 'opacity-0'
              )}
              style={{
                marginTop: isFirst ? '0' : '-1rem',
                marginBottom: isLast ? '0' : '-1rem'
              }}
            />
          </div>
          <div className="w-2 shrink-0" />
          <div className="[&_p]:text-xs [&_p]:text-muted-foreground/80 flex-1">
            <MarkdownMessage message={content.reasoning} />
          </div>
        </div>
      </CollapsibleMessage>
    </div>
  )
}
