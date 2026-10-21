// One thread's chat session: the AI SDK's useChat over Ask's resumable
// transport with a bearer token, plus Ask's lifecycle routes (code map §1, §5).
// Mirrors the web's components/chat.tsx: stop tells the server too, retry
// regenerates an answer, and a turn cut off by backgrounding the app is
// resumed (or reloaded once saved) when the app comes back.
import { useChat } from '@ai-sdk/react'
import { App } from '@capacitor/app'
import type { ChatStatus, UIMessage } from 'ai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useApi } from '@/core/api/ApiProvider'
import { newId } from '@/core/ids'
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
}

/** Tries at the saved copy after a resume finds nothing live, 1 s apart. */
const RELOAD_ATTEMPTS = 3
const RELOAD_DELAY_MS = 1000

const textOf = (message: UIMessage) =>
  message.parts.map(p => (p.type === 'text' ? p.text : '')).join('')

const isBusy = (status: ChatStatus) =>
  status === 'submitted' || status === 'streaming'

type MessagesResponse = { messages?: UIMessage[] }

export function useThread({
  chatId,
  isNew,
  settings
}: ThreadOptions): ThreadSession {
  const { client, baseUrl, getToken } = useApi()
  const [loading, setLoading] = useState(!isNew)
  const [loadError, setLoadError] = useState<Error>()

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
          prepareSendMessagesRequest: ({
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
              settings: live.current.settings
            })
          })
        },
        {
          onReplayStart: id => hooks.current.onReplayStart?.(id),
          onNothingToResume: () => hooks.current.onNothingToResume?.()
        }
      )
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
    transport
  })

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

  const runTurn = useCallback((turn: () => Promise<void>) => {
    turnRef.current = true
    setLoadError(undefined)
    void turn().finally(() => {
      turnRef.current = false
    })
  }, [])

  // An existing chat: show its saved messages (again on each reload).
  const [loadRequest, setLoadRequest] = useState(0)
  useEffect(() => {
    if (isNew) return
    let cancelled = false
    client
      .json<MessagesResponse>(`/api/chat/${chatId}/messages`)
      .then(
        data => {
          if (!cancelled) setMessages(data.messages ?? [])
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
  }, [chatId, isNew, client, setMessages, loadRequest])

  const reload = useCallback(() => {
    if (isNew) return
    setLoadError(undefined)
    setLoading(true)
    setLoadRequest(n => n + 1)
  }, [isNew])

  // Resume outcomes (see ResumableChatTransport).
  const reloadSaved = useCallback(async () => {
    for (let attempt = 0; attempt < RELOAD_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, RELOAD_DELAY_MS))
      }
      let saved: UIMessage[] | undefined
      try {
        saved = (
          await client.json<MessagesResponse>(`/api/chat/${chatId}/messages`)
        ).messages
      } catch (err) {
        console.warn('[thread] reload after resume failed', err)
        return
      }
      if (!saved?.length) return
      // The stream can report done a moment before the answer is saved.
      if (saved[saved.length - 1].role !== 'assistant') continue
      // The user started something new meanwhile: keep what is on screen.
      if (inFlight()) return
      setMessages(saved)
      clearError()
      return
    }
  }, [client, chatId, inFlight, setMessages, clearError])

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
  const resumeStreamRef = useRef(resumeStream)
  useEffect(() => {
    resumeStreamRef.current = resumeStream
  }, [resumeStream])
  useEffect(() => {
    let leftMidTurn = false
    const handle = App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        leftMidTurn = inFlight()
        return
      }
      // Still connected (or already resuming): nothing to do yet.
      if (!leftMidTurn || inFlight()) return
      leftMidTurn = false
      runTurn(() => resumeStreamRef.current())
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
    try {
      const res = await client.fetch(`/api/chat/${chatId}/stop`, {
        method: 'POST'
      })
      if (!res.ok) console.warn('[thread] stop request failed', res.status)
    } catch (err) {
      console.warn('[thread] stop request failed', err)
    }
    await stopLocal()
  }, [client, chatId, stopLocal])

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
    const shown = error ?? loadError
    return shown ? describeChatError(shown) : undefined
  }, [error, loadError])

  const title = useMemo(() => {
    const lastAnswer = messages.findLast(m => m.role === 'assistant')
    return lastAnswer ? titleOf(lastAnswer) : undefined
  }, [messages])

  return {
    messages,
    status,
    error: errorView,
    title,
    send,
    stop,
    retry,
    reload,
    retryLast,
    loading
  }
}
