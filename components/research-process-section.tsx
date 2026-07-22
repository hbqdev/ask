'use client'

import { useCallback, useEffect, useState } from 'react'

import type { ReasoningPart } from '@ai-sdk/provider-utils'
import { UseChatHelpers } from '@ai-sdk/react'
import { IconChevronDown as ChevronDown } from '@tabler/icons-react'

import type { ToolPart, UIDataTypes, UIMessage, UITools } from '@/lib/types/ai'
import type { DynamicToolPart } from '@/lib/types/dynamic-tools'
import { cn } from '@/lib/utils'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from './ui/collapsible'
import { WildBreathGlyph } from './ui/wild-breath-logo'
import { type AttachmentsPart, AttachmentsSection } from './attachments-section'
import { type ClassifierPart, ClassifierSection } from './classifier-section'
import { ReasoningSection } from './reasoning-section'
import { ToolSection } from './tool-section'

// Message part types
type TextPart = {
  type: 'text'
  text: string
}

type MessagePart =
  | ReasoningPart
  | ToolPart
  | TextPart
  | DynamicToolPart
  | ClassifierPart
  | AttachmentsPart

// Type guards
function isReasoningPart(part: MessagePart): part is ReasoningPart {
  return part.type === 'reasoning'
}

function isClassifierPart(part: MessagePart): part is ClassifierPart {
  return part.type === 'data-classifier'
}

function isAttachmentsPart(part: MessagePart): part is AttachmentsPart {
  return part.type === 'data-attachments'
}

function isToolPart(part: MessagePart): part is ToolPart {
  return (
    (part.type?.startsWith?.('tool-') && part.type !== 'dynamic-tool') ?? false
  )
}

function isTextPart(part: MessagePart): part is TextPart {
  return part.type === 'text'
}

function isNonEmptyTextPart(part: MessagePart): part is TextPart {
  return isTextPart(part) && part.text.trim().length > 0
}

function isRenderablePart(part: MessagePart): boolean {
  if (isReasoningPart(part) || isTextPart(part)) {
    return part.text.trim().length > 0
  }
  return true
}

type Props = {
  message: UIMessage
  messageId: string
  getIsOpen: (id: string, partType?: string, hasNextPart?: boolean) => boolean
  onOpenChange: (id: string, open: boolean) => void
  status?: UseChatHelpers<UIMessage<unknown, UIDataTypes, UITools>>['status']
  /**
   * Whether this is the latest assistant message — the only one that can
   * actually be streaming. `status` is the single global chat status, so it
   * cannot by itself distinguish the message being generated from earlier,
   * finished ones. Without this gate, every prior turn's process section
   * would show "Working on it" whenever a new turn runs (the "double search"
   * UI bug).
   */
  isLatestMessage?: boolean
  addToolResult?: (params: { toolCallId: string; result: any }) => void
  parts?: MessagePart[]
  hasSubsequentText?: boolean
}

/**
 * Splits message parts into segments, where each segment contains
 * non-text parts between text parts
 * @param parts - Array of message parts to split
 * @returns Array of segments (arrays of non-text parts)
 */
function splitByText(parts: MessagePart[]): MessagePart[][] {
  const segments: MessagePart[][] = []
  let currentSegment: MessagePart[] = []

  for (const part of parts || []) {
    if (isNonEmptyTextPart(part)) {
      // When we hit a text part, save the current segment if it has content
      if (currentSegment.length > 0) {
        segments.push(currentSegment)
        currentSegment = []
      }
    } else {
      // Accumulate non-text parts
      currentSegment.push(part)
    }
  }

  // Don't forget the last segment
  if (currentSegment.length > 0) {
    segments.push(currentSegment)
  }

  return segments
}

/**
 * Groups consecutive tool parts of the same type together
 * @param segment - Array of message parts within a segment
 * @returns Array of grouped parts
 */
function groupConsecutiveParts(segment: MessagePart[]): MessagePart[][] {
  if (segment.length === 0) return []

  const groups: MessagePart[][] = []
  let currentIndex = 0

  while (currentIndex < segment.length) {
    const currentPart = segment[currentIndex]

    if (isToolPart(currentPart)) {
      // Group consecutive tool parts of the same type
      const toolGroup = [currentPart]
      const toolType = currentPart.type

      let nextIndex = currentIndex + 1
      while (
        nextIndex < segment.length &&
        segment[nextIndex].type === toolType
      ) {
        toolGroup.push(segment[nextIndex] as ToolPart)
        nextIndex++
      }

      groups.push(toolGroup)
      currentIndex = nextIndex
    } else {
      // Non-tool parts stay as single-item groups
      groups.push([currentPart])
      currentIndex++
    }
  }

  return groups
}

/**
 * Custom hook for managing accordion state in grouped sections
 */
function useAccordionState(onOpenChange: (id: string, open: boolean) => void) {
  const [openSectionId, setOpenSectionId] = useState<string | null>(null)

  const handleAccordionChange = useCallback(
    (id: string, open: boolean, isSingle: boolean) => {
      if (isSingle) {
        // For single sections, use the original behavior
        onOpenChange(id, open)
      } else {
        // For grouped sections, implement accordion behavior
        if (open) {
          setOpenSectionId(id)
        } else {
          setOpenSectionId(null)
        }
        // Still notify parent for tracking purposes
        onOpenChange(id, open)
      }
    },
    [onOpenChange]
  )

  return { openSectionId, handleAccordionChange }
}

/**
 * Renders a single part (reasoning, tool, or data)
 */
function RenderPart({
  part,
  partId,
  hasNext,
  hasSubsequentContent,
  isSingle,
  isFirstGroup,
  isLastGroup,
  groupLength,
  partIndex,
  getIsOpen,
  openSectionId,
  handleAccordionChange,
  status,
  addToolResult
}: {
  part: MessagePart
  partId: string
  hasNext: boolean
  hasSubsequentContent: boolean
  isSingle: boolean
  isFirstGroup: boolean
  isLastGroup: boolean
  groupLength: number
  partIndex: number
  getIsOpen: (id: string, partType?: string, hasNextPart?: boolean) => boolean
  openSectionId: string | null
  handleAccordionChange: (id: string, open: boolean, isSingle: boolean) => void
  status?: any
  addToolResult?: (params: { toolCallId: string; result: any }) => void
}) {
  const hasSubsequent = hasNext || hasSubsequentContent

  if (isClassifierPart(part)) {
    return <ClassifierSection part={part} />
  }

  if (isAttachmentsPart(part)) {
    return <AttachmentsSection part={part} />
  }

  if (isReasoningPart(part)) {
    const isOpen = isSingle
      ? getIsOpen(partId, 'reasoning', hasSubsequent)
      : openSectionId === partId

    return (
      <ReasoningSection
        content={{ reasoning: part.text, isDone: !hasNext }}
        isOpen={isOpen}
        onOpenChange={open => handleAccordionChange(partId, open, isSingle)}
        isSingle={isSingle}
        isFirst={isFirstGroup && partIndex === 0}
        isLast={isLastGroup && partIndex === groupLength - 1}
      />
    )
  }

  if (isToolPart(part)) {
    const isOpen = isSingle
      ? getIsOpen(part.toolCallId, part.type, hasSubsequent)
      : openSectionId === part.toolCallId

    return (
      <ToolSection
        tool={part}
        isOpen={isOpen}
        onOpenChange={open =>
          handleAccordionChange(part.toolCallId, open, isSingle)
        }
        status={status}
        addToolResult={addToolResult}
        borderless={!isSingle}
        isFirst={isFirstGroup && partIndex === 0}
        isLast={isLastGroup && partIndex === groupLength - 1}
      />
    )
  }

  return null
}

/**
 * Determines if there's content after a given segment
 * @param segmentIndex - The index of the current segment
 * @param segments - All segments
 * @param messageParts - Original message parts
 * @returns true if there's subsequent content
 */
function useHasSubsequentContent(
  segments: MessagePart[][],
  messageParts: MessagePart[] | undefined
) {
  return useCallback(
    (segmentIndex: number): boolean => {
      // Check if there are more segments after this one
      if (segmentIndex < segments.length - 1) {
        return true
      }

      // Check if there are text parts after the last segment in the original message parts
      const lastSegment = segments[segmentIndex]
      if (!lastSegment || lastSegment.length === 0) {
        return false
      }

      const lastPartInSegment = lastSegment[lastSegment.length - 1]
      const remainingParts =
        messageParts?.slice(
          messageParts.findIndex(p => p === lastPartInSegment) + 1
        ) || []

      return remainingParts.some(p => isTextPart(p))
    },
    [segments, messageParts]
  )
}

export function ResearchProcessSection({
  message,
  messageId,
  getIsOpen,
  onOpenChange,
  status,
  isLatestMessage = false,
  addToolResult,
  parts: partsOverride,
  hasSubsequentText = false
}: Props) {
  const allParts = (partsOverride ?? (message.parts || [])) as MessagePart[]

  // Filter out empty reasoning/text parts to avoid incorrect grouping
  const filteredParts = allParts.filter(isRenderablePart)
  const filteredMessageParts = ((message.parts || []) as MessagePart[]).filter(
    isRenderablePart
  )

  const segments = partsOverride ? [filteredParts] : splitByText(filteredParts)

  // Use custom hook for accordion state management
  const { openSectionId, handleAccordionChange } =
    useAccordionState(onOpenChange)

  // Use custom hook for subsequent content detection
  const hasSubsequentContent = useHasSubsequentContent(
    segments,
    filteredMessageParts
  )

  // State for parent collapsible (when segment has 5+ parts)
  // Auto-collapse when text generation starts (hasSubsequentText is true)
  const [parentOpenStates, setParentOpenStates] = useState<
    Record<string, boolean>
  >({})

  // While research runs, the summary text ("Working on it — N steps so far")
  // is hidden behind the animated Wild Breath indicator: clicking the
  // indicator reveals the summary, clicking the summary opens the steps.
  // Completed segments always show their summary (old chats render as
  // before).
  const [summaryShownStates, setSummaryShownStates] = useState<
    Record<string, boolean>
  >({})

  // Still actively researching: this is the message currently being
  // generated, no text has followed this segment yet, and the chat hasn't
  // finished streaming. Matches Perplexity's live status line before the
  // answer starts. `isLatestMessage` is essential — `status` alone is the
  // global chat status and would mark every earlier turn as in-progress
  // whenever a new turn runs.
  const isInProgress =
    isLatestMessage &&
    !hasSubsequentText &&
    (status === 'streaming' || status === 'submitted')

  // Peek open for a couple seconds when research starts so the user sees
  // it's doing something, then auto-collapse to just the pulsing summary
  // line — a research run can take minutes, and it shouldn't stay expanded
  // scrolling live updates the whole time. Never resets back open once
  // triggered; the summary line keeps updating its step count regardless.
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  useEffect(() => {
    if (!isInProgress || autoCollapsed) return
    const timer = setTimeout(() => setAutoCollapsed(true), 2000)
    return () => clearTimeout(timer)
  }, [isInProgress, autoCollapsed])

  if (segments.length === 0 || segments.every(seg => seg.length === 0))
    return null

  return (
    <div className="space-y-2">
      {segments.map((seg, sidx) => {
        const groups = groupConsecutiveParts(seg)
        const isSingle = groups.length === 1 && groups[0].length === 1
        const containerClass = cn(!isSingle && 'rounded-lg border bg-card')

        // Count total parts in this segment
        const totalParts = seg.length

        // Parent collapsible ID
        const parentId = `${messageId}-parent-${sidx}`
        // If user has explicitly set state, use that; otherwise: closed
        // once text follows, open for an initial 2-second peek while
        // actively researching (then auto-collapsed), open by default in
        // the rare case research ended with no answer following at all.
        const isParentOpen =
          parentOpenStates[parentId] ??
          (hasSubsequentText ? false : isInProgress ? !autoCollapsed : true)

        const segmentContent = (
          <div className={containerClass}>
            {groups.map((grp, gidx) => (
              <div key={`${messageId}-grp-${sidx}-${gidx}`}>
                {grp.map((part, pidx) => {
                  const partId = isToolPart(part)
                    ? part.toolCallId
                    : `${messageId}-${part.type}-${sidx}-${gidx}-${pidx}`

                  return (
                    <RenderPart
                      key={partId}
                      part={part}
                      partId={partId}
                      hasNext={pidx < grp.length - 1}
                      hasSubsequentContent={hasSubsequentContent(sidx)}
                      isSingle={isSingle}
                      isFirstGroup={gidx === 0}
                      isLastGroup={gidx === groups.length - 1}
                      groupLength={grp.length}
                      partIndex={pidx}
                      getIsOpen={getIsOpen}
                      openSectionId={openSectionId}
                      handleAccordionChange={handleAccordionChange}
                      status={status}
                      addToolResult={addToolResult}
                    />
                  )
                })}
              </div>
            ))}
          </div>
        )

        // Always summarize behind a single "Completed N steps" line —
        // never render the step list unwrapped, regardless of count.
        //
        // While in progress the summary hides behind the animated Wild
        // Breath indicator (spinning glyph + comet rail). Progressive
        // disclosure: indicator → summary text → step list. The steps are
        // never open without their summary row anchoring them, so the
        // initial 2s peek shows summary+steps, then both retreat to the
        // indicator alone.
        const summaryShown = summaryShownStates[parentId] ?? false
        const summaryVisible = !isInProgress || summaryShown || isParentOpen

        return (
          <Collapsible
            key={`${messageId}-seg-${sidx}`}
            open={isParentOpen}
            onOpenChange={open => {
              setParentOpenStates(prev => ({ ...prev, [parentId]: open }))
            }}
          >
            <div className="flex items-center gap-1">
              {isInProgress && (
                <button
                  type="button"
                  onClick={() => {
                    if (summaryVisible) {
                      // Full retreat: hide the summary and close the steps.
                      setSummaryShownStates(prev => ({
                        ...prev,
                        [parentId]: false
                      }))
                      setParentOpenStates(prev => ({
                        ...prev,
                        [parentId]: false
                      }))
                    } else {
                      setSummaryShownStates(prev => ({
                        ...prev,
                        [parentId]: true
                      }))
                    }
                  }}
                  aria-expanded={summaryVisible}
                  aria-label={
                    summaryVisible
                      ? 'Hide research status'
                      : 'Show research status'
                  }
                  title={summaryVisible ? 'Hide status' : 'Show status'}
                  className="flex items-center gap-2 px-1 py-1 rounded-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <WildBreathGlyph className="size-4 shrink-0" spin />
                  {!summaryVisible && (
                    <span className="wb-rail" aria-hidden="true" />
                  )}
                </button>
              )}
              {summaryVisible && (
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'flex items-center px-1 py-0.5 gap-2 text-sm rounded-lg group',
                      isInProgress && 'wb-summary-in'
                    )}
                  >
                    <span className="font-medium text-muted-foreground group-hover:text-muted-foreground/70">
                      {isInProgress
                        ? `Working on it — ${totalParts} step${totalParts === 1 ? '' : 's'} so far`
                        : `Completed ${totalParts} step${totalParts === 1 ? '' : 's'}`}
                    </span>
                    <ChevronDown
                      className={cn(
                        'size-4 text-muted-foreground group-hover:text-muted-foreground/70 transition-transform duration-200',
                        isParentOpen && 'rotate-180'
                      )}
                    />
                  </button>
                </CollapsibleTrigger>
              )}
            </div>
            <CollapsibleContent className="data-[state=closed]:animate-collapse-up data-[state=open]:animate-collapse-down">
              <div className="pt-2">{segmentContent}</div>
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}

export default ResearchProcessSection
