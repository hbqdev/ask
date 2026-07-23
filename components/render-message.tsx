import { UseChatHelpers } from '@ai-sdk/react'

import type { SearchResultItem } from '@/lib/types'
import type {
  UIDataTypes,
  UIMessage,
  UIMessageMetadata,
  UITools
} from '@/lib/types/ai'
import type { DynamicToolPart } from '@/lib/types/dynamic-tools'

import { AnswerSection } from './answer-section'
import { DynamicToolDisplay } from './dynamic-tool-display'
import { GeneratedImageSection } from './generated-image-section'
import ResearchProcessSection from './research-process-section'
import { UserFileSection } from './user-file-section'
import { UserTextSection } from './user-text-section'

interface RenderMessageProps {
  message: UIMessage
  messageId: string
  getIsOpen: (id: string, partType?: string, hasNextPart?: boolean) => boolean
  onOpenChange: (id: string, open: boolean) => void
  chatId?: string
  isGuest?: boolean
  isCloudDeployment?: boolean
  libraryAvailable?: boolean
  status?: UseChatHelpers<UIMessage<unknown, UIDataTypes, UITools>>['status']
  addToolResult?: (params: { toolCallId: string; result: any }) => void
  onUpdateMessage?: (messageId: string, newContent: string) => Promise<void>
  reload?: (messageId: string) => Promise<void | string | null | undefined>
  onDelete?: () => Promise<void> | void
  isLatestMessage?: boolean
  citationMaps?: Record<string, Record<number, SearchResultItem>>
  onQuoteContext?: (text: string) => void
}

// True while the message's parts end in research activity — the same parts
// the segmentation below buffers into ResearchProcessSection — with no final
// answer text after them, i.e. exactly while that section's live indicator is
// showing. Narration (non-heading text) doesn't end the phase, matching the
// First-token rule used during streaming. chat-messages uses this to keep a
// single Wild Breath mark animated at a time: the footer glyph yields to the
// indicator instead of spinning right below it.
export function endsInActiveResearch(message: UIMessage): boolean {
  let live = false
  for (const part of (message.parts as any[] | undefined) ?? []) {
    if (
      part.type === 'reasoning' ||
      part.type === 'data-classifier' ||
      part.type === 'data-attachments' ||
      (part.type === 'data-recall' && part.data?.chats?.length) ||
      // generateImage renders as a standalone card whose own skeleton is the
      // activity cue — it never joins the research process, so it must not
      // count as research-live here (else the footer glyph would yield to a
      // process indicator that never renders).
      (part.type?.startsWith?.('tool-') && part.type !== 'tool-generateImage')
    ) {
      live = true
    } else if (
      part.type === 'text' &&
      typeof part.text === 'string' &&
      /^#{1,6}\s/.test(part.text.trimStart())
    ) {
      live = false
    }
  }
  return live
}

export function RenderMessage({
  message,
  messageId,
  getIsOpen,
  onOpenChange,
  chatId,
  isGuest = false,
  isCloudDeployment = false,
  libraryAvailable = true,
  status,
  addToolResult,
  onUpdateMessage,
  reload,
  onDelete,
  isLatestMessage = false,
  citationMaps = {},
  onQuoteContext
}: RenderMessageProps) {
  const isNonEmptyTextPart = (part: any) =>
    part?.type === 'text' &&
    typeof part.text === 'string' &&
    part.text.trim().length > 0

  // Use provided citation maps (from all messages)
  if (message.role === 'user') {
    const parts = (message.parts ?? []) as any[]
    const textPart = parts.find((part: any) => part.type === 'text')
    const files = parts.filter((part: any) => part.type === 'file')
    const pastedTexts = parts
      .filter((part: any) => part.type === 'data-pastedContent')
      .map((part: any) => part.data?.text ?? '')
    const quotedContexts = parts
      .filter((part: any) => part.type === 'data-quotedContext')
      .map((part: any) => part.data?.text ?? '')
    const urls = parts
      .filter((part: any) => part.type === 'data-sourceUrl')
      .map((part: any) => part.data?.url ?? '')
    return (
      <>
        {files.map((part: any, index: number) => (
          <UserFileSection
            key={`${messageId}-user-file-${index}`}
            file={{
              name: part.filename || 'Unknown file',
              url: part.url,
              contentType: part.mediaType
            }}
          />
        ))}
        {(textPart ||
          pastedTexts.length > 0 ||
          quotedContexts.length > 0 ||
          urls.length > 0) && (
          <UserTextSection
            content={textPart?.text ?? ''}
            pastedTexts={pastedTexts}
            quotedContexts={quotedContexts}
            urls={urls}
            messageId={messageId}
            onUpdateMessage={onUpdateMessage}
          />
        )}
      </>
    )
  }

  // New rendering: interleave text parts with grouped non-text segments
  const elements: React.ReactNode[] = []
  let buffer: any[] = []

  // Only the latest assistant message can actually be streaming. Keying this
  // off the GLOBAL chat status instead would make every earlier, already-
  // finished message re-enter "still streaming" rendering whenever a NEW turn
  // runs — the first-token heading gate below would then suppress any prior
  // answer that doesn't start with a heading, and its research process would
  // light up as "Working on it" (the "double search" UI bug). Scope it to
  // this specific message.
  const isThisMessageStreaming =
    Boolean(isLatestMessage) &&
    (status === 'streaming' || status === 'submitted')
  const isStreamingComplete = !isThisMessageStreaming

  const flushBuffer = (keySuffix: string, hasSubsequentText = false) => {
    if (buffer.length === 0) return
    elements.push(
      <ResearchProcessSection
        key={`${messageId}-proc-${keySuffix}`}
        message={message}
        messageId={messageId}
        parts={buffer}
        getIsOpen={getIsOpen}
        onOpenChange={onOpenChange}
        status={status}
        isLatestMessage={isLatestMessage}
        addToolResult={addToolResult}
        hasSubsequentText={hasSubsequentText}
      />
    )
    buffer = []
  }

  message.parts?.forEach((part: any, index: number) => {
    if (part.type === 'text') {
      // Ignore empty text chunks (some providers emit them before reasoning/tool parts).
      if (!isNonEmptyTextPart(part)) {
        return
      }

      const remainingParts = message.parts?.slice(index + 1) || []
      const hasMoreTextParts = remainingParts.some(isNonEmptyTextPart)
      const isLastTextPart = !hasMoreTextParts

      // Interim narration between tool rounds (e.g. "Let me start
      // researching...", "Excellent! Let me update todos...") is process
      // chatter, not user-facing content. Once streaming is finished we
      // know the whole parts array, so "is this the last text part" is a
      // reliable check. But *while still streaming*, nothing has followed
      // the current text part *yet* — that's inherent to live streaming —
      // so "last so far" can't distinguish real final content from
      // narration that a tool call will follow a moment later. Instead,
      // lean on the "First-token rule" every mode's prompt enforces: the
      // true final answer must start with a markdown heading, and nothing
      // else may. That's knowable immediately, without waiting for more
      // parts to arrive, so it's what mutes interim narration during
      // streaming instead of letting it flash on screen first.
      const looksLikeFinalAnswer = /^#{1,6}\s/.test(part.text.trimStart())
      const shouldRenderAsAnswer = isStreamingComplete
        ? isLastTextPart
        : looksLikeFinalAnswer

      if (!shouldRenderAsAnswer) {
        return
      }

      // Flush accumulated non-text first, marking that text follows
      if (buffer.length > 0) {
        flushBuffer(`seg-${index}`, true)
      }

      const shouldShowActions =
        isLastTextPart && (isLatestMessage ? isStreamingComplete : true)

      elements.push(
        <AnswerSection
          key={`${messageId}-text-${index}`}
          content={part.text}
          isOpen={getIsOpen(
            messageId,
            part.type,
            index < (message.parts?.length ?? 0) - 1
          )}
          onOpenChange={open => onOpenChange(messageId, open)}
          chatId={chatId}
          isGuest={isGuest}
          isCloudDeployment={isCloudDeployment}
          libraryAvailable={libraryAvailable}
          showActions={shouldShowActions}
          messageId={messageId}
          metadata={message.metadata as UIMessageMetadata | undefined}
          reload={reload}
          onDelete={onDelete}
          status={status}
          citationMaps={citationMaps}
          onQuoteContext={onQuoteContext}
        />
      )
    } else if (part.type === 'tool-generateImage') {
      // Generated images are answer content, not research process — they
      // render standalone, never buried in the collapsed accordion.
      flushBuffer(`seg-${index}`)
      elements.push(
        <GeneratedImageSection
          key={`${messageId}-genimg-${index}`}
          part={part as any}
        />
      )
    } else if (
      part.type === 'reasoning' ||
      part.type === 'data-classifier' ||
      part.type === 'data-attachments' ||
      // Recall attribution rides inside the research process as one of its
      // steps (user preference: the answer view stays clean; the past-chat
      // links are found under "Completed N steps"). Empty recall parts are
      // dropped so they can't render a blank step.
      (part.type === 'data-recall' && part.data?.chats?.length) ||
      // tool-generateImage is handled by the standalone branch above; every
      // other tool-* part is research process and buffers into the accordion.
      (part.type?.startsWith?.('tool-') && part.type !== 'tool-generateImage')
    ) {
      buffer.push(part)
    } else if (part.type === 'dynamic-tool') {
      flushBuffer(`seg-${index}`)
      elements.push(
        <DynamicToolDisplay
          key={`${messageId}-dynamic-tool-${index}`}
          part={part as DynamicToolPart}
        />
      )
    }
  })
  // Flush tail (no subsequent text)
  flushBuffer('tail')

  return <>{elements}</>
}
