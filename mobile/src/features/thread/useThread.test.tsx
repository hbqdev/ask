import { act, renderHook, waitFor } from '@testing-library/react'
import type { UIMessage } from 'ai'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiProvider } from '@/core/api/ApiProvider'
import { useAuth, type Auth } from '@/core/auth/AuthProvider'
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
    fail: (error: Error) => controller.error(error)
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
  Record<'chat' | 'stop' | 'stream' | 'messages', Handler[]>
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
              : null
    const handler = key ? routes[key]?.shift() : undefined
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
  return renderHook(() => useThread({ chatId: CHAT_ID, isNew, settings }), {
    wrapper
  })
}

function setAppActive(isActive: boolean) {
  act(() => {
    for (const listener of app.listeners) listener({ isActive })
  })
}

// --- Tests ------------------------------------------------------------------

describe('useThread', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    app.listeners.length = 0
    getAccessToken.mockResolvedValue('fake-token')
    vi.mocked(useAuth).mockReturnValue({ getAccessToken } as unknown as Auth)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
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

    function serveWithLiveChat(
      live: ReturnType<typeof liveSse>,
      routes: Routes
    ) {
      serve({ chat: [() => live.response], ...routes })
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
    })

    it('gives up on the saved copy after three tries', async () => {
      const live = liveSse()
      const unsaved = () => json({ messages: [user('u1', 'Q')] })
      serveWithLiveChat(live, {
        stream: [() => new Response(null, { status: 204 })],
        messages: [unsaved, unsaved, unsaved]
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

    it('keeps what is on screen when the reload fails', async () => {
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
      await act(async () => {})
      expect(transcript(result.current.messages)).toEqual([
        { role: 'user', texts: ['Q'] },
        { role: 'assistant', texts: ['Hel'] }
      ])
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
})
