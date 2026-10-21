import { act, renderHook, waitFor } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { StrictMode, useEffect, useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider } from '@/core/api/ApiProvider'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
import { onChatsChanged } from '@/core/chats-events'
import type { SearchSettings } from '@/features/thread/chat-body'
import { useThread } from '@/features/thread/useThread'

// --- Mocks ------------------------------------------------------------------

vi.mock('@/core/auth/AuthProvider', () => ({ useAuth: vi.fn() }))

type AppStateListener = (state: { isActive: boolean }) => void

const app = vi.hoisted(() => ({
  listeners: [] as Array<(state: { isActive: boolean }) => void>,
  remove: vi.fn(async () => {})
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, listener: AppStateListener) => {
      app.listeners.push(listener)
      return { remove: app.remove }
    })
  }
}))

const BASE = 'https://ask.test.invalid'
const CHAT_ID = 'chat-1'
const settings: SearchSettings = { searchMode: 'quality', sources: ['web'] }

const getAccessToken = vi.fn<() => Promise<string | null>>()

// --- Network: Ask's UI message stream over real SSE frames ------------------

const encoder = new TextEncoder()
const frame = (chunk: object) =>
  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
const DONE = encoder.encode('data: [DONE]\n\n')

const SSE_INIT = {
  status: 200,
  headers: {
    'content-type': 'text/event-stream',
    'x-vercel-ai-ui-message-stream': 'v1'
  }
}

/** The chunks of a whole one-text answer, as Ask streams them. */
function answerChunks(messageId: string, text: string, title?: string) {
  return [
    { type: 'start', messageId },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    ...(title ? [{ type: 'data-title', data: { title } }] : []),
    { type: 'finish' }
  ]
}

function sse(chunks: object[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(frame(chunk))
      controller.enqueue(DONE)
      controller.close()
    }
  })
  return new Response(body, SSE_INIT)
}

/** An SSE response the test writes to as it goes. */
function liveSse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    }
  })
  return {
    response: new Response(body, SSE_INIT),
    push: (chunk: object) => controller.enqueue(frame(chunk)),
    fail: (error: Error) => controller.error(error),
    close: () => {
      controller.enqueue(DONE)
      controller.close()
    }
  }
}

/** A request that never answers; it rejects like fetch when aborted. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    )
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

type Handler = (init: RequestInit) => Response | Promise<Response>
type Routes = Partial<
  Record<'chat' | 'stop' | 'stream' | 'messages' | 'touch', Handler[]>
>

const fetchMock = vi.fn<typeof fetch>()

/** Routes each request to the next handler queued for its endpoint. */
function serve(routes: Routes) {
  fetchMock.mockImplementation(async (input, init = {}) => {
    const url = String(input)
    const method = init.method ?? 'GET'
    const key =
      method === 'POST' && url === `${BASE}/api/chat`
        ? 'chat'
        : method === 'POST' && url === `${BASE}/api/chat/${CHAT_ID}/stop`
          ? 'stop'
          : method === 'GET' && url === `${BASE}/api/chat/${CHAT_ID}/stream`
            ? 'stream'
            : method === 'GET' && url === `${BASE}/api/chat/${CHAT_ID}/messages`
              ? 'messages'
              : method === 'POST' &&
                  url === `${BASE}/api/chats/${CHAT_ID}/touch`
                ? 'touch'
                : null
    // Opening a saved chat touches it; the server's answer doesn't matter.
    const handler =
      key === 'touch'
        ? (routes.touch?.shift() ?? (() => new Response(null, { status: 204 })))
        : key
          ? routes[key]?.shift()
          : undefined
    if (!handler) throw new Error(`unexpected request: ${method} ${url}`)
    return handler(init)
  })
}

function requests(method: string, path: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        String(input) === `${BASE}${path}` && (init?.method ?? 'GET') === method
    )
    .map(([, init]) => init ?? {})
}

const chatBodies = () =>
  requests('POST', '/api/chat').map(
    init => JSON.parse(String(init.body)) as Record<string, unknown>
  )

const authOf = (init: RequestInit) =>
  new Headers(init.headers).get('Authorization')

// --- Helpers ----------------------------------------------------------------

const user = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }]
})

const assistant = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }]
})

/** Each message as role + its text parts, for readable assertions. */
const transcript = (messages: UIMessage[]) =>
  messages.map(m => ({
    role: m.role,
    texts: m.parts.flatMap(p => (p.type === 'text' ? [p.text] : []))
  }))

function wrapper({ children }: { children: ReactNode }) {
  return <ApiProvider baseUrl={BASE}>{children}</ApiProvider>
}

function renderThread(isNew = true) {
  return renderHook(({ chatId }) => useThread({ chatId, isNew, settings }), {
    wrapper,
    initialProps: { chatId: CHAT_ID }
  })
}

function setAppActive(isActive: boolean) {
  act(() => {
    for (const listener of app.listeners) listener({ isActive })
  })
}

/** Every chats-changed event, as (reason, chatId). */
const changed = vi.fn()
let unsubscribe: () => void

// --- Tests ------------------------------------------------------------------

describe('useThread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    app.listeners.length = 0
    getAccessToken.mockResolvedValue('fake-token')
    vi.mocked(useAuth).mockReturnValue({ getAccessToken } as unknown as Auth)
    vi.stubGlobal('fetch', fetchMock)
    unsubscribe = onChatsChanged(changed)
  })

  afterEach(() => {
    unsubscribe()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('streams an answer into messages', async () => {
    serve({ chat: [() => sse(answerChunks('a1', 'Hello there', 'Greeting'))] })
    const { result } = renderThread()
    expect(result.current.loading).toBe(false)
    expect(result.current.status).toBe('ready')

    act(() => result.current.send('What is new?'))

    await waitFor(() =>
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['What is new?'] },
        { role: 'assistant', texts: ['Hello there'] }
      ])
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.title).toBe('Greeting')
    expect(result.current.error).toBeUndefined()

    const [body] = chatBodies()
    const question = result.current.messages[0]
    expect(question.id).toMatch(/^[a-z0-9]{20,}$/)
    expect(body).toEqual({
      trigger: 'submit-message',
      chatId: CHAT_ID,
      message: question,
      isNewChat: true,
      searchMode: 'quality',
      sources: ['web']
    })
  })

  it('keeps the chat title from an earlier turn when a later one has none', async () => {
    serve({
      chat: [
        () => sse(answerChunks('a1', 'One', 'First title')),
        () => sse(answerChunks('a2', 'Two'))
      ]
    })
    const { result } = renderThread()

    act(() => result.current.send('first'))
    await waitFor(() => expect(result.current.title).toBe('First title'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.send('second'))
    await waitFor(() => expect(result.current.messages).toHaveLength(4))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(result.current.title).toBe('First title')
  })

  it('takes the newest title the server streamed', async () => {
    serve({
      chat: [
        () => sse(answerChunks('a1', 'One', 'Old title')),
        () => sse(answerChunks('a2', 'Two', 'New title'))
      ]
    })
    const { result } = renderThread()

    act(() => result.current.send('first'))
    await waitFor(() => expect(result.current.title).toBe('Old title'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.send('second'))

    await waitFor(() => expect(result.current.title).toBe('New title'))
  })

  it('stops reading the answer locally when the thread goes away', async () => {
    let chatSignal: AbortSignal | undefined
    serve({
      chat: [
        init => {
          chatSignal = init.signal ?? undefined
          return hang(init)
        }
      ]
    })
    const { result, unmount } = renderThread()
    act(() => result.current.send('long question'))
    await waitFor(() => expect(chatSignal).toBeDefined())

    unmount()

    await waitFor(() => expect(chatSignal?.aborted).toBe(true))
    // Only the local read: a signed-in turn finishes and saves on the server.
    expect(requests('POST', `/api/chat/${CHAT_ID}/stop`)).toHaveLength(0)
  })

  it('does not abort the opening send on a StrictMode re-mount', async () => {
    let chatSignal: AbortSignal | undefined
    serve({
      chat: [
        init => {
          chatSignal = init.signal ?? undefined
          return hang(init)
        }
      ]
    })
    // Like ThreadScreen: the opening question is sent from an effect, so
    // StrictMode's cleanup-and-setup runs after the send has started.
    const { result } = renderHook(
      () => {
        const thread = useThread({ chatId: CHAT_ID, isNew: true, settings })
        const asked = useRef(false)
        const { send } = thread
        useEffect(() => {
          if (asked.current) return
          asked.current = true
          send('opening question')
        }, [send])
        return thread
      },
      {
        wrapper: ({ children }) => (
          <StrictMode>
            <ApiProvider baseUrl={BASE}>{children}</ApiProvider>
          </StrictMode>
        )
      }
    )
    await waitFor(() => expect(chatSignal).toBeDefined())
    await act(() => new Promise(resolve => setTimeout(resolve, 20)))

    expect(chatSignal?.aborted).toBe(false)
    expect(result.current.status).toBe('submitted')
  })

  it('asks for a fresh token on every request and fails visibly when signed out', async () => {
    serve({
      chat: [
        () => sse(answerChunks('a1', 'One')),
        () => sse(answerChunks('a2', 'Two'))
      ]
    })
    getAccessToken
      .mockResolvedValueOnce('fake-token-1')
      .mockResolvedValueOnce('fake-token-2')
      .mockResolvedValueOnce(null)
    const { result } = renderThread()

    act(() => result.current.send('first'))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.send('second'))
    await waitFor(() => expect(result.current.messages).toHaveLength(4))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    expect(getAccessToken).toHaveBeenCalledTimes(2)
    expect(requests('POST', '/api/chat').map(authOf)).toEqual([
      'Bearer fake-token-1',
      'Bearer fake-token-2'
    ])
    // Only a brand-new chat's first submit is a new chat.
    expect(chatBodies().map(b => b.isNewChat)).toEqual([true, false])

    act(() => result.current.send('third'))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toEqual({
      message: 'Signed out',
      retryable: false,
      authRequired: true
    })
    expect(requests('POST', '/api/chat')).toHaveLength(2)
  })

  it('does not send while a turn is in flight', async () => {
    serve({ chat: [hang] })
    const { result } = renderThread()

    act(() => result.current.send('   '))
    expect(fetchMock).not.toHaveBeenCalled()

    act(() => {
      result.current.send('first')
      result.current.send('again, same tick')
    })
    await waitFor(() => expect(result.current.status).toBe('submitted'))
    act(() => result.current.send('again, while submitted'))

    await act(async () => {})
    expect(requests('POST', '/api/chat')).toHaveLength(1)
    expect(transcript(result.current.messages)).toEqual([
      { role: 'user', texts: ['first'] }
    ])
  })

  it('stop during submitted posts the server stop and returns to ready', async () => {
    let chatSignal: AbortSignal | undefined
    let abortedWhenStopPosted: boolean | undefined
    serve({
      chat: [
        init => {
          chatSignal = init.signal ?? undefined
          return hang(init)
        }
      ],
      stop: [
        () => {
          abortedWhenStopPosted = chatSignal?.aborted
          return new Response(null, { status: 204 })
        }
      ]
    })
    const { result } = renderThread()

    act(() => result.current.send('long question'))
    await waitFor(() => expect(result.current.status).toBe('submitted'))
    await waitFor(() => expect(chatSignal).toBeDefined())

    await act(() => result.current.stop())

    const [stopRequest] = requests('POST', `/api/chat/${CHAT_ID}/stop`)
    expect(authOf(stopRequest)).toBe('Bearer fake-token')
    // The server is told first; the local read is cancelled after.
    expect(abortedWhenStopPosted).toBe(false)
    expect(chatSignal?.aborted).toBe(true)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.error).toBeUndefined()
  })

  it('still stops locally when the server stop fails, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let chatSignal: AbortSignal | undefined
    serve({
      chat: [
        init => {
          chatSignal = init.signal ?? undefined
          return hang(init)
        }
      ],
      stop: [() => Promise.reject(new TypeError('Load failed'))]
    })
    const { result } = renderThread()

    act(() => result.current.send('long question'))
    await waitFor(() => expect(chatSignal).toBeDefined())
    await act(() => result.current.stop())

    expect(warn).toHaveBeenCalledWith(
      '[thread] stop request failed',
      expect.objectContaining({ status: 0 })
    )
    expect(chatSignal?.aborted).toBe(true)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    warn.mockRestore()
  })

  it('logs a stop the server refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    serve({
      stop: [() => new Response('Authentication required', { status: 401 })]
    })
    const { result } = renderThread()

    await act(() => result.current.stop())

    expect(warn).toHaveBeenCalledWith('[thread] stop request failed', 401)
    warn.mockRestore()
  })

  it('retry regenerates the given assistant message', async () => {
    serve({
      messages: [
        () => json({ messages: [user('u1', 'Q'), assistant('a1', 'Old')] })
      ],
      chat: [() => sse(answerChunks('a2', 'New'))]
    })
    const { result } = renderThread(false)
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.retry('missing-id'))
    expect(requests('POST', '/api/chat')).toHaveLength(0)

    act(() => {
      result.current.retry('a1')
      result.current.retry('a1')
    })

    await waitFor(() =>
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Q'] },
        { role: 'assistant', texts: ['New'] }
      ])
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(chatBodies()).toEqual([
      {
        trigger: 'regenerate-message',
        chatId: CHAT_ID,
        messageId: 'a1',
        isNewChat: false,
        searchMode: 'quality',
        sources: ['web']
      }
    ])
  })

  it('loads an existing chat from /messages', async () => {
    serve({
      messages: [
        () => json({ messages: [user('u1', 'Q'), assistant('a1', 'A')] })
      ]
    })
    const { result } = renderThread(false)
    expect(result.current.loading).toBe(true)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(transcript(result.current.messages)).toEqual([
      { role: 'user', texts: ['Q'] },
      { role: 'assistant', texts: ['A'] }
    ])
    const [load] = requests('GET', `/api/chat/${CHAT_ID}/messages`)
    expect(authOf(load)).toBe('Bearer fake-token')
  })

  it('shows a failed load as the error', async () => {
    serve({ messages: [() => new Response('Chat not found', { status: 404 })] })
    const { result } = renderThread(false)

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.messages).toEqual([])
    expect(result.current.error).toEqual({
      message: 'Chat not found',
      retryable: true,
      authRequired: false
    })
  })

  it('reload re-fetches messages after a failed load', async () => {
    serve({
      messages: [
        () => new Response('Internal error', { status: 500 }),
        () => json({ messages: [user('u1', 'Q'), assistant('a1', 'A')] })
      ]
    })
    const { result } = renderThread(false)
    await waitFor(() => expect(result.current.error).toBeDefined())
    expect(result.current.loading).toBe(false)

    act(() => result.current.reload())
    expect(result.current.loading).toBe(true)
    expect(result.current.error).toBeUndefined()

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(2)
    expect(transcript(result.current.messages)).toEqual([
      { role: 'user', texts: ['Q'] },
      { role: 'assistant', texts: ['A'] }
    ])
    expect(result.current.error).toBeUndefined()
  })

  it('reload does nothing for a new chat, which has nothing saved', async () => {
    serve({})
    const { result } = renderThread()

    act(() => result.current.reload())

    await act(async () => {})
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(false)
  })

  it('drops a load that finishes after the thread is gone', async () => {
    const consoleError = vi.spyOn(console, 'error')
    const pending: Array<(res: Response) => void> = []
    const later = () =>
      new Promise<Response>(resolve => {
        pending.push(resolve)
      })
    serve({ messages: [later, later] })
    const first = renderThread(false)
    const second = renderThread(false)
    await waitFor(() => expect(pending).toHaveLength(2))
    const shown = [first.result.current, second.result.current]

    first.unmount()
    second.unmount()
    await act(async () => {
      pending[0](json({ messages: [user('u1', 'Q')] }))
      pending[1](new Response('Internal error', { status: 500 }))
    })

    // Nothing landed in the unmounted hooks, and React saw no late update.
    expect(first.result.current).toBe(shown[0])
    expect(second.result.current).toBe(shown[1])
    expect(first.result.current.messages).toEqual([])
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('a superseded load does not overwrite the newer one', async () => {
    let answerFirst: (res: Response) => void = () => {}
    serve({
      messages: [
        () =>
          new Promise<Response>(resolve => {
            answerFirst = resolve
          }),
        () => json({ messages: [user('u1', 'Newer')] })
      ]
    })
    const { result } = renderThread(false)
    await waitFor(() =>
      expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
    )

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      answerFirst(json({ messages: [user('u0', 'Older')] }))
      // Past the 100 ms message throttle, so a late update would show.
      await new Promise(resolve => setTimeout(resolve, 150))
    })

    expect(transcript(result.current.messages)).toEqual([
      { role: 'user', texts: ['Newer'] }
    ])
  })

  it('does not let a late load overwrite a question sent meanwhile', async () => {
    let answerLoad: (res: Response) => void = () => {}
    serve({
      messages: [
        () =>
          new Promise<Response>(resolve => {
            answerLoad = resolve
          })
      ],
      chat: [hang]
    })
    const { result } = renderThread(false)
    await waitFor(() =>
      expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
    )
    act(() => result.current.send('Asked early'))
    await waitFor(() => expect(result.current.status).toBe('submitted'))

    await act(async () => {
      answerLoad(json({ messages: [user('u0', 'Saved')] }))
      // Past the 100 ms message throttle, so a late update would show.
      await new Promise(resolve => setTimeout(resolve, 150))
    })

    expect(transcript(result.current.messages)).toEqual([
      { role: 'user', texts: ['Asked early'] }
    ])
    expect(result.current.loading).toBe(false)
  })

  it('loads the next chat when the chat id changes', async () => {
    const pending: Record<string, (res: Response) => void> = {}
    fetchMock.mockImplementation(
      async input =>
        new Promise<Response>(resolve => {
          pending[String(input)] = resolve
        })
    )
    const { result, rerender } = renderHook(
      ({ chatId }) => useThread({ chatId, isNew: false, settings }),
      { wrapper, initialProps: { chatId: 'chat-a' } }
    )
    await waitFor(() =>
      expect(pending[`${BASE}/api/chat/chat-a/messages`]).toBeDefined()
    )
    await act(async () =>
      pending[`${BASE}/api/chat/chat-a/messages`](
        json({ messages: [user('a', 'Chat A')] })
      )
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender({ chatId: 'chat-b' })

    expect(result.current.loading).toBe(true)
    await waitFor(() =>
      expect(pending[`${BASE}/api/chat/chat-b/messages`]).toBeDefined()
    )
    await act(async () =>
      pending[`${BASE}/api/chat/chat-b/messages`](
        json({ messages: [user('b', 'Chat B')] })
      )
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    await waitFor(() =>
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Chat B'] }
      ])
    )
  })

  describe('retryLast', () => {
    it('reloads after a failed load', async () => {
      serve({
        messages: [
          () => new Response('Internal error', { status: 500 }),
          () => json({ messages: [user('u1', 'Q'), assistant('a1', 'A')] })
        ]
      })
      const { result } = renderThread(false)
      await waitFor(() => expect(result.current.error).toBeDefined())

      act(() => result.current.retryLast())

      await waitFor(() => expect(result.current.messages).toHaveLength(2))
      expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(2)
      expect(requests('POST', '/api/chat')).toHaveLength(0)
      expect(result.current.error).toBeUndefined()
    })

    it('regenerates the last answer', async () => {
      serve({
        messages: [
          () => json({ messages: [user('u1', 'Q'), assistant('a1', 'Old')] })
        ],
        chat: [() => sse(answerChunks('a2', 'New'))]
      })
      const { result } = renderThread(false)
      await waitFor(() => expect(result.current.messages).toHaveLength(2))

      act(() => result.current.retryLast())

      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['Q'] },
          { role: 'assistant', texts: ['New'] }
        ])
      )
      expect(chatBodies()).toEqual([
        expect.objectContaining({
          trigger: 'regenerate-message',
          messageId: 'a1'
        })
      ])
    })

    it('retryLast after a failed first submit resends the question', async () => {
      serve({
        chat: [
          () => new Response('No enabled model is available', { status: 503 }),
          () => sse(answerChunks('a1', 'Answer'))
        ]
      })
      const { result } = renderThread()
      act(() => result.current.send('First question'))
      await waitFor(() => expect(result.current.status).toBe('error'))
      expect(result.current.error?.message).toBe(
        'No enabled model is available'
      )
      const failedId = result.current.messages[0].id

      act(() => result.current.retryLast())

      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['First question'] },
          { role: 'assistant', texts: ['Answer'] }
        ])
      )
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(result.current.error).toBeUndefined()
      const [, resend] = chatBodies()
      const question = result.current.messages[0]
      expect(question.id).not.toBe(failedId)
      expect(resend).toEqual({
        trigger: 'submit-message',
        chatId: CHAT_ID,
        message: question,
        isNewChat: true,
        searchMode: 'quality',
        sources: ['web']
      })
    })

    it('resends a later question as part of the existing chat', async () => {
      serve({
        messages: [
          () => json({ messages: [user('u1', 'Q'), assistant('a1', 'A')] })
        ],
        chat: [
          () => Promise.reject(new TypeError('Load failed')),
          () => sse(answerChunks('a2', 'B'))
        ]
      })
      const { result } = renderThread(false)
      await waitFor(() => expect(result.current.messages).toHaveLength(2))
      act(() => result.current.send('Follow-up'))
      await waitFor(() => expect(result.current.status).toBe('error'))

      act(() => result.current.retryLast())

      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['Q'] },
          { role: 'assistant', texts: ['A'] },
          { role: 'user', texts: ['Follow-up'] },
          { role: 'assistant', texts: ['B'] }
        ])
      )
      expect(chatBodies().map(b => [b.trigger, b.isNewChat])).toEqual([
        ['submit-message', false],
        ['submit-message', false]
      ])
    })

    it('does nothing while a turn is in flight', async () => {
      serve({ chat: [hang] })
      const { result } = renderThread()
      act(() => result.current.send('Q'))
      await waitFor(() => expect(result.current.status).toBe('submitted'))

      act(() => result.current.retryLast())

      // Past the 100 ms message throttle, so a change would show.
      await act(() => new Promise(resolve => setTimeout(resolve, 150)))
      expect(requests('POST', '/api/chat')).toHaveLength(1)
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Q'] }
      ])
    })

    it('does nothing for an empty thread', async () => {
      serve({})
      const { result } = renderThread()

      act(() => result.current.retryLast())

      await act(async () => {})
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('background resume', () => {
    /**
     * Sends a question whose answer streams on `live`, then leaves the app
     * with the answer half streamed and the connection dropped.
     */
    async function backgroundMidAnswer(live: ReturnType<typeof liveSse>) {
      const { result } = renderThread()
      await waitFor(() => expect(app.listeners).toHaveLength(1))
      act(() => result.current.send('Q'))
      await waitFor(() => expect(result.current.status).toBe('submitted'))
      live.push({ type: 'start', messageId: 'a1' })
      live.push({ type: 'text-start', id: 't1' })
      live.push({ type: 'text-delta', id: 't1', delta: 'Hel' })
      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['Q'] },
          { role: 'assistant', texts: ['Hel'] }
        ])
      )
      setAppActive(false)
      // iOS suspends the web view: the connection drops.
      live.fail(new TypeError('Load failed'))
      await waitFor(() => expect(result.current.status).toBe('error'))
      return result
    }

    /** backgroundMidAnswer, also handing back unmount. */
    async function backgroundMidAnswerHook(live: ReturnType<typeof liveSse>) {
      const hook = renderThread()
      await waitFor(() => expect(app.listeners).toHaveLength(1))
      act(() => hook.result.current.send('Q'))
      live.push({ type: 'start', messageId: 'a1' })
      await waitFor(() => expect(hook.result.current.status).toBe('streaming'))
      setAppActive(false)
      live.fail(new TypeError('Load failed'))
      await waitFor(() => expect(hook.result.current.status).toBe('error'))
      return hook
    }

    function serveWithLiveChat(
      live: ReturnType<typeof liveSse>,
      routes: Routes
    ) {
      // Like a real fetch, aborting the request errors its body.
      const chat: Handler = init => {
        init.signal?.addEventListener('abort', () =>
          live.fail(
            new DOMException('The operation was aborted.', 'AbortError')
          )
        )
        return live.response
      }
      // Later chat requests (a retry) take the routes' own handlers.
      serve({ ...routes, chat: [chat, ...(routes.chat ?? [])] })
    }

    it('resumes on foreground when a turn was in flight', async () => {
      const live = liveSse()
      const replay = liveSse()
      serveWithLiveChat(live, { stream: [() => replay.response] })
      const result = await backgroundMidAnswer(live)

      setAppActive(true)

      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/stream`)).toHaveLength(1)
      )
      const [reconnect] = requests('GET', `/api/chat/${CHAT_ID}/stream`)
      expect(authOf(reconnect)).toBe('Bearer fake-token')
      for (const chunk of answerChunks('a1', 'Hello')) replay.push(chunk)
      await waitFor(() => expect(result.current.status).toBe('streaming'))

      // Foregrounding again mid-resume does not reconnect a second time.
      setAppActive(false)
      setAppActive(true)
      expect(requests('GET', `/api/chat/${CHAT_ID}/stream`)).toHaveLength(1)
    })

    it('drops the local partial when the replay starts with the same message id', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {
        stream: [() => sse(answerChunks('a1', 'Hello'))]
      })
      const result = await backgroundMidAnswer(live)

      setAppActive(true)

      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['Q'] },
          { role: 'assistant', texts: ['Hello'] }
        ])
      )
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(result.current.messages[1].id).toBe('a1')
      expect(result.current.error).toBeUndefined()
    })

    it('reloads persisted messages when there is nothing to resume', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [
          // The answer is not saved yet on the first look.
          () => json({ messages: [user('u1', 'Q')] }),
          () => json({ messages: [user('u1', 'Q'), assistant('a1', 'Saved')] })
        ]
      })
      const result = await backgroundMidAnswer(live)
      vi.useFakeTimers({ shouldAdvanceTime: true })

      setAppActive(true)
      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      )
      await act(() => vi.advanceTimersByTimeAsync(1000))

      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['Q'] },
          { role: 'assistant', texts: ['Saved'] }
        ])
      )
      expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(2)
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeUndefined()
      // The turn finished on the server while the app was away.
      expect(changed).toHaveBeenCalledExactlyOnceWith('created', CHAT_ID)
      expect(result.current.saved).toBe(true)
    })

    const COULD_NOT_LOAD = {
      message: "Couldn't load the answer",
      retryable: true,
      authRequired: false
    }

    it('gives up on the saved copy after three tries, offering Retry', async () => {
      const live = liveSse()
      const unsaved = () => json({ messages: [user('u1', 'Q')] })
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [unsaved, unsaved, unsaved],
        chat: [() => sse(answerChunks('a2', 'Hello'))]
      })
      const result = await backgroundMidAnswer(live)
      vi.useFakeTimers({ shouldAdvanceTime: true })

      setAppActive(true)
      await act(() => vi.advanceTimersByTimeAsync(3000))

      expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(3)
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Q'] },
        { role: 'assistant', texts: ['Hel'] }
      ])
      await waitFor(() => expect(result.current.error).toEqual(COULD_NOT_LOAD))

      // Retry regenerates the cut-off answer, and the banner goes.
      act(() => result.current.retryLast())
      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['Q'] },
          { role: 'assistant', texts: ['Hello'] }
        ])
      )
      expect(chatBodies().at(-1)).toEqual(
        expect.objectContaining({
          trigger: 'regenerate-message',
          messageId: 'a1'
        })
      )
      expect(result.current.error).toBeUndefined()
    })

    it('offers Retry when the saved copy is not found', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const live = liveSse()
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [() => new Response('Chat not found', { status: 404 })]
      })
      const result = await backgroundMidAnswer(live)

      setAppActive(true)

      await waitFor(() => expect(result.current.error).toEqual(COULD_NOT_LOAD))
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Q'] },
        { role: 'assistant', texts: ['Hel'] }
      ])
      warn.mockRestore()
    })

    it('does not resume a turn that finished normally after foregrounding', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {})
      const { result } = renderThread()
      await waitFor(() => expect(app.listeners).toHaveLength(1))
      act(() => result.current.send('Q'))
      live.push({ type: 'start', messageId: 'a1' })
      live.push({ type: 'text-start', id: 't1' })
      live.push({ type: 'text-delta', id: 't1', delta: 'Hello' })
      await waitFor(() => expect(result.current.status).toBe('streaming'))
      // Away and back while the request still looks alive.
      setAppActive(false)
      setAppActive(true)

      // The connection survived: the answer simply ends.
      live.push({ type: 'text-end', id: 't1' })
      live.push({ type: 'finish' })
      live.close()
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(() => new Promise(resolve => setTimeout(resolve, 50)))

      expect(requests('GET', `/api/chat/${CHAT_ID}/stream`)).toHaveLength(0)
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Q'] },
        { role: 'assistant', texts: ['Hello'] }
      ])
    })

    it('keeps a new turn started while the saved copy was pending', async () => {
      const live = liveSse()
      serve({
        chat: [() => live.response, hang],
        stream: [() => new Response(null, { status: 204 })],
        messages: [
          () => json({ messages: [user('u1', 'Q')] }),
          () => json({ messages: [user('u1', 'Q'), assistant('a1', 'Saved')] })
        ]
      })
      const result = await backgroundMidAnswer(live)
      vi.useFakeTimers({ shouldAdvanceTime: true })

      setAppActive(true)
      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      )
      act(() => result.current.send('Next question'))
      await waitFor(() => expect(result.current.status).toBe('submitted'))
      await act(() => vi.advanceTimersByTimeAsync(1000))

      expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(2)
      expect(transcript(result.current.messages).at(-1)).toEqual({
        role: 'user',
        texts: ['Next question']
      })
    })

    it('keeps the local partial when the replay is a different message', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {
        stream: [() => sse(answerChunks('a2', 'Newer'))]
      })
      const result = await backgroundMidAnswer(live)

      setAppActive(true)

      await waitFor(() => expect(result.current.messages).toHaveLength(3))
      await waitFor(() => expect(result.current.status).toBe('ready'))
      const [, partial, replayed] = result.current.messages
      expect(partial.id).toBe('a1')
      expect(transcript([partial])).toEqual([
        { role: 'assistant', texts: ['Hel'] }
      ])
      expect(replayed.id).toBe('a2')
      // The SDK builds a resumed turn on top of the last assistant message,
      // so the appended one also carries the partial's parts (same as web).
      expect(transcript([replayed])).toEqual([
        { role: 'assistant', texts: ['Hel', 'Newer'] }
      ])
    })

    it('stops at an empty saved copy without retrying', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [() => json({ messages: [] })]
      })
      const result = await backgroundMidAnswer(live)
      vi.useFakeTimers({ shouldAdvanceTime: true })

      setAppActive(true)
      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      )
      await act(() => vi.advanceTimersByTimeAsync(3000))

      expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Q'] },
        { role: 'assistant', texts: ['Hel'] }
      ])
      expect(result.current.error).toEqual(COULD_NOT_LOAD)
    })

    it('stops the saved-copy retries when the thread goes away', async () => {
      const live = liveSse()
      const unsaved = () => json({ messages: [user('u1', 'Q')] })
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [unsaved, unsaved, unsaved]
      })
      const { result, unmount } = await backgroundMidAnswerHook(live)
      expect(result.current.status).toBe('error')
      vi.useFakeTimers({ shouldAdvanceTime: true })

      setAppActive(true)
      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      )
      unmount()
      await act(() => vi.advanceTimersByTimeAsync(3000))

      expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
    })

    it('does not show a failed reload in the next chat', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const live = liveSse()
      let failReload: (res: Response) => void = () => {}
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [
          () =>
            new Promise<Response>(resolve => {
              failReload = resolve
            })
        ]
      })
      const { result, rerender } = await backgroundMidAnswerHook(live)

      setAppActive(true)
      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      )
      rerender({ chatId: 'chat-2' })
      await act(async () => {
        failReload(new Response('Internal error', { status: 500 }))
      })
      await act(async () => {})

      expect(warn).toHaveBeenCalled()
      expect(result.current.error).toBeUndefined()
      warn.mockRestore()
    })

    it('does not put a saved copy into the next chat', async () => {
      const live = liveSse()
      let answerReload: (res: Response) => void = () => {}
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [
          () =>
            new Promise<Response>(resolve => {
              answerReload = resolve
            })
        ]
      })
      const { result, rerender } = await backgroundMidAnswerHook(live)

      setAppActive(true)
      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      )
      rerender({ chatId: 'chat-2' })
      await act(async () => {
        answerReload(
          json({ messages: [user('u1', 'Q'), assistant('a1', 'Saved')] })
        )
        // Past the 100 ms message throttle, so a late update would show.
        await new Promise(resolve => setTimeout(resolve, 150))
      })

      expect(result.current.messages).toEqual([])
    })

    /**
     * Leaves the app mid-answer and comes back while the request still looks
     * alive; the suspended request only errors after that.
     */
    async function foregroundBeforeTheDropIsSeen(
      live: ReturnType<typeof liveSse>
    ) {
      const { result } = renderThread()
      await waitFor(() => expect(app.listeners).toHaveLength(1))
      act(() => result.current.send('Q'))
      await waitFor(() => expect(result.current.status).toBe('submitted'))
      live.push({ type: 'start', messageId: 'a1' })
      live.push({ type: 'text-start', id: 't1' })
      live.push({ type: 'text-delta', id: 't1', delta: 'Hel' })
      await waitFor(() => expect(result.current.status).toBe('streaming'))

      setAppActive(false)
      setAppActive(true)
      await act(async () => {})
      expect(requests('GET', `/api/chat/${CHAT_ID}/stream`)).toHaveLength(0)

      live.fail(new TypeError('Load failed'))
      return result
    }

    it('resumes after the suspended request errors post-foreground', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [
          () => json({ messages: [user('u1', 'Q'), assistant('a1', 'Hello')] })
        ]
      })
      const result = await foregroundBeforeTheDropIsSeen(live)

      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      )
      expect(requests('GET', `/api/chat/${CHAT_ID}/stream`)).toHaveLength(1)
      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['Q'] },
          { role: 'assistant', texts: ['Hello'] }
        ])
      )
      expect(result.current.status).toBe('ready')
      expect(result.current.error).toBeUndefined()
    })

    it('replays a still-live turn after the suspended request errors post-foreground', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {
        stream: [() => sse(answerChunks('a1', 'Hello'))]
      })
      const result = await foregroundBeforeTheDropIsSeen(live)

      await waitFor(() =>
        expect(transcript(result.current.messages)).toEqual([
          { role: 'user', texts: ['Q'] },
          { role: 'assistant', texts: ['Hello'] }
        ])
      )
      await waitFor(() => expect(result.current.status).toBe('ready'))
      expect(result.current.error).toBeUndefined()
    })

    it('does not resume a chat the user has left', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {})
      const { result, rerender } = renderThread()
      await waitFor(() => expect(app.listeners).toHaveLength(1))
      act(() => result.current.send('Q'))
      live.push({ type: 'start', messageId: 'a1' })
      await waitFor(() => expect(result.current.status).toBe('streaming'))
      setAppActive(false)
      setAppActive(true)

      rerender({ chatId: 'chat-2' })
      live.fail(new TypeError('Load failed'))
      await act(() => new Promise(resolve => setTimeout(resolve, 50)))

      expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
        `${BASE}/api/chat`
      ])
    })

    it('does not resume after the user stopped the turn', async () => {
      const live = liveSse()
      serveWithLiveChat(live, {
        stop: [() => new Response(null, { status: 204 })]
      })
      const { result } = renderThread()
      await waitFor(() => expect(app.listeners).toHaveLength(1))
      act(() => result.current.send('Q'))
      live.push({ type: 'start', messageId: 'a1' })
      await waitFor(() => expect(result.current.status).toBe('streaming'))
      setAppActive(false)
      setAppActive(true)

      await act(() => result.current.stop())

      await waitFor(() => expect(result.current.status).toBe('ready'))
      await act(async () => {})
      expect(requests('GET', `/api/chat/${CHAT_ID}/stream`)).toHaveLength(0)
    })

    it('keeps what is on screen when the reload fails, offering Retry', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const live = liveSse()
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [() => new Response('Internal error', { status: 500 })]
      })
      const result = await backgroundMidAnswer(live)

      setAppActive(true)
      await waitFor(() =>
        expect(requests('GET', `/api/chat/${CHAT_ID}/messages`)).toHaveLength(1)
      )
      await waitFor(() => expect(result.current.error).toEqual(COULD_NOT_LOAD))
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Q'] },
        { role: 'assistant', texts: ['Hel'] }
      ])
      expect(warn).toHaveBeenCalledWith(
        '[thread] reload after resume failed',
        expect.any(Error)
      )
      warn.mockRestore()
    })

    it('does not resume when no turn was in flight', async () => {
      serve({ chat: [() => sse(answerChunks('a1', 'Done'))] })
      const { result } = renderThread()
      await waitFor(() => expect(app.listeners).toHaveLength(1))
      act(() => result.current.send('Q'))
      await waitFor(() => expect(result.current.status).toBe('ready'))
      await waitFor(() => expect(result.current.messages).toHaveLength(2))

      setAppActive(false)
      setAppActive(true)

      await act(async () => {})
      expect(requests('GET', `/api/chat/${CHAT_ID}/stream`)).toHaveLength(0)
    })

    it('removes the app listener on unmount', async () => {
      serve({})
      const { unmount } = renderThread()
      await waitFor(() => expect(app.listeners).toHaveLength(1))

      unmount()

      await waitFor(() => expect(app.remove).toHaveBeenCalledTimes(1))
    })
  })

  describe('the chat history', () => {
    const touches = () => requests('POST', `/api/chats/${CHAT_ID}/touch`)

    it('touches a saved chat once when it opens, even mounted twice, then tells the list', async () => {
      let answerTouch!: (response: Response) => void
      serve({
        messages: [() => json({ messages: [] })],
        touch: [() => new Promise<Response>(resolve => (answerTouch = resolve))]
      })
      const { result } = renderHook(
        () => useThread({ chatId: CHAT_ID, isNew: false, settings }),
        {
          wrapper: ({ children }) => (
            <StrictMode>
              <ApiProvider baseUrl={BASE}>{children}</ApiProvider>
            </StrictMode>
          )
        }
      )
      await waitFor(() => expect(result.current.loading).toBe(false))

      expect(touches()).toHaveLength(1)
      expect(authOf(touches()[0])).toBe('Bearer fake-token')
      // The list is told only once the view is recorded (for "recent").
      expect(changed).not.toHaveBeenCalled()

      await act(async () => answerTouch(new Response(null, { status: 204 })))

      expect(changed).toHaveBeenCalledExactlyOnceWith('updated', CHAT_ID)
    })

    it('tells the list even when the touch fails', async () => {
      serve({
        messages: [() => json({ messages: [] })],
        touch: [() => Promise.reject(new TypeError('Load failed'))]
      })
      renderThread(false)

      await waitFor(() =>
        expect(changed).toHaveBeenCalledExactlyOnceWith('updated', CHAT_ID)
      )
    })

    it('never touches a new chat', async () => {
      serve({ chat: [() => sse(answerChunks('a1', 'A', 'T'))] })
      const { result } = renderThread()
      act(() => result.current.send('Q'))
      await waitFor(() => expect(result.current.title).toBe('T'))

      expect(touches()).toHaveLength(0)
    })

    it('a saved chat exists on the server from the start', () => {
      serve({ messages: [() => hang()] })
      const { result } = renderThread(false)
      expect(result.current.saved).toBe(true)
    })

    it('a new chat is created by its first answer, then updated by the next', async () => {
      serve({
        chat: [
          () => sse(answerChunks('a1', 'One', 'Title')),
          () => sse(answerChunks('a2', 'Two'))
        ]
      })
      const { result } = renderThread()
      expect(result.current.saved).toBe(false)

      act(() => result.current.send('first'))
      await waitFor(() => expect(result.current.saved).toBe(true))
      expect(changed).toHaveBeenCalledExactlyOnceWith('created', CHAT_ID)
      await waitFor(() => expect(result.current.status).toBe('ready'))

      act(() => result.current.send('second'))
      await waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
      expect(changed).toHaveBeenLastCalledWith('updated', CHAT_ID)
    })

    it('a saved chat is updated by each answer', async () => {
      serve({
        messages: [
          () => json({ messages: [user('u1', 'Q'), assistant('a1', 'A')] })
        ],
        chat: [() => sse(answerChunks('a2', 'More'))]
      })
      const { result } = renderThread(false)
      await waitFor(() => expect(result.current.loading).toBe(false))
      // Opening it (the touch) is the first update.
      await waitFor(() => expect(changed).toHaveBeenCalledOnce())

      act(() => result.current.send('follow-up'))

      await waitFor(() => expect(changed).toHaveBeenCalledTimes(2))
      expect(changed.mock.calls).toEqual([
        ['updated', CHAT_ID],
        ['updated', CHAT_ID]
      ])
    })

    it('a failed turn changes nothing', async () => {
      serve({
        chat: [() => json({ error: 'Internal error', retryable: true }, 500)]
      })
      const { result } = renderThread()

      act(() => result.current.send('Q'))
      await waitFor(() => expect(result.current.status).toBe('error'))

      expect(changed).not.toHaveBeenCalled()
      expect(result.current.saved).toBe(false)
    })

    it('a stopped turn updates the chat, which then exists', async () => {
      serve({
        chat: [init => hang(init)],
        stop: [() => new Response(null, { status: 204 })]
      })
      const { result } = renderThread()
      act(() => result.current.send('long question'))
      await waitFor(() => expect(result.current.status).toBe('submitted'))

      await act(() => result.current.stop())

      expect(changed).toHaveBeenCalledExactlyOnceWith('updated', CHAT_ID)
      expect(result.current.saved).toBe(true)
    })

    it('leaving mid-turn emits nothing', async () => {
      let chatSignal: AbortSignal | undefined
      serve({
        chat: [
          init => {
            chatSignal = init.signal ?? undefined
            return hang(init)
          }
        ]
      })
      const { result, unmount } = renderThread()
      act(() => result.current.send('long question'))
      await waitFor(() => expect(chatSignal).toBeDefined())

      unmount()
      await waitFor(() => expect(chatSignal?.aborted).toBe(true))
      await act(async () => {})

      expect(changed).not.toHaveBeenCalled()
    })
  })
})
