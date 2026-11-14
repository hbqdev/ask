import { beforeEach, describe, expect, it, vi } from 'vitest'

// after() needs a live Next request scope; capture its tasks instead so a
// test decides when the background save runs (runAfterTasks below).
const afterTasks = vi.hoisted(() => [] as Array<unknown>)
vi.mock('next/server', async importOriginal => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn((task: unknown) => {
    afterTasks.push(task)
  })
}))

vi.mock('@/lib/auth/get-current-user', () => ({
  getCurrentUserId: vi.fn()
}))
vi.mock('@/lib/agents/followup-generator', () => ({
  generateFollowups: vi.fn()
}))
vi.mock('@/lib/db/actions', () => ({
  getChat: vi.fn(),
  getMessageFollowups: vi.fn(),
  saveMessageFollowups: vi.fn()
}))

import { after } from 'next/server'

import { generateFollowups } from '@/lib/agents/followup-generator'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import {
  getChat,
  getMessageFollowups,
  saveMessageFollowups
} from '@/lib/db/actions'

import { POST } from '../route'

const USER = 'user-1'
const QS = ['How much does it cost?', 'Is it open on Sunday?', 'Where is it?']

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/chat/followups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

async function runAfterTasks() {
  const tasks = afterTasks.splice(0)
  await Promise.all(tasks.map(t => (typeof t === 'function' ? t() : t)))
}

function okResult(questions = QS) {
  return { questions, outcome: 'ok' as const, ms: 10, model: 'm' }
}

beforeEach(() => {
  vi.clearAllMocks()
  afterTasks.length = 0
  vi.mocked(getCurrentUserId).mockResolvedValue(USER)
  vi.mocked(generateFollowups).mockResolvedValue(okResult())
  vi.mocked(getChat).mockResolvedValue({ id: 'c1', userId: USER } as any)
  vi.mocked(getMessageFollowups).mockResolvedValue(null)
  vi.mocked(saveMessageFollowups).mockResolvedValue(true)
})

const base = { question: 'Best ramen in Hanoi?', answer: 'Try X and Y.' }
const saved = { ...base, chatId: 'c1', messageId: 'm1' }

describe('POST /api/chat/followups', () => {
  it('401 without a user', async () => {
    vi.mocked(getCurrentUserId).mockResolvedValue(undefined as any)
    const res = await POST(makeRequest(base))
    expect(res.status).toBe(401)
    expect(generateFollowups).not.toHaveBeenCalled()
  })

  it.each([
    ['question missing', { answer: 'a' }],
    ['answer missing', { question: 'q' }],
    ['question not a string', { question: 1, answer: 'a' }],
    ['answer not a string', { question: 'q', answer: ['a'] }],
    ['body not an object', ['q', 'a']]
  ])('400 when %s', async (_name, body) => {
    const res = await POST(makeRequest(body))
    expect(res.status).toBe(400)
    expect(generateFollowups).not.toHaveBeenCalled()
  })

  it('400 when the body is not JSON', async () => {
    const res = await POST(makeRequest('{not json'))
    expect(res.status).toBe(400)
  })

  it('returns saved questions without generating when chatId+messageId already have followups', async () => {
    vi.mocked(getMessageFollowups).mockResolvedValue(['Saved one?'])
    const res = await POST(makeRequest(saved))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ questions: ['Saved one?'] })
    expect(getMessageFollowups).toHaveBeenCalledWith('c1', 'm1', USER)
    expect(generateFollowups).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it('generates, returns questions, and saves in after() when chatId+messageId are given', async () => {
    const res = await POST(makeRequest(saved))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ questions: QS })
    // The save is deferred: nothing written until after() runs.
    expect(saveMessageFollowups).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalledTimes(1)
    await runAfterTasks()
    expect(saveMessageFollowups).toHaveBeenCalledWith('c1', 'm1', USER, QS)
  })

  it('generates without saving when chatId/messageId are absent', async () => {
    const res = await POST(makeRequest(base))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ questions: QS })
    expect(getChat).not.toHaveBeenCalled()
    expect(getMessageFollowups).not.toHaveBeenCalled()
    await runAfterTasks()
    expect(after).not.toHaveBeenCalled()
    expect(saveMessageFollowups).not.toHaveBeenCalled()
  })

  it('generates without saving when only one of chatId/messageId is given', async () => {
    const res = await POST(makeRequest({ ...base, chatId: 'c1' }))
    expect(await res.json()).toEqual({ questions: QS })
    expect(getChat).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })

  it.each(['skip', 'timeout', 'error'] as const)(
    'does not save when the outcome is %s (not ok)',
    async outcome => {
      vi.mocked(generateFollowups).mockResolvedValue({
        questions: [],
        outcome,
        ms: 5,
        model: 'm'
      })
      const res = await POST(makeRequest(saved))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ questions: [] })
      await runAfterTasks()
      expect(saveMessageFollowups).not.toHaveBeenCalled()
    }
  )

  it('returns { questions: [] } with 200 on generator timeout/error', async () => {
    vi.mocked(generateFollowups).mockResolvedValue({
      questions: [],
      outcome: 'timeout',
      ms: 6000,
      model: 'm'
    })
    let res = await POST(makeRequest(base))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ questions: [] })

    // Even a generator that breaks its never-throws contract fails silently.
    vi.mocked(generateFollowups).mockRejectedValue(new Error('boom'))
    res = await POST(makeRequest(base))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ questions: [] })
  })

  it('truncates question to 2000 chars, answer to 20000, previousQuestions to the last 10 × 300 chars', async () => {
    const previous = Array.from({ length: 14 }, (_, i) =>
      `${i}`.padEnd(400, 'p')
    )
    await POST(
      makeRequest({
        question: 'q'.repeat(2500),
        answer: 'a'.repeat(25000),
        previousQuestions: [...previous.slice(0, 2), 42, ...previous.slice(2)]
      })
    )
    const input = vi.mocked(generateFollowups).mock.calls[0][0]
    expect(input.question).toBe('q'.repeat(2000))
    expect(input.answer).toBe('a'.repeat(20000))
    expect(input.previousQuestions).toHaveLength(10)
    expect(input.previousQuestions[0]).toBe(previous[4].slice(0, 300))
    expect(input.previousQuestions[9]).toBe(previous[13].slice(0, 300))
    expect(input.previousQuestions.every(q => q.length === 300)).toBe(true)
  })

  it('treats a non-array previousQuestions as none', async () => {
    await POST(makeRequest({ ...base, previousQuestions: 'nope' }))
    expect(
      vi.mocked(generateFollowups).mock.calls[0][0].previousQuestions
    ).toEqual([])
  })

  it('does not pass the request abort signal to the generator', async () => {
    const controller = new AbortController()
    const req = new Request('http://localhost:3000/api/chat/followups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(saved),
      signal: controller.signal
    })
    await POST(req)
    const input = vi.mocked(generateFollowups).mock.calls[0][0]
    expect(input.abortSignal).toBeUndefined()
    expect(Object.keys(input).sort()).toEqual([
      'answer',
      'previousQuestions',
      'question'
    ])
  })

  it.each([
    ['missing', null],
    ['owned by someone else', { id: 'c1', userId: 'other-user' }]
  ])(
    '404 without generating or saving when the chat is %s',
    async (_name, chat) => {
      vi.mocked(getChat).mockResolvedValue(chat as any)
      const res = await POST(makeRequest(saved))
      expect(res.status).toBe(404)
      expect(getChat).toHaveBeenCalledWith('c1', USER)
      expect(getMessageFollowups).not.toHaveBeenCalled()
      expect(generateFollowups).not.toHaveBeenCalled()
      await runAfterTasks()
      expect(saveMessageFollowups).not.toHaveBeenCalled()
    }
  )

  it('catches and logs a failed save inside after()', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(saveMessageFollowups).mockRejectedValue(new Error('db down'))
    const res = await POST(makeRequest(saved))
    expect(res.status).toBe(200)
    await expect(runAfterTasks()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('[followups] save failed'),
      expect.any(Error)
    )
    error.mockRestore()
  })

  it('logs when the save gives up without an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(saveMessageFollowups).mockResolvedValue(false)
    await POST(makeRequest(saved))
    await runAfterTasks()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[followups] save skipped')
    )
    warn.mockRestore()
  })

  it('sets Cache-Control: no-store', async () => {
    const res = await POST(makeRequest(base))
    expect(res.headers.get('cache-control')).toBe('no-store')
    const unauth = await (async () => {
      vi.mocked(getCurrentUserId).mockResolvedValue(undefined as any)
      return POST(makeRequest(base))
    })()
    expect(unauth.headers.get('cache-control')).toBe('no-store')
  })
})
