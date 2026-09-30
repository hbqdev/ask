import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart
} from '@ai-sdk/provider'

/**
 * Give the model the citation reminder on the step that writes the ANSWER, and
 * on no other step.
 *
 * WHY NOT SIMPLY APPEND IT TO EVERY LATE STEP. Replaying stored long quality
 * turns against kimi-k2.6 (see lib/agents/citation-reminder.ts) showed that a
 * trailing user message restores inline `cite`-copied citations, but that the
 * same message also decides whether the model keeps researching, and which way
 * depends on its wording: one wording made the model answer at step 8, where
 * it continued researching 3/3 without the message, and another made it call
 * tools 6/6 at the answer step, even with no tools advertised. A reminder
 * that steers the research loop is not model-agnostic, so it must not be
 * visible while the model is still choosing whether to research.
 *
 * HOW. On a guarded step the model is called as usual and its stream is
 * buffered until it shows which way it went:
 * - a tool call (tool-input-start / tool-call) means research continues, so
 *   the buffered parts and the rest of the stream pass through untouched;
 * - answer text (a markdown heading, or ANSWER_TEXT_CHARS characters of text
 *   without a tool call) means this step is the answer, so that attempt is
 *   aborted and the step is re-run once with the reminder appended as a
 *   trailing user message. Nothing of the aborted attempt reaches the client.
 *
 * Cost, on guarded answer steps only: the aborted attempt's time to its first
 * heading token (prompt processing plus a few tokens) and one extra pass over
 * the prompt. Research steps pay nothing beyond buffering until the tool call
 * arrives, and Ollama delivers tool calls whole.
 *
 * The aborted attempt is cut off at the HTTP layer, not just unread:
 * ai-sdk-ollama ignores the per-call abortSignal, so each attempt builds its
 * own model through `makeModel(signal)`, whose fetch honours that signal
 * (createTimeoutFetch). The signal also goes into the call options for
 * providers that do read it. Without this the discarded attempt would keep
 * generating a full answer in the background, competing with the retry.
 */

/** Text, without any tool call, after which a step counts as the answer. */
export const ANSWER_TEXT_CHARS = 280

const HEADING_AT_LINE_START_RE = /(^|\n)[ \t]{0,3}#{1,6}[ \t]/

/**
 * Whether streamed text is the start of an answer rather than a sentence of
 * narration before a tool call. The prompts require the answer to open with a
 * `## ` heading; a heading anywhere in the text, or a long run of text, both
 * count.
 */
export function looksLikeAnswerStart(text: string): boolean {
  const t = text.trimStart()
  return HEADING_AT_LINE_START_RE.test(t) || t.length >= ANSWER_TEXT_CHARS
}

function anySignal(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => s != null)
  if (real.length === 0) return undefined
  return real.length === 1 ? real[0] : AbortSignal.any(real)
}

export type AnswerStepReminderInfo = {
  /** ms from the call to the moment the answer was recognised. */
  detectMs: number
  /** characters of answer text the aborted attempt had produced. */
  abortedTextChars: number
}

export function createAnswerStepReminderModel({
  base,
  makeModel,
  reminder,
  onRetry
}: {
  /** The turn's model: identity (provider/modelId/supportedUrls) and doGenerate. */
  base: LanguageModelV3
  /** A fresh instance of the turn's model whose HTTP requests `signal` aborts. */
  makeModel: (signal: AbortSignal) => LanguageModelV3
  /** Appended as a trailing user message on the re-run of an answer step. */
  reminder: string
  onRetry?: (info: AnswerStepReminderInfo) => void
}): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: base.provider,
    modelId: base.modelId,
    supportedUrls: base.supportedUrls,
    // Non-streaming callers are not guarded; the research loop streams.
    doGenerate: (options: LanguageModelV3CallOptions) =>
      base.doGenerate(options),
    async doStream(options: LanguageModelV3CallOptions) {
      const startedAt = Date.now()
      const attempt = new AbortController()
      const first = await makeModel(attempt.signal).doStream({
        ...options,
        abortSignal: anySignal(options.abortSignal, attempt.signal)
      })
      const reader = first.stream.getReader()
      const buffered: LanguageModelV3StreamPart[] = []
      let text = ''
      let ended = false
      let readError: unknown
      let isAnswer = false

      for (;;) {
        let next: ReadableStreamReadResult<LanguageModelV3StreamPart>
        try {
          next = await reader.read()
        } catch (error) {
          readError = error
          break
        }
        if (next.done) {
          ended = true
          break
        }
        const part = next.value
        buffered.push(part)
        if (part.type === 'tool-input-start' || part.type === 'tool-call') {
          break
        }
        if (part.type === 'text-delta') {
          text += part.delta
          if (looksLikeAnswerStart(text)) {
            isAnswer = true
            break
          }
        }
        if (part.type === 'finish' || part.type === 'error') break
      }

      if (isAnswer) {
        attempt.abort()
        reader.cancel().catch(() => {})
        try {
          onRetry?.({
            detectMs: Date.now() - startedAt,
            abortedTextChars: text.length
          })
        } catch {
          // Telemetry must never break a turn.
        }
        return makeModel(new AbortController().signal).doStream({
          ...options,
          prompt: [
            ...options.prompt,
            { role: 'user', content: [{ type: 'text', text: reminder }] }
          ]
        })
      }

      // Research continues (or the attempt ended without an answer): hand the
      // SDK exactly what the model produced.
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          for (const part of buffered) controller.enqueue(part)
          if (readError !== undefined) controller.error(readError)
          else if (ended) controller.close()
        },
        async pull(controller) {
          try {
            const { value, done } = await reader.read()
            if (done) controller.close()
            else controller.enqueue(value)
          } catch (error) {
            controller.error(error)
          }
        },
        cancel(reason) {
          attempt.abort()
          return reader.cancel(reason)
        }
      })
      return { ...first, stream }
    }
  }
}
