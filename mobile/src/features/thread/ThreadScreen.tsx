// One chat: a header (back, title, sources), the turns, and a composer for
// follow-ups. The list follows the answer as it streams unless the user has
// scrolled up to read, when "Jump to latest" brings them back.

import type { UIMessage } from 'ai'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { useAuth } from '@/core/auth/AuthProvider'
import { newId } from '@/core/ids'
import { useStack, type Stack } from '@/core/nav/stack'
import { Composer } from '@/features/compose/Composer'
import { useSharedSearchSettings } from '@/features/compose/SearchSettingsProvider'
import {
  AssistantTurn,
  preloadAnswerRenderer,
  Thinking
} from '@/features/thread/components/AssistantTurn'
import { SourcesSheet } from '@/features/thread/components/SourcesSheet'
import type { ChatErrorView } from '@/features/thread/model/chat-errors'
import { listSources } from '@/features/thread/model/citations'
import { useThread } from '@/features/thread/useThread'
import { isTurnStreaming } from '@/lib/render/message-parts'

/** How far above the bottom the user may be and still be followed. */
const FOLLOW_SLACK_PX = 80

export type ThreadScreenProps = {
  chatId: string
  /** A chat started on this device: nothing saved to load. Fixed for the screen's life. */
  isNew: boolean
  /** Asked once when the screen opens. */
  initialQuestion?: string
}

/**
 * Opens a thread over the current screen: a new chat (a fresh id) that asks
 * `question`, or the saved chat `chatId`. Whether it is new is decided here,
 * once, so it never changes while the screen is up.
 */
export function openThread(
  push: Stack['push'],
  o: { question?: string; chatId?: string }
) {
  const chatId = o.chatId ?? newId()
  const isNew = o.chatId === undefined
  push({
    key: `thread:${chatId}`,
    render: () => (
      <ThreadScreen
        chatId={chatId}
        isNew={isNew}
        initialQuestion={o.question}
      />
    )
  })
}

const textOf = (message: UIMessage) =>
  message.parts.map(p => (p.type === 'text' ? p.text : '')).join('')

function HeaderButton({
  label,
  onClick,
  disabled,
  d
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  d: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-foreground/70 active:opacity-50 disabled:opacity-30"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
    </button>
  )
}

const BACK_ICON = 'M15 5l-7 7 7 7'
const SOURCES_ICON = 'M4 6h16M4 12h16M4 18h10'

function ErrorBanner({
  error,
  onRetry,
  onSignIn
}: {
  error: ChatErrorView
  onRetry: () => void
  onSignIn: () => void
}) {
  const action = error.authRequired
    ? { label: 'Sign in again', onClick: onSignIn }
    : error.retryable
      ? { label: 'Retry', onClick: onRetry }
      : null
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-2xl bg-red-500/10 px-4 py-2 text-sm text-red-600 dark:text-red-400"
    >
      <p className="min-w-0 flex-1">{error.message}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="min-h-11 shrink-0 touch-manipulation rounded-full px-3 font-semibold active:opacity-50"
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading chat"
      className="flex animate-pulse flex-col gap-3"
    >
      <div className="ml-auto h-10 w-2/3 rounded-3xl bg-foreground/8" />
      <div className="h-4 w-full rounded bg-foreground/8" />
      <div className="h-4 w-5/6 rounded bg-foreground/8" />
      <div className="h-4 w-3/4 rounded bg-foreground/8" />
    </div>
  )
}

export function ThreadScreen({
  chatId,
  isNew,
  initialQuestion
}: ThreadScreenProps) {
  const { pop } = useStack()
  const { signOut } = useAuth()
  const { baseUrl } = useApi()
  const [settings, setSettings] = useSharedSearchSettings()
  const thread = useThread({ chatId, isNew, settings })
  const { messages, status, send } = thread
  const busy = status === 'submitted' || status === 'streaming'

  // The answer renderer is a separate chunk: fetch it while the question is
  // on its way, so the first answer renders at once.
  useEffect(() => {
    void preloadAnswerRenderer()
  }, [])

  // The opening question, sent once (a double mount must not ask it twice).
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || !initialQuestion) return
    asked.current = true
    send(initialQuestion)
  }, [initialQuestion, send])

  // --- Following the bottom ---------------------------------------------------
  const scroller = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)

  const toBottom = useCallback(() => {
    const el = scroller.current!
    el.scrollTop = el.scrollHeight
  }, [])

  const onScroll = () => {
    const el = scroller.current!
    const below = el.scrollHeight - el.scrollTop - el.clientHeight
    setFollowing(below <= FOLLOW_SLACK_PX)
  }

  useLayoutEffect(() => {
    if (following) toBottom()
  }, [messages, status, following, toBottom])

  const jumpToLatest = () => {
    setFollowing(true)
    toBottom()
  }

  const sendFollowUp = (text: string) => {
    setFollowing(true)
    send(text)
  }

  // --- Header -----------------------------------------------------------------
  const firstQuestion = messages.find(m => m.role === 'user')
  const title =
    thread.title ||
    (firstQuestion ? textOf(firstQuestion) : initialQuestion) ||
    'Chat'

  const lastAnswer = messages.findLast(m => m.role === 'assistant')
  const sources = useMemo(
    () => (lastAnswer ? listSources(lastAnswer) : []),
    [lastAnswer]
  )
  const [sourcesOpen, setSourcesOpen] = useState(false)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-1 border-b border-foreground/10 px-1 py-1">
        <HeaderButton label="Back" onClick={pop} d={BACK_ICON} />
        <h1 className="min-w-0 flex-1 truncate text-center text-base font-semibold">
          {title}
        </h1>
        <HeaderButton
          label="Sources"
          onClick={() => setSourcesOpen(true)}
          disabled={sources.length === 0}
          d={SOURCES_ICON}
        />
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          data-testid="thread-scroll"
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
        >
          {thread.loading ? (
            <LoadingSkeleton />
          ) : (
            <div className="flex flex-col gap-5">
              {messages.map((message, i) => {
                if (message.role === 'user') {
                  return (
                    <p
                      key={message.id}
                      className="ml-auto max-w-[85%] rounded-3xl bg-foreground/8 px-4 py-2.5 text-base whitespace-pre-wrap"
                    >
                      {textOf(message)}
                    </p>
                  )
                }
                const isLatest = i === messages.length - 1
                const prev = messages[i - 1]
                return (
                  <AssistantTurn
                    key={message.id}
                    message={message}
                    streaming={isTurnStreaming(isLatest, status)}
                    isLatest={isLatest}
                    question={prev?.role === 'user' ? textOf(prev) : ''}
                    onAsk={send}
                    onRetry={thread.retry}
                    baseUrl={baseUrl}
                  />
                )
              })}
              {status === 'submitted' &&
                messages.at(-1)?.role !== 'assistant' && <Thinking />}
            </div>
          )}
          {thread.error && (
            <div className="pt-4">
              <ErrorBanner
                error={thread.error}
                onRetry={thread.retryLast}
                onSignIn={() => void signOut()}
              />
            </div>
          )}
        </div>
        {!following && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 left-1/2 min-h-9 -translate-x-1/2 touch-manipulation rounded-full bg-foreground px-4 text-sm font-medium text-background shadow-lg active:opacity-80"
          >
            Jump to latest
          </button>
        )}
      </div>

      <Composer
        placeholder="Ask a follow-up"
        busy={busy}
        disabled={thread.loading}
        onSend={sendFollowUp}
        onStop={() => void thread.stop()}
        settings={settings}
        onSettings={setSettings}
      />
      <SourcesSheet
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        sources={sources}
      />
    </div>
  )
}
