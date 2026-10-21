// One thread's chat session: the AI SDK's useChat over Ask's resumable
// transport with a bearer token, plus Ask's lifecycle routes (code map §1, §5).
// Mirrors the web's components/chat.tsx: stop tells the server too, retry
// regenerates an answer, and a turn cut off by backgrounding the app is
// resumed (or reloaded once saved) when the app comes back. Opening a saved
// chat marks it viewed, and each finished turn tells the chat list
// (chats-changed) so the Library stays current.
import { useChat } from '@ai-sdk/react'
import { App } from '@capacitor/app'
import type { ChatStatus, UIMessage } from 'ai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { emitChatsChanged } from '@/core/chats-events'
import { newId } from '@/core/ids'
import { touchChat } from '@/features/library/library-api'
import { loadCustomInstructions } from '@/features/settings/custom-instructions'
import { buildChatBody, type SearchSettings } from '@/features/thread/chat-body'
import {
  describeChatError,
  type ChatErrorView
} from '@/features/thread/model/chat-errors'
import { titleOf } from '@/features/thread/model/research'
import {
  ResumableChatTransport,
  type ResumeHooks
} from '@/lib/streaming/resumable-chat-transport'

export type ThreadOptions = {
  chatId: string
  /** A chat created on this device that has no saved messages yet. */
  isNew: boolean
  settings: SearchSettings
}

export type ThreadSession = {
  messages: UIMessage[]
  status: ChatStatus
  error: ChatErrorView | undefined
  /** The title the server streamed for this chat, once it has. */
  title?: string
  /**
   * A saved chat's title as the server has it now (renamed or not), once its
   * messages load. The streamed title in those messages is never renamed.
   */
  savedTitle?: string
  send(text: string): void
  stop(): Promise<void>
  retry(assistantMessageId: string): void
  /** Loads an existing chat's saved messages again (after a failed load). */
  reload(): void
  /**
   * The error banner's Retry: reloads after a failed load, regenerates the
   * last answer, or resends a question that got no answer. No-op mid-turn.
   */
  retryLast(): void
  /** True while an existing chat's saved messages load. */
  loading: boolean
  /**
   * The chat exists on the server: a saved chat, or a new one whose first
   * turn finished or was stopped.
   */
  saved: boolean
}

/** Tries at the saved copy after a resume finds nothing live, 1 s apart. */
const RELOAD_ATTEMPTS = 3
const RELOAD_DELAY_MS = 1000

/** What the banner says when a cut-off answer could not be brought back. */
const COULD_NOT_LOAD_ANSWER = "Couldn't load the answer"

const textOf = (message: UIMessage) =>
  message.parts.map(p => (p.type === 'text' ? p.text : '')).join('')

const isBusy = (status: ChatStatus) =>
  status === 'submitted' || status === 'streaming'

type MessagesResponse = { messages?: UIMessage[]; title?: string }

export function useThread({
  chatId,
  isNew,
  settings
}: ThreadOptions): ThreadSession {
  const { client, baseUrl, getToken } = useApi()
  const [loading, setLoading] = useState(!isNew)
  const [loadError, setLoadError] = useState<Error>()
  // Set when a turn cut off by backgrounding could be neither resumed nor
  // reloaded from the saved copy.
  const [resumeError, setResumeError] = useState<Error>()

  // The transport is built once; it reads live values through these refs.
  const live = useRef({ isNew, settings, getToken })
  useEffect(() => {
    live.current = { isNew, settings, getToken }
  }, [isNew, settings, getToken])
  // Set once useChat exists (below); resumes only start after that.
  const hooks = useRef<ResumeHooks>({})

  const [transport] = useState(
    () =>
      new ResumableChatTransport<UIMessage>(
        {
          api: `${baseUrl}/api/chat`,
          // A fresh token for every request; never an unauthenticated one.
          headers: async () => {
            const token = await live.current.getToken()
            if (!token) throw new Error('Signed out')
            return { Authorization: `Bearer ${token}` }
          },
          // The custom instructions are read for each request, so a change
          // made in Settings applies to the next question.
          prepareSendMessagesRequest: async ({
            id,
            messages,
            trigger,
            messageId
          }) => ({
            body: buildChatBody({
              trigger,
              chatId: id,
              messageId,
              messages,
              isNewChat: live.current.isNew,
              settings: live.current.settings,
              systemInstructions: await loadCustomInstructions()
            })
          })
        },
        {
          onReplayStart: id => hooks.current.onReplayStart?.(id),
          onNothingToResume: () => hooks.current.onNothingToResume?.()
        }
      )
  )

  // Whether the last turn ended in an error (a dropped connection) rather than
  // finishing or being stopped; set by useChat's onFinish.
  const turnErroredRef = useRef(false)

  // A new chat exists on the server once a turn of it ends there; the first
  // such turn creates it in the chat list, later ones update it.
  const savedRef = useRef(!isNew)
  const [saved, setSaved] = useState(!isNew)
  const turnSaved = useCallback(
    (reason?: 'updated') => {
      emitChatsChanged(
        reason ?? (savedRef.current ? 'updated' : 'created'),
        chatId
      )
      savedRef.current = true
      setSaved(true)
    },
    [chatId]
  )

  const {
    messages,
    status,
    error,
    setMessages,
    sendMessage,
    regenerate,
    resumeStream,
    stop: stopLocal,
    clearError
  } = useChat({
    id: chatId,
    generateId: newId,
    experimental_throttle: 100,
    transport,
    onFinish: ({ isError, isAbort }) => {
      turnErroredRef.current = isError
      // A stop is told by stop(); leaving mid-turn tells nothing.
      if (!isError && !isAbort) turnSaved()
    }
  })

  // The answer is read locally only while its screen is up: going back stops
  // the read but not the server (a signed-in turn finishes and is saved
  // there). Deferred a tick, so StrictMode's dev re-mount (cleanup then setup
  // at once) cancels it instead of aborting the opening send.
  const stopLocalRef = useRef(stopLocal)
  useEffect(() => {
    stopLocalRef.current = stopLocal
  }, [stopLocal])
  const pendingLocalStop = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    clearTimeout(pendingLocalStop.current)
    return () => {
      pendingLocalStop.current = setTimeout(() => {
        void stopLocalRef.current()
      }, 0)
    }
  }, [])

  // A turn this hook started and the SDK has not finished. Set synchronously,
  // so a second tap in the same tick is refused before the status catches up.
  const turnRef = useRef(false)
  const statusRef = useRef(status)
  const messagesRef = useRef(messages)
  useEffect(() => {
    statusRef.current = status
    messagesRef.current = messages
  }, [status, messages])
  const inFlight = useCallback(
    () => turnRef.current || isBusy(statusRef.current),
    []
  )

  // The app came back while its turn still looked connected; resume once
  // that turn ends (the suspended request usually errors only afterwards).
  const resumeWhenSettledRef = useRef(false)
  const resumeStreamRef = useRef(resumeStream)
  useEffect(() => {
    resumeStreamRef.current = resumeStream
  }, [resumeStream])

  const runTurn = useCallback((turn: () => Promise<void>) => {
    turnRef.current = true
    turnErroredRef.current = false
    setLoadError(undefined)
    setResumeError(undefined)
    void turn().finally(() => {
      turnRef.current = false
      if (!resumeWhenSettledRef.current) return
      resumeWhenSettledRef.current = false
      // Only a dropped turn is resumed; one that simply finished is whole.
      if (turnErroredRef.current) runTurn(() => resumeStreamRef.current())
    })
  }, [])

  // Bumped when this thread goes away (unmount or another chat id), so async
  // work started for it stops writing into whatever is shown next.
  const generation = useRef(0)
  useEffect(
    () => () => {
      generation.current++
      resumeWhenSettledRef.current = false
    },
    [chatId]
  )

  // Opening a saved chat marks it viewed, once per screen (not again on
  // StrictMode's re-mount); then the list is told it was viewed, so its
  // "recent" order shows the view. touchChat never rejects.
  const touched = useRef<string>(undefined)
  useEffect(() => {
    if (isNew || touched.current === chatId) return
    touched.current = chatId
    void touchChat(client, chatId).then(() =>
      emitChatsChanged('viewed', chatId)
    )
  }, [chatId, isNew, client])

  // An existing chat: show its saved messages (again on each reload).
  const [loadRequest, setLoadRequest] = useState(0)
  const [savedTitle, setSavedTitle] = useState<string>()
  useEffect(() => {
    setLoadError(undefined)
    setLoading(!isNew)
    setSavedTitle(undefined)
    if (isNew) return
    let cancelled = false
    client
      .json<MessagesResponse>(`/api/chat/${chatId}/messages`)
      .then(
        data => {
          if (cancelled) return
          setSavedTitle(data.title || undefined)
          // A question sent while loading wins over the saved copy.
          if (!inFlight()) setMessages(data.messages ?? [])
        },
        (err: Error) => {
          if (!cancelled) setLoadError(err)
        }
      )
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chatId, isNew, client, inFlight, setMessages, loadRequest])

  const reload = useCallback(() => {
    if (!isNew) setLoadRequest(n => n + 1)
  }, [isNew])

  // Resume outcomes (see ResumableChatTransport).
  const reloadSaved = useCallback(async () => {
    const started = generation.current
    const gone = () => generation.current !== started
    // Keeps what is on screen and says so, so the banner offers Retry.
    const giveUp = () => {
      if (gone() || inFlight()) return
      clearError()
      setResumeError(new Error(COULD_NOT_LOAD_ANSWER))
    }
    for (let attempt = 0; attempt < RELOAD_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, RELOAD_DELAY_MS))
        if (gone()) return
      }
      let savedMessages: UIMessage[] | undefined
      try {
        savedMessages = (
          await client.json<MessagesResponse>(`/api/chat/${chatId}/messages`)
        ).messages
      } catch (err) {
        console.warn('[thread] reload after resume failed', err)
        return giveUp()
      }
      if (gone()) return
      if (!savedMessages?.length) return giveUp()
      // The stream can report done a moment before the answer is saved.
      if (savedMessages[savedMessages.length - 1].role !== 'assistant') continue
      // The user started something new meanwhile: keep what is on screen.
      if (inFlight()) return
      setMessages(savedMessages)
      clearError()
      // The turn finished on the server while the app was away.
      turnSaved()
      return
    }
    giveUp()
  }, [client, chatId, inFlight, setMessages, clearError, turnSaved])

  useEffect(() => {
    hooks.current = {
      // The replay starts from the turn's first chunk and the SDK builds it on
      // top of the last assistant message: drop our partial copy of it first.
      onReplayStart: replayId => {
        setMessages(current => {
          const last = current[current.length - 1]
          return last?.role === 'assistant' && last.id === replayId
            ? current.slice(0, -1)
            : current
        })
      },
      // Nothing live: the turn finished while the app was away.
      onNothingToResume: () => {
        void reloadSaved()
      }
    }
  }, [setMessages, reloadSaved])

  // Backgrounding drops the connection but the server keeps generating, so a
  // turn in flight when the app left is resumed when it comes back.
  useEffect(() => {
    let leftMidTurn = false
    const handle = App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        leftMidTurn = inFlight()
        return
      }
      if (!leftMidTurn) return
      leftMidTurn = false
      // Still looks connected (or already resuming): resume when it ends.
      if (inFlight()) resumeWhenSettledRef.current = true
      else runTurn(() => resumeStreamRef.current())
    })
    return () => {
      void handle.then(h => h.remove())
    }
  }, [inFlight, runTurn])

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || inFlight()) return
      runTurn(() => sendMessage({ text: trimmed }))
    },
    [inFlight, runTurn, sendMessage]
  )

  // The server keeps generating after a disconnect, so stop it there first,
  // then cancel the local read.
  const stop = useCallback(async () => {
    // The user ended the turn: don't bring it back.
    resumeWhenSettledRef.current = false
    try {
      const res = await client.fetch(`/api/chat/${chatId}/stop`, {
        method: 'POST'
      })
      if (!res.ok) console.warn('[thread] stop request failed', res.status)
    } catch (err) {
      console.warn('[thread] stop request failed', err)
    }
    await stopLocal()
    // The server saves what was answered so far.
    turnSaved('updated')
  }, [client, chatId, stopLocal, turnSaved])

  const retry = useCallback(
    (assistantMessageId: string) => {
      if (inFlight()) return
      if (!messagesRef.current.some(m => m.id === assistantMessageId)) return
      runTurn(() => regenerate({ messageId: assistantMessageId }))
    },
    [inFlight, runTurn, regenerate]
  )

  const retryLast = useCallback(() => {
    if (inFlight()) return
    if (loadError) return reload()
    const last = messagesRef.current.at(-1)
    if (!last) return
    if (last.role === 'assistant') return retry(last.id)
    // The turn failed before any answer: resend the question as a new submit
    // (a fresh message id), dropping the failed copy so it isn't shown twice.
    const text = textOf(last)
    if (!text.trim()) return
    setMessages(current => current.filter(m => m.id !== last.id))
    send(text)
  }, [inFlight, loadError, reload, retry, setMessages, send])

  const errorView = useMemo(() => {
    const shown = error ?? loadError ?? resumeError
    return shown ? describeChatError(shown) : undefined
  }, [error, loadError, resumeError])

  // The server streams the title with the first answer only, so the newest
  // answer that carries one names the chat.
  const title = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role !== 'assistant') continue
      const found = titleOf(message)
      if (found) return found
    }
    return undefined
  }, [messages])

  return {
    messages,
    status,
    error: errorView,
    title,
    savedTitle,
    send,
    stop,
    retry,
    reload,
    retryLast,
    loading,
    saved
  }
}
