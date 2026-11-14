import { after, NextResponse } from 'next/server'

import { generateFollowups } from '@/lib/agents/followup-generator'
import { getCurrentUserId } from '@/lib/auth/get-current-user'
import {
  getChat,
  getMessageFollowups,
  saveMessageFollowups
} from '@/lib/db/actions'
import type { FollowupRequest } from '@/lib/followups/types'

// Bounds on what the client may send. The generator cuts the answer again
// (it only needs the opening); these keep a hostile body from reaching it.
const MAX_QUESTION_CHARS = 2000
const MAX_ANSWER_CHARS = 20000
const MAX_PREVIOUS_QUESTIONS = 10
const MAX_PREVIOUS_QUESTION_CHARS = 300

// App CORS (preflight + headers) comes from proxy.ts, which runs for /api/*.
export async function POST(req: Request): Promise<Response> {
  const res = await followups(req)
  res.headers.set('Cache-Control', 'no-store')
  return res
}

function json(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status })
}

async function followups(req: Request): Promise<Response> {
  const userId = await getCurrentUserId()
  if (!userId) return json({ error: 'Unauthorized' }, 401)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }
  const input = parseRequest(body)
  if (!input) {
    return json({ error: 'question and answer must be strings' }, 400)
  }

  const { chatId, messageId } = input
  const persisted = Boolean(chatId && messageId)

  try {
    if (persisted) {
      const chat = await getChat(chatId!, userId)
      if (!chat || chat.userId !== userId) {
        return json({ error: 'Not found' }, 404)
      }
      const existing = await getMessageFollowups(chatId!, messageId!, userId)
      if (existing) return json({ questions: existing })
    }
  } catch (error) {
    console.error('[followups] lookup failed', error)
    return json({ error: 'Internal error' }, 500)
  }

  // No abort signal: the client may leave (new turn, closed tab) and the
  // questions should still be written and saved for the next load.
  let result: Awaited<ReturnType<typeof generateFollowups>>
  try {
    result = await generateFollowups({
      question: input.question,
      answer: input.answer,
      previousQuestions: input.previousQuestions
    })
  } catch (error) {
    console.error('[followups] generation failed', error)
    return json({ questions: [] })
  }

  if (persisted && result.outcome === 'ok' && result.questions.length > 0) {
    const questions = result.questions
    after(async () => {
      try {
        const ok = await saveMessageFollowups(
          chatId!,
          messageId!,
          userId,
          questions
        )
        if (!ok) {
          console.warn(
            `[followups] save skipped chat=${chatId} message=${messageId}: message not found`
          )
        }
      } catch (error) {
        console.error(
          `[followups] save failed chat=${chatId} message=${messageId}`,
          error
        )
      }
    })
  }

  return json({ questions: result.questions })
}

type ParsedRequest = Required<Pick<FollowupRequest, 'question' | 'answer'>> & {
  previousQuestions: string[]
  chatId?: string
  messageId?: string
}

function parseRequest(body: unknown): ParsedRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (typeof b.question !== 'string' || typeof b.answer !== 'string') {
    return null
  }
  const previous = Array.isArray(b.previousQuestions)
    ? b.previousQuestions.filter((q): q is string => typeof q === 'string')
    : []
  return {
    question: b.question.slice(0, MAX_QUESTION_CHARS),
    answer: b.answer.slice(0, MAX_ANSWER_CHARS),
    previousQuestions: previous
      .slice(-MAX_PREVIOUS_QUESTIONS)
      .map(q => q.slice(0, MAX_PREVIOUS_QUESTION_CHARS)),
    chatId: nonEmptyString(b.chatId),
    messageId: nonEmptyString(b.messageId)
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
