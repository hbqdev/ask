'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

import { UseChatHelpers } from '@ai-sdk/react'

import { useMediaQuery } from '@/lib/hooks/use-media-query'
import type { UIDataTypes, UIMessage, UITools } from '@/lib/types/ai'
import { cn } from '@/lib/utils'
import { extractCitationMaps } from '@/lib/utils/citation'

import { WildBreathGlyph } from './ui/wild-breath-logo'
import { ChatError } from './chat-error'
import { ChatFooterMessage } from './chat-footer-message'
import { endsInActiveResearch, RenderMessage } from './render-message'

// Import section structure interface
interface ChatSection {
  id: string
  userMessage: UIMessage
  assistantMessages: UIMessage[]
}

interface ChatMessagesProps {
  sections: ChatSection[] // Changed from messages to sections
  status: UseChatHelpers<UIMessage<unknown, UIDataTypes, UITools>>['status']
  chatId?: string
  isGuest?: boolean
  isCloudDeployment?: boolean
  libraryAvailable?: boolean
  addToolResult?: (params: { toolCallId: string; result: any }) => void
  /** Ref for the scroll container */
  scrollContainerRef: React.RefObject<HTMLDivElement>
  onUpdateMessage?: (messageId: string, newContent: string) => Promise<void>
  reload?: (messageId: string) => Promise<void | string | null | undefined>
  onDeleteSection?: (section: ChatSection) => void | Promise<void>
  error?: Error | string | null | undefined
  onQuoteContext?: (text: string) => void
}

const DESKTOP_LATEST_SECTION_OFFSET = 196
const MOBILE_LATEST_SECTION_OFFSET_FALLBACK = 180
const MOBILE_FOLLOW_UP_TOP_CLEARANCE_FALLBACK = 56

export function ChatMessages({
  sections,
  status,
  chatId,
  isGuest = false,
  isCloudDeployment = false,
  libraryAvailable = true,
  addToolResult,
  scrollContainerRef,
  onUpdateMessage,
  reload,
  onDeleteSection,
  error,
  onQuoteContext
}: ChatMessagesProps) {
  // Track user-modified states (when user explicitly opens/closes)
  const [userModifiedStates, setUserModifiedStates] = useState<
    Record<string, boolean>
  >({})
  // Cache tool counts for performance optimization
  const toolCountCacheRef = useRef<Map<string, number>>(new Map())
  const isLoading = status === 'submitted' || status === 'streaming'
  const isMobile = useMediaQuery('(max-width: 767px)')
  const [scrollViewportHeight, setScrollViewportHeight] = useState(0)
  const [mobileFollowUpTopClearance, setMobileFollowUpTopClearance] = useState(
    MOBILE_FOLLOW_UP_TOP_CLEARANCE_FALLBACK
  )

  // Tool types definition - moved outside function for performance
  const toolTypes = ['tool-search', 'tool-fetch', 'tool-askQuestion']

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const updateMetrics = () => {
      const { paddingTop } = getComputedStyle(container)
      setScrollViewportHeight(container.clientHeight)
      setMobileFollowUpTopClearance(
        parseFloat(paddingTop) || MOBILE_FOLLOW_UP_TOP_CLEARANCE_FALLBACK
      )
    }
    updateMetrics()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateMetrics)
    observer.observe(container)

    return () => observer.disconnect()
  }, [scrollContainerRef])

  // Clear cache during streaming to ensure accurate tool counts
  useEffect(() => {
    if (isLoading) {
      // Clear cache for all messages during streaming
      toolCountCacheRef.current.clear()
    }
  }, [isLoading])

  const latestSectionMinHeight =
    isMobile && scrollViewportHeight > 0
      ? `${Math.max(0, scrollViewportHeight - mobileFollowUpTopClearance)}px`
      : `calc(100dvh - ${
          isMobile
            ? MOBILE_LATEST_SECTION_OFFSET_FALLBACK
            : DESKTOP_LATEST_SECTION_OFFSET
        }px)`

  // Citation maps are built PER MESSAGE, keyed by message id — never merged
  // across the conversation.
  //
  // A citation can only be supported by a search that same turn ran, so a
  // conversation-wide map is not a convenience, it is the bug: an anchor the
  // model carried over from an earlier turn found that turn's map and resolved
  // cleanly to the wrong source. Measured across prod's history, 120 of 2,975
  // anchors (4%) named a tool call belonging to a different message and
  // rendered a confidently wrong domain and link.
  //
  // Scoped this way an out-of-turn anchor matches nothing, so processCitations
  // returns '' and the citation is dropped. Silently absent is strictly better
  // than confidently wrong, and citations_unresolved on the [latency] line now
  // counts how often it happens.
  const citationMapsByMessage = useMemo(() => {
    const byId: Record<string, ReturnType<typeof extractCitationMaps>> = {}
    sections.forEach(section => {
      byId[section.userMessage.id] = extractCitationMaps(section.userMessage)
      section.assistantMessages.forEach(assistantMessage => {
        byId[assistantMessage.id] = extractCitationMaps(assistantMessage)
      })
    })
    return byId
  }, [sections])

  if (!sections.length) return null

  // Keep the assistant logo visible for the latest section after generation
  const latestSection = sections.at(-1)
  const latestAssistantMessage = latestSection?.assistantMessages.at(-1)
  // While the research indicator is live it is the single animated mark on
  // screen — the footer glyph spinning right below it read as a redundant
  // second logo. It still covers the gap before research starts (no parts
  // yet) and returns once the answer streams.
  const researchIndicatorLive =
    isLoading &&
    latestAssistantMessage != null &&
    endsInActiveResearch(latestAssistantMessage)
  const showAssistantLogo = Boolean(
    latestSection &&
      !researchIndicatorLive &&
      (isLoading || latestSection.assistantMessages.length > 0)
  )

  // Helper function to get tool count with caching
  const getToolCount = (message?: UIMessage): number => {
    if (!message || !message.id) return 0

    // During streaming, always recalculate
    if (isLoading) {
      const count =
        message.parts?.filter(part => toolTypes.includes(part.type)).length || 0
      return count
    }

    // Check cache first when not streaming
    const cached = toolCountCacheRef.current.get(message.id)
    if (cached !== undefined) {
      return cached
    }

    // Calculate and cache
    const count =
      message.parts?.filter(part => toolTypes.includes(part.type)).length || 0
    toolCountCacheRef.current.set(message.id, count)
    return count
  }

  const getIsOpen = (
    id: string,
    partType?: string,
    hasNextPart?: boolean,
    message?: UIMessage
  ) => {
    // If user has explicitly modified this state, use that
    if (userModifiedStates.hasOwnProperty(id)) {
      return userModifiedStates[id]
    }

    // For tool types, check if there are multiple tools
    if (partType && toolTypes.includes(partType)) {
      const toolCount = getToolCount(message)
      // If multiple tools exist, default to closed
      if (toolCount > 1) {
        return false
      }
      // Single tool results stay open even if more content follows
      return true
    }

    // For tool-invocations, default to open
    if (partType === 'tool-invocation') {
      return true
    }

    // For reasoning, auto-collapse if there's a next part in the same message
    if (partType === 'reasoning') {
      return !hasNextPart
    }

    // For other types (like text), default to open
    return true
  }

  const handleOpenChange = (id: string, open: boolean) => {
    setUserModifiedStates(prev => ({
      ...prev,
      [id]: open
    }))
  }

  return (
    <div
      id="scroll-container"
      ref={scrollContainerRef}
      role="list"
      aria-roledescription="chat messages"
      className={cn(
        'relative size-full pt-14',
        sections.length > 0 ? 'flex-1 overflow-y-auto' : ''
      )}
    >
      <div className="relative mx-auto w-full max-w-full md:max-w-3xl px-4">
        {sections.map((section, sectionIndex) => (
          <div
            key={section.id}
            id={`section-${section.id}`}
            className="chat-section scroll-mt-14 pb-4 md:pb-14"
            style={
              sectionIndex === sections.length - 1
                ? { minHeight: latestSectionMinHeight }
                : {}
            }
          >
            {/* User message */}
            <div className="flex flex-col gap-2 md:gap-4 mb-2 md:mb-4">
              <RenderMessage
                message={section.userMessage}
                messageId={section.userMessage.id}
                getIsOpen={(id, partType, hasNextPart) =>
                  getIsOpen(id, partType, hasNextPart, section.userMessage)
                }
                onOpenChange={handleOpenChange}
                chatId={chatId}
                isGuest={isGuest}
                isCloudDeployment={isCloudDeployment}
                libraryAvailable={libraryAvailable}
                status={status}
                addToolResult={addToolResult}
                onUpdateMessage={onUpdateMessage}
                reload={reload}
                citationMaps={citationMapsByMessage[section.userMessage.id]}
                onQuoteContext={onQuoteContext}
              />
            </div>

            {/* Assistant messages */}
            {section.assistantMessages.map((assistantMessage, messageIndex) => {
              const isLatestMessage =
                sectionIndex === sections.length - 1 &&
                messageIndex === section.assistantMessages.length - 1

              return (
                <div
                  key={assistantMessage.id}
                  className="flex flex-col gap-2 md:gap-4"
                >
                  <RenderMessage
                    message={assistantMessage}
                    messageId={assistantMessage.id}
                    getIsOpen={(id, partType, hasNextPart) =>
                      getIsOpen(id, partType, hasNextPart, assistantMessage)
                    }
                    onOpenChange={handleOpenChange}
                    chatId={chatId}
                    isGuest={isGuest}
                    isCloudDeployment={isCloudDeployment}
                    libraryAvailable={libraryAvailable}
                    status={status}
                    addToolResult={addToolResult}
                    onUpdateMessage={onUpdateMessage}
                    reload={reload}
                    onDelete={
                      onDeleteSection
                        ? () => onDeleteSection(section)
                        : undefined
                    }
                    isLatestMessage={isLatestMessage}
                    citationMaps={citationMapsByMessage[assistantMessage.id]}
                    onQuoteContext={onQuoteContext}
                  />
                </div>
              )
            })}
            {/* Show assistant logo and footer message after assistant messages */}
            {showAssistantLogo && sectionIndex === sections.length - 1 && (
              <div className="wb-footer-in flex items-center gap-3 py-1 md:py-4">
                <WildBreathGlyph
                  className="size-10 shrink-0"
                  spin={isLoading}
                />
                <ChatFooterMessage isLoading={isLoading} />
              </div>
            )}
            {sectionIndex === sections.length - 1 && (
              <ChatError error={error} />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
