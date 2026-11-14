import { generateText } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

import { createTimeoutFetch } from '../utils/fetch-with-timeout'

export const MAX_FOLLOWUPS = 3
export const MAX_FOLLOWUP_CHARS = 150

const norm = (s: string) => s.trim().toLowerCase()

/**
 * The JSON array in the model's text, or null when there is none. Models wrap
 * the array in prose or a ```json fence, so take the first `[` to the last `]`
 * and parse that span.
 */
function readArray(text: string): unknown[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

/**
 * The usable follow-up questions in an array: strings only, 1-150 chars, no
 * repeats of each other or of questions already asked, at most 3. Anything
 * unusable is dropped rather than repaired.
 */
function cleanFollowups(items: unknown[], asked: string[]): string[] {
  const seen = new Set(asked.map(norm))
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const q = item.trim()
    if (q.length < 1 || q.length > MAX_FOLLOWUP_CHARS) continue
    const key = norm(q)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(q)
    if (out.length === MAX_FOLLOWUPS) break
  }
  return out
}

/** Pull the follow-up questions out of the model's text ([] when none). */
export function parseFollowups(text: string, asked: string[]): string[] {
  const items = readArray(text)
  return items ? cleanFollowups(items, asked) : []
}

const MAX_LOGGED_ERROR_CHARS = 120

/** `<name>:<message>` of a thrown value, on one line, message cut to 120. */
function describeError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err
  const message = (err instanceof Error ? err.message : String(err))
    .replace(/\s+/g, ' ')
    .slice(0, MAX_LOGGED_ERROR_CHARS)
  return `${name}:${message}`
}

export type FollowupInput = {
  question: string
  answer: string
  previousQuestions: string[]
  abortSignal?: AbortSignal
}

export type FollowupResult = {
  questions: string[]
  outcome: 'ok' | 'skip' | 'timeout' | 'error'
  ms: number
  model: string
}

// The answer is cut before it reaches the prompt: the questions are anchored in
// what the answer covers, and its opening carries that. A full quality-mode
// report would only add prefill latency.
const MAX_ANSWER_CHARS = 6000
const DEFAULT_TIMEOUT_MS = 6000

// Env is read per call, not at import, so a change takes effect without a
// redeploy (same reasoning as title-generator.ts).
function followupModelId(): string {
  return (
    process.env.FOLLOWUP_MODEL_ID ||
    process.env.CLASSIFIER_MODEL_ID ||
    'deepseek-v4-pro:cloud'
  )
}

function followupTimeoutMs(): number {
  const n = Number(process.env.FOLLOWUP_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

const SYSTEM_PROMPT = `You suggest what the user might ask next, after reading their question and the answer they got.

Write exactly 3 short follow-up questions the user is likely to ask next.
- Anchor each one in specifics of this answer: the names, numbers, options, steps or claims it actually mentions.
- No generic questions such as "Tell me more" or "Can you elaborate?".
- Do not repeat or rephrase any question the user has already asked.
- Write them in the same language as the user's question.
- Phrase each as the user would type it, under 150 characters.

Output only a JSON array of strings, with no other text, for example: ["First question?","Second question?","Third question?"]
Output [] only if the user's message is just a greeting, thanks or an acknowledgement.`

function buildPrompt({
  question,
  answer,
  previousQuestions
}: FollowupInput): string {
  const earlier = previousQuestions.length
    ? previousQuestions.map(q => `- ${q}`).join('\n')
    : '(none)'
  return `Earlier questions in this chat:\n${earlier}\n\nLatest question:\n${question}\n\nAnswer:\n${answer.slice(0, MAX_ANSWER_CHARS)}`
}

/**
 * Writes up to 3 follow-up questions for an answer, on the classifier's host
 * and transport. Never throws: every failure is an outcome, so a caller can
 * treat follow-ups as optional decoration on the turn.
 */
export async function generateFollowups(
  input: FollowupInput
): Promise<FollowupResult> {
  const startedAt = performance.now()
  const model = followupModelId()
  // `extra` ends the log line: err=<name>:<message> on an error, parse=ok|fail
  // once the model replied (fail: no JSON array in its text, which is still
  // a skip to the caller but a prompt/model problem to whoever reads the log).
  const done = (
    outcome: FollowupResult['outcome'],
    questions: string[] = [],
    extra = ''
  ): FollowupResult => {
    const ms = Math.round(performance.now() - startedAt)
    console.info(
      `[followups] model=${model} ms=${ms} outcome=${outcome} n=${questions.length}${extra}`
    )
    return { questions, outcome, ms, model }
  }

  const baseURL =
    process.env.CLASSIFIER_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL
  if (!baseURL) return done('error')

  const timeoutMs = followupTimeoutMs()
  // ai-sdk-ollama drops the AI SDK's abortSignal, so the deadline is enforced
  // twice: our own timer aborts the call (and lets us tell a timeout from an
  // error), and createTimeoutFetch cuts the HTTP request itself.
  const timeout = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    timeout.abort()
  }, timeoutMs)
  const signal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, timeout.signal])
    : timeout.signal

  try {
    const provider = createOllama({
      baseURL,
      fetch: createTimeoutFetch(timeoutMs, signal)
    })
    const { text } = await generateText({
      model: provider(model, { think: false }),
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(input),
      abortSignal: signal
    })
    const items = readArray(text)
    const questions = items
      ? cleanFollowups(items, [input.question, ...input.previousQuestions])
      : []
    return done(
      questions.length ? 'ok' : 'skip',
      questions,
      ` parse=${items ? 'ok' : 'fail'}`
    )
  } catch (err) {
    return timedOut
      ? done('timeout')
      : done('error', [], ` err=${describeError(err)}`)
  } finally {
    clearTimeout(timer)
  }
}
