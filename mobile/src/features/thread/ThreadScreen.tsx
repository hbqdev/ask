// One chat: a header (back, title, sources, and the chat menu once the chat
// is saved), the turns, and a composer for follow-ups. The list follows the
// answer as it streams unless the user has scrolled up to read, when "Jump to
// latest" brings them back. A saved chat can be shared as a public link from
// the menu or from an answer's Share; whether it is public is the server's
// word when it loaded, then whatever was done here. Its answers are read
// aloud only while it is shown: leaving it (another tab, a screen pushed over
// it, going back) or the app going to the background stops the reading.

import type { UIMessage } from 'ai'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { useTabActive } from '@/app/Tabs'
import { useApi } from '@/core/api/ApiProvider'
import { useAuth } from '@/core/auth/AuthProvider'
import { newId } from '@/core/ids'
import { useScreenActive, useStack, type Stack } from '@/core/nav/stack'
import { Composer } from '@/features/compose/Composer'
import { useSharedSearchSettings } from '@/features/compose/SearchSettingsProvider'
import type { FilePart } from '@/features/thread/chat-body'
import {
  AssistantTurn,
  preloadAnswerRenderer,
  Thinking
} from '@/features/thread/components/AssistantTurn'
import { SourcesSheet } from '@/features/thread/components/SourcesSheet'
import { UserMessage } from '@/features/thread/components/UserMessage'
import type { ChatErrorView } from '@/features/thread/model/chat-errors'
import { listSources } from '@/features/thread/model/citations'
import {
  shareChat,
  unshareChat,
  type ChatVisibility
} from '@/features/thread/share-api'
import { ThreadMenu } from '@/features/thread/ThreadMenu'
import { useThread } from '@/features/thread/useThread'
import { useStopReadingOnLeave } from '@/features/voice/useReadAloud'
import { isTurnStreaming } from '@/lib/render/message-parts'

/** How far above the bottom the user may be and still be followed. */
const FOLLOW_SLACK_PX = 80

type ScrollLook = { top: number; height: number }

const lookAt = (el: HTMLElement): ScrollLook => ({
  top: el.scrollTop,
  height: el.scrollHeight
})

/** More than the slack is hidden below the visible part. */
const belowFold = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight > FOLLOW_SLACK_PX

export type ThreadScreenProps = {
  chatId: string
  /** A chat started on this device: nothing saved to load. Fixed for the screen's life. */
  isNew: boolean
  /** Asked once when the screen opens. */
  initialQuestion?: string
  /** Uploaded files asked about with the opening question. */
  initialFiles?: FilePart[]
  /** A saved chat's title, shown until the chat's own title loads. */
  initialTitle?: string
}

/**
 * Opens a thread over the current screen: a new chat that asks `question`
 * with `files`, or the saved chat `chatId`, headed by `title` (from the
 * Library) until its own title loads. A new chat takes `newChatId` (the id
 * its files were uploaded under), else a fresh id. Whether it is new is
 * decided here, once, so it never changes while the screen is up.
 */
export function openThread(
  push: Stack['push'],
  o: {
    question?: string
    files?: FilePart[]
    chatId?: string
    title?: string
    newChatId?: string
  }
) {
  const chatId = o.chatId ?? o.newChatId ?? newId()
  const isNew = o.chatId === undefined
  push({
    key: `thread:${chatId}`,
    render: () => (
      <ThreadScreen
        chatId={chatId}
        isNew={isNew}
        initialQuestion={o.question}
        initialFiles={o.files}
        initialTitle={o.title}
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
  initialQuestion,
  initialFiles,
  initialTitle
}: ThreadScreenProps) {
  const { pop } = useStack()
  const { signOut } = useAuth()
  const { baseUrl, client } = useApi()
  const [settings, setSettings, settingsLoaded] = useSharedSearchSettings()
  const thread = useThread({ chatId, isNew, settings })
  const { messages, status, send } = thread
  const busy = status === 'submitted' || status === 'streaming'

  // Readings of this chat's answers stop when the screen is left.
  const tabShown = useTabActive()
  const screenShown = useScreenActive()
  useStopReadingOnLeave(tabShown && screenShown, owner =>
    messages.some(m => m.id === owner)
  )

  // The answer renderer is a separate chunk: fetch it while the question is
  // on its way, so the first answer renders at once. A failed preload is
  // not this screen's error: the answer's own load meets it when it renders.
  useEffect(() => {
    preloadAnswerRenderer().catch(() => {})
  }, [])

  // The opening question, sent once (a double mount must not ask it twice),
  // and only with the stored search settings: on a cold start they are still
  // loading when this screen opens.
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || !settingsLoaded) return
    if (!initialQuestion && !initialFiles?.length) return
    asked.current = true
    send(initialQuestion ?? '', initialFiles)
  }, [initialQuestion, initialFiles, send, settingsLoaded])

  // --- Following the bottom ---------------------------------------------------
  // The answer renderer commits its blocks after React's update (and the
  // keyboard resizes the scroller), so the pin runs from ResizeObservers, not
  // only on renders. Only an upward move by the user stops following: a
  // scroll event the pin or a browser clamp causes never does.
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [following, setFollowingState] = useState(true)
  const followingRef = useRef(true)
  // Where the scroller was, and how tall its content, when last looked at.
  const last = useRef<ScrollLook>({ top: 0, height: 0 })

  const setFollowing = useCallback((next: boolean) => {
    followingRef.current = next
    setFollowingState(next)
  }, [])

  const toBottom = useCallback(() => {
    const el = scroller.current!
    el.scrollTop = el.scrollHeight
    last.current = lookAt(el)
  }, [])

  const onScroll = () => {
    const el = scroller.current!
    if (!belowFold(el)) {
      if (!followingRef.current) setFollowing(true)
    } else if (
      followingRef.current &&
      el.scrollTop < last.current.top - 1 &&
      // A move up while the content changed size is the browser's clamp.
      el.scrollHeight === last.current.height
    ) {
      setFollowing(false)
    }
    last.current = lookAt(el)
  }

  useLayoutEffect(() => {
    if (following) toBottom()
  }, [messages, status, following, toBottom])

  useEffect(() => {
    const el = scroller.current!
    const observer = new ResizeObserver(() => {
      if (followingRef.current) toBottom()
      // Nothing left below to jump to: follow again.
      else if (!belowFold(el)) setFollowing(true)
    })
    observer.observe(el)
    observer.observe(content.current!)
    return () => observer.disconnect()
  }, [toBottom, setFollowing])

  const jumpToLatest = () => {
    setFollowing(true)
    toBottom()
  }

  const sendFollowUp = (text: string, files: FilePart[]) => {
    setFollowing(true)
    send(text, files)
  }

  // --- Header -----------------------------------------------------------------
  // A rename here wins; then the saved chat's title on the server (renamed
  // elsewhere or not), then the streamed one, which names a new chat but is
  // never renewed by a rename or a later turn.
  const [renamedTitle, setRenamedTitle] = useState<string>()
  const firstQuestion = messages.find(m => m.role === 'user')
  const title =
    renamedTitle ||
    thread.savedTitle ||
    thread.title ||
    initialTitle ||
    (firstQuestion ? textOf(firstQuestion) : initialQuestion) ||
    'Chat'

  // --- Sharing ----------------------------------------------------------------
  // A share or stop here wins over what the server said when the chat loaded.
  const [visibility, setVisibility] = useState<ChatVisibility>()
  const shared = (visibility ?? thread.savedVisibility) === 'public'
  const createLink = useCallback(async () => {
    const url = await shareChat(client, chatId)
    setVisibility('public')
    return url
  }, [client, chatId])
  const stopSharing = useCallback(async () => {
    await unshareChat(client, chatId)
    setVisibility('private')
  }, [client, chatId])
  // The answers' link shares the chat under the title shown; read through a
  // ref so a new title doesn't re-render every (memoized) turn.
  const titleRef = useRef(title)
  useEffect(() => {
    titleRef.current = title
  }, [title])
  const linkToChat = useCallback(
    async () => ({ title: titleRef.current, url: await createLink() }),
    [createLink]
  )

  const lastAnswer = messages.findLast(m => m.role === 'assistant')
  const sources = useMemo(
    () => (lastAnswer ? listSources(lastAnswer) : []),
    [lastAnswer]
  )
  const [sourcesOpen, setSourcesOpen] = useState(false)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Like an iOS navigation bar: the side columns are one width (room
          for two buttons), so the title sits on the screen's centre line
          however many buttons each side has, and truncates between them. */}
      <header className="relative grid grid-cols-[5.5rem_minmax(0,1fr)_5.5rem] items-center gap-1 border-b border-foreground/10 px-1 py-1">
        <div className="flex justify-start">
          <HeaderButton label="Back" onClick={pop} d={BACK_ICON} />
        </div>
        <h1 className="min-w-0 truncate text-center text-base font-semibold">
          {title}
        </h1>
        <div className="flex justify-end">
          <HeaderButton
            label="Sources"
            onClick={() => setSourcesOpen(true)}
            disabled={sources.length === 0}
            d={SOURCES_ICON}
          />
          {thread.saved && (
            <ThreadMenu
              chatId={chatId}
              title={title}
              onRenamed={setRenamedTitle}
              onDeleted={pop}
              shared={shared}
              createLink={createLink}
              stopSharing={stopSharing}
            />
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          data-testid="thread-scroll"
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
        >
          <div ref={content} data-testid="thread-content">
            {thread.loading ? (
              <LoadingSkeleton />
            ) : (
              <div className="flex flex-col gap-5">
                {messages.map((message, i) => {
                  if (message.role === 'user') {
                    return (
                      <UserMessage
                        key={message.id}
                        message={message}
                        baseUrl={baseUrl}
                      />
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
                      autoRead={message.id === thread.freshAnswerId}
                      linkToChat={thread.saved ? linkToChat : undefined}
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
        chatId={chatId}
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
