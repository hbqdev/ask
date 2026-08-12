import { generateText } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

import { createTimeoutFetch } from '../utils/fetch-with-timeout'
import { localLlmBaseUrl } from '../utils/local-llm-host'
import { gistModelId } from './config'
import { firstSentences, stripForSpeech } from './strip-for-speech'

const GIST_TIMEOUT_MS = 8000

export function buildGistPrompt(answer: string): string {
  return [
    'Summarize the following answer as 2 to 3 short sentences that will be READ ALOUD.',
    'Rules: conversational tone, like telling a friend the key finding; no citation',
    'numbers, no lists, no tables, no URLs, no markdown. Lead with the direct answer.',
    '',
    'ANSWER:',
    answer
  ].join('\n')
}

// Injectable generate fn so tests never hit a model. Default calls granite4.1:8b
// on the local host (same pattern as title-generator.ts).
type GenerateFn = (prompt: string, signal?: AbortSignal) => Promise<string>

const defaultGenerate: GenerateFn = async (prompt, signal) => {
  const ollama = createOllama({
    baseURL: localLlmBaseUrl(),
    fetch: createTimeoutFetch(GIST_TIMEOUT_MS)
  })
  const { text } = await generateText({
    model: ollama(gistModelId()),
    prompt,
    abortSignal: signal
  })
  return text
}

// Never throws — a voice-gist failure must not affect the written answer.
export async function condenseForSpeech(
  answerText: string,
  opts: { abortSignal?: AbortSignal; _generate?: GenerateFn } = {}
): Promise<string> {
  const clean = stripForSpeech(answerText)
  const generate = opts._generate ?? defaultGenerate
  try {
    const raw = await generate(buildGistPrompt(clean), opts.abortSignal)
    const gist = stripForSpeech(raw)
    if (gist) return gist
  } catch (e) {
    console.warn('[voice] gist model failed, using sentence fallback:', e)
  }
  return firstSentences(clean, 2)
}
