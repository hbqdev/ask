// One answer in the thread: its research, answer text (with the images its
// spec fences carry) and generated images in order, then the related
// questions and the actions. Laid out by layoutAssistantMessage, the same
// rules as the web's render-message. A fresh answer (to the question just
// sent) that carries a spoken answer is read aloud once, if its screen is
// shown, as the web's SpeakButton auto-plays the data-spokenGist part.

import type { UIMessage } from 'ai'
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef
} from 'react'

import { useTabActive } from '@/app/Tabs'
import { useScreenActive } from '@/core/nav/stack'
import { GeneratedImage } from '@/features/thread/components/GeneratedImage'
import {
  MessageActions,
  type ChatLink
} from '@/features/thread/components/MessageActions'
import { RelatedQuestions } from '@/features/thread/components/RelatedQuestions'
import { ResearchSection } from '@/features/thread/components/ResearchSection'
import { SpecImages } from '@/features/thread/components/SpecImages'
import {
  listSources,
  renderableAnswer
} from '@/features/thread/model/citations'
import {
  layoutAssistantMessage,
  type Block
} from '@/features/thread/model/layout'
import { extractSpecContent } from '@/features/thread/model/spec'
import { useReadAloud } from '@/features/voice/useReadAloud'
import { extractCitationMaps } from '@/lib/utils/citation'

export type AssistantTurnProps = {
  message: UIMessage
  /** This turn is still streaming (isTurnStreaming). */
  streaming: boolean
  /** This is the thread's last message. */
  isLatest: boolean
  /** The user's question this message answers. */
  question: string
  /** Asks a related question. */
  onAsk: (query: string) => void
  /** Retries an answer: called with this message's id. */
  onRetry: (messageId: string) => void
  /** The API base, which generated image paths are relative to. */
  baseUrl: string
  /**
   * This answer is fresh: just given to a question sent from this screen.
   * Its spoken answer is then read aloud by itself.
   */
  autoRead?: boolean
  /** Makes the chat's public link; absent while the chat isn't saved. */
  linkToChat?: () => Promise<ChatLink>
  /** Saves answers to notes; absent where notes can't be saved. */
  notes?: AnswerNotes
}

/** Saving a thread's answers to notes. Pass a stable object. */
export type AnswerNotes = {
  /** Whether the answer `messageId` was saved already. */
  isSaved(messageId: string): boolean
  /** Saves the answer `messageId`, as `content`, to notes. */
  save(messageId: string, content: string): Promise<void>
}

type AnswerBlock = Extract<Block, { kind: 'answer' }>

/** The answer cleaned for speech that the server streams with voice on. */
function spokenAnswerOf(message: UIMessage): string {
  for (const part of message.parts) {
    if (part.type !== 'data-spokenGist') continue
    const text = (part.data as { text?: unknown } | undefined)?.text
    return typeof text === 'string' ? text : ''
  }
  return ''
}

// The markdown renderer (Streamdown, KaTeX) is most of the app's JS, so it
// loads in its own chunk: launch to the home composer never waits on it.
const loadAnswerMarkdown = () =>
  import('@/features/thread/components/AnswerMarkdown')

/**
 * AnswerMarkdown in its own chunk. Render it in a Suspense with PlainAnswer
 * as the fallback, as an answer is (a note's screen does too).
 */
export const LazyAnswerMarkdown = lazy(() =>
  loadAnswerMarkdown().then(m => ({ default: m.AnswerMarkdown }))
)

/** Starts loading the answer renderer, so it is ready by the first answer. */
export function preloadAnswerRenderer(): Promise<void> {
  return loadAnswerMarkdown().then(() => {})
}

/** Shown while an answer is on its way but has nothing to show yet. */
export function Thinking() {
  return (
    <div role="status" aria-label="Thinking" className="flex gap-1.5 py-2">
      <span className="size-2 animate-pulse rounded-full bg-mark-blue" />
      <span className="size-2 animate-pulse rounded-full bg-mark-violet [animation-delay:150ms]" />
      <span className="size-2 animate-pulse rounded-full bg-mark-orange [animation-delay:300ms]" />
    </div>
  )
}

/** The answer as plain text for the moment the renderer is still loading. */
export function PlainAnswer({ text }: { text: string }) {
  return <div className="answer-prose whitespace-pre-wrap">{text}</div>
}

// Off-screen turns skip layout and paint; `auto` keeps each turn's last
// rendered height as its placeholder, so the scroll position holds.
const TURN_STYLE = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 600px'
} as const

/**
 * Memoized: while the latest turn streams, earlier turns (whose message
 * objects don't change) skip re-rendering, given stable callbacks.
 */
export const AssistantTurn = memo(function AssistantTurn({
  message,
  streaming,
  isLatest,
  question,
  onAsk,
  onRetry,
  baseUrl,
  autoRead = false,
  linkToChat,
  notes
}: AssistantTurnProps) {
  const blocks = useMemo(
    () => layoutAssistantMessage(message, streaming),
    [message, streaming]
  )
  const maps = useMemo(() => extractCitationMaps(message), [message])
  const sources = useMemo(() => listSources(message), [message])

  const finalAnswer =
    blocks.findLast((b): b is AnswerBlock => b.kind === 'answer')?.text ?? ''
  const related = useMemo(
    () => extractSpecContent(finalAnswer).related,
    [finalAnswer]
  )
  const showActions = !(isLatest && streaming)

  const messageId = message.id
  const saveNote = useCallback(
    (content: string) => notes!.save(messageId, content),
    [notes, messageId]
  )

  // Read aloud from the actions, or by itself once when fresh. An answer
  // that becomes fresh while its screen is hidden is never read by itself.
  const readAloud = useReadAloud(message.id)
  const { read } = readAloud
  const tabShown = useTabActive()
  const screenShown = useScreenActive()
  const shown = tabShown && screenShown
  const spoken = spokenAnswerOf(message)
  const autoReadDone = useRef(false)
  useEffect(() => {
    if (!autoRead || !spoken || autoReadDone.current) return
    autoReadDone.current = true
    if (shown) read(spoken)
  }, [autoRead, spoken, shown, read])

  return (
    <article className="flex flex-col gap-3" style={TURN_STYLE}>
      {streaming && blocks.length === 0 && <Thinking />}
      {blocks.map((block, i) => {
        if (block.kind === 'research') {
          return (
            <ResearchSection key={i} parts={block.parts} live={block.live} />
          )
        }
        if (block.kind === 'image') {
          return <GeneratedImage key={i} part={block.part} baseUrl={baseUrl} />
        }
        const answer = renderableAnswer(block.text, maps)
        return (
          <div key={i} className="flex flex-col gap-3">
            <Suspense fallback={<PlainAnswer text={answer} />}>
              <LazyAnswerMarkdown
                text={answer}
                sources={sources}
                streaming={streaming}
              />
            </Suspense>
            <SpecImages images={extractSpecContent(block.text).images} />
          </div>
        )
      })}
      <RelatedQuestions queries={related} disabled={streaming} onAsk={onAsk} />
      {showActions && (
        <MessageActions
          text={finalAnswer}
          maps={maps}
          question={question}
          sources={sources}
          onRetry={() => onRetry(message.id)}
          readAloud={readAloud}
          linkToChat={linkToChat}
          onSaveNote={notes && saveNote}
          noteSaved={notes?.isSaved(messageId)}
        />
      )}
    </article>
  )
})
