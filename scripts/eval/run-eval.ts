#!/usr/bin/env bun
/**
 * Ask's answer-quality eval harness.
 *
 * Nothing else in this repo measures answer QUALITY (the 607 tests in
 * lib/**\/__tests__ only check mechanics). This runner drives the real
 * /api/chat endpoint with fresh, isolated chats — one per (question ×
 * config) — reads the persisted result back out of Postgres, scores it
 * objectively (citation validity, tool-call/latency/answer-length
 * aggregates), and runs a blind, position-bias-controlled pairwise LLM
 * judge between two named configs.
 *
 * This is a MEASUREMENT tool: every number printed comes from a real run or
 * a real judge call. A failed run is recorded with an `error` field and
 * excluded from aggregates — never guessed, never silently dropped.
 *
 * Usage:
 *   bun run eval --config-a kimi --config-b minimax
 *   bun run eval --config-a kimi --config-b minimax --limit 10 --concurrency 2
 *   bun run eval --judge-only scripts/eval/results/2026-07-16T12-00-00-000Z.json
 *
 * See scripts/eval/README.md for the full option list and config registry.
 */

import { config as dotenvConfig } from 'dotenv'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// The REAL config lives in .env (not .env.local) for this deployment — see
// memory/project_ask_base_url_port_mismatch.md. override:true so this wins
// even if the runtime (e.g. Bun's own .env.local autoload) already set
// something first; this script must run against the config the docs say it
// does, not whatever happened to be ambient.
dotenvConfig({ path: '.env', override: true })

import { generateText, Output } from 'ai'
import { z } from 'zod'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_QUESTIONS_FILE = path.join(SCRIPT_DIR, 'questions.json')
const DEFAULT_RESULTS_DIR = path.join(SCRIPT_DIR, 'results')

// ---------------------------------------------------------------------------
// Config registry — the (model, searchMode) pairs this harness can compare.
// `model` is a "providerId:modelId" string, exactly what
// lib/utils/registry.ts's getModel() and the selectedModel cookie expect
// (see lib/config/model-selection-cookie.ts). Add more entries here to
// compare something else — nothing beyond this object needs to change.
// ---------------------------------------------------------------------------

interface EvalConfig {
  name: string
  model: string
  searchMode: 'speed' | 'balanced' | 'quality'
}

const CONFIGS: Record<string, EvalConfig> = {
  kimi: {
    name: 'kimi',
    model: 'ollama:kimi-k2.6:cloud',
    searchMode: 'balanced'
  },
  minimax: {
    name: 'minimax',
    model: 'ollama:minimax-m3:cloud',
    searchMode: 'balanced'
  },
  'balanced-default': {
    name: 'balanced-default',
    model: 'ollama:deepseek-v4-pro:cloud',
    searchMode: 'balanced'
  },
  'kimi-speed': {
    name: 'kimi-speed',
    model: 'ollama:kimi-k2.6:cloud',
    searchMode: 'speed'
  },
  'kimi-quality': {
    name: 'kimi-quality',
    model: 'ollama:kimi-k2.6:cloud',
    searchMode: 'quality'
  }
}

// ---------------------------------------------------------------------------
// Env-driven defaults
// ---------------------------------------------------------------------------

const EVAL_API_URL =
  process.env.EVAL_API_URL || 'http://localhost:3739/api/chat'
const EVAL_DB_CONTAINER =
  process.env.EVAL_DB_CONTAINER || 'ask-postgres-admin-feature'
const EVAL_DB_USER = process.env.EVAL_DB_USER || 'morphic'
const EVAL_DB_NAME = process.env.EVAL_DB_NAME || 'morphic'
const EVAL_JUDGE_MODEL =
  process.env.EVAL_JUDGE_MODEL || 'ollama:qwen3.5:397b:cloud'

// How long to keep polling the DB for the assistant message after the HTTP
// stream fully drains. In principle persistStreamResults (see
// lib/streaming/helpers/persist-stream-results.ts) is awaited as part of the
// server's onFinish before the stream closes, so a single read should
// already see it — this is a defensive margin against any flush/connection
// timing gap, not the primary mechanism.
const DB_POLL_TIMEOUT_MS = 30_000
const DB_POLL_INTERVAL_MS = 1_000

// Small pause between dispatching turns — these are expensive, real research
// turns (30-250s each); this just avoids slamming the API/Ollama host the
// instant one finishes.
const RUN_DELAY_MS = 1_000

// Hard client-side ceiling per turn, above the server's own 300s
// GENERATION_TIMEOUT_MS (see app/api/chat/route.ts), so a wedged server
// can't hang the whole eval run forever.
const CLIENT_TIMEOUT_MS = 320_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Question {
  id: string
  text: string
  tags?: string[]
}

// Mirrors chat-cli.ts's local UIMessage shape (this script talks to the API
// exactly the way chat-cli.ts does, deliberately not importing the app's own
// UIMessage type so this runner stays a plain HTTP client).
interface ChatUIMessage {
  id: string
  role: 'user'
  content: string
  parts: Array<{ type: 'text'; text: string }>
  createdAt: Date
}

interface ToolPartRow {
  type: string
  toolCallId: string | null
}

interface DbTurn {
  userMessageId: string | null
  userCreatedAt: string | null
  assistantMessageId: string | null
  assistantCreatedAt: string | null
  metadata: { modelId?: string; searchMode?: string } | null
  answerText: string | null
  toolParts: ToolPartRow[]
}

interface CitationScore {
  citedCount: number
  invalidCount: number
  validPct: number | null // null = no citations present, not "0 invalid"
}

interface RunResult {
  questionId: string
  questionText: string
  configName: string
  chatId: string
  startedAt: string
  finishedAt: string
  latencyMs: number | null
  answerText: string
  answerChars: number
  toolCalls: number
  searches: number
  fetches: number
  toolCallIds: string[]
  citation: CitationScore
  error?: string
  configMismatch?: string
}

interface EvalRunFile {
  createdAt: string
  apiUrl: string
  dbContainer: string
  questionsFile: string
  configs: EvalConfig[]
  runs: RunResult[]
  judge?: JudgeSection
}

interface JudgeVerdict {
  questionId: string
  configA: string
  configB: string
  result: 'A' | 'B' | 'tie' | 'error'
  forward:
    | { winner: 'A' | 'B' | 'tie'; reason: string; fallbackParsed?: boolean }
    | { error: string }
  // reverse is already remapped back into A/B space (see judgePair)
  reverse:
    | { winner: 'A' | 'B' | 'tie'; reason: string; fallbackParsed?: boolean }
    | { error: string }
}

interface JudgeSection {
  judgeModel: string
  judgedAt: string
  configA: string
  configB: string
  skipped: Array<{ questionId: string; reason: string }>
  verdicts: JudgeVerdict[]
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function generateChatId(): string {
  return `eval_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

function buildUserMessage(text: string): ChatUIMessage {
  return {
    id: generateChatId(),
    role: 'user',
    content: text,
    parts: [{ type: 'text', text }],
    createdAt: new Date()
  }
}

/** Runs a SQL statement in the given postgres container, returns raw stdout. */
function runPsql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      EVAL_DB_CONTAINER,
      'psql',
      '-U',
      EVAL_DB_USER,
      '-d',
      EVAL_DB_NAME,
      '-t',
      '-A',
      '-c',
      sql
    ],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  )
}

function verifyDbConnectivity(): void {
  try {
    const out = runPsql('SELECT 1;').trim()
    if (out !== '1') {
      throw new Error(`unexpected response: ${out}`)
    }
  } catch (error) {
    console.error(
      `❌ Cannot reach postgres in container "${EVAL_DB_CONTAINER}". Is it running?\n` +
        `   Override with EVAL_DB_CONTAINER=<name> if this isn't the right container.`
    )
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

// chatId is always generated by this script (see generateChatId) so it can
// never contain a quote or otherwise need SQL escaping — this guard exists
// so a future change to id generation fails loudly instead of opening a SQL
// injection path.
function assertSafeId(id: string, label: string): void {
  if (!/^[a-zA-Z0-9_]+$/.test(id)) {
    throw new Error(`Refusing to interpolate unsafe ${label} into SQL: ${id}`)
  }
}

function queryTurn(chatId: string): DbTurn | null {
  assertSafeId(chatId, 'chatId')
  const sql = `
WITH um AS (
  SELECT id, created_at FROM messages
  WHERE chat_id = '${chatId}' AND role = 'user'
  ORDER BY created_at ASC LIMIT 1
), am AS (
  SELECT id, created_at, metadata FROM messages
  WHERE chat_id = '${chatId}' AND role = 'assistant'
  ORDER BY created_at DESC LIMIT 1
), am_text AS (
  SELECT text_text FROM parts
  WHERE message_id = (SELECT id FROM am) AND type = 'text' AND text_text IS NOT NULL
  ORDER BY "order" DESC LIMIT 1
), tool_parts AS (
  SELECT type, tool_tool_call_id AS "toolCallId" FROM parts
  WHERE message_id = (SELECT id FROM am)
    AND type LIKE 'tool-%'
    AND tool_tool_call_id IS NOT NULL
)
SELECT row_to_json(r) FROM (
  SELECT
    (SELECT id FROM um) AS "userMessageId",
    (SELECT created_at FROM um) AS "userCreatedAt",
    (SELECT id FROM am) AS "assistantMessageId",
    (SELECT created_at FROM am) AS "assistantCreatedAt",
    (SELECT metadata FROM am) AS "metadata",
    (SELECT text_text FROM am_text) AS "answerText",
    (SELECT COALESCE(json_agg(tool_parts), '[]'::json) FROM tool_parts) AS "toolParts"
) r;
`.trim()

  const raw = runPsql(sql).trim()
  if (!raw || raw === '') return null
  return JSON.parse(raw) as DbTurn
}

async function pollForAssistantMessage(chatId: string): Promise<DbTurn | null> {
  const deadline = Date.now() + DB_POLL_TIMEOUT_MS
  let last: DbTurn | null = null
  while (Date.now() < deadline) {
    last = queryTurn(chatId)
    if (last?.assistantMessageId) return last
    await sleep(DB_POLL_INTERVAL_MS)
  }
  // One last try in case the deadline elapsed mid-sleep right as the row landed.
  return queryTurn(chatId) ?? last
}

// ---------------------------------------------------------------------------
// Cookie construction — mirrors the app's own cookie contract exactly:
// lib/config/model-selection-cookie.ts (selectedModel) and the SearchMode
// values route.ts reads directly off the `searchMode` cookie.
// ---------------------------------------------------------------------------

function splitProviderModel(model: string): {
  providerId: string
  modelId: string
} {
  const sep = model.indexOf(':')
  if (sep <= 0 || sep === model.length - 1) {
    throw new Error(
      `Invalid model string "${model}" — expected "providerId:modelId"`
    )
  }
  return { providerId: model.slice(0, sep), modelId: model.slice(sep + 1) }
}

function buildCookieHeader(config: EvalConfig): string {
  const { providerId, modelId } = splitProviderModel(config.model)
  // Same encoding as serializeModelSelectionCookie in
  // lib/config/model-selection-cookie.ts, inlined here to avoid pulling that
  // (env-independent, but still product-internal) module into a script whose
  // request-building logic should stand alone, the way chat-cli.ts's does.
  const selectedModel = `${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`
  return `selectedModel=${selectedModel}; searchMode=${config.searchMode}`
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

/** Fully drains the SSE response body. We don't parse it — the DB is the
 * source of truth for the answer (see queryTurn) — but draining it to
 * completion is what tells us the server-side stream (and therefore its
 * onFinish/persistence step) has actually finished. Along the way, does a
 * best-effort scan for an inline `"type":"error"` SSE event so a run that
 * technically got a 200 but errored mid-stream is still flagged. */
async function drainResponseBody(
  response: Response
): Promise<{ sawError: boolean; errorText?: string }> {
  if (!response.body) return { sawError: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let sawError = false
  let errorText: string | undefined

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!sawError && value) {
      const chunk = decoder.decode(value, { stream: true })
      if (chunk.includes('"type":"error"')) {
        sawError = true
        errorText = chunk.slice(0, 500)
      }
    }
  }
  return { sawError, errorText }
}

// Mirrors stripToolCallPrefix in lib/utils/citation.ts: some models prepend
// a provider/router prefix (e.g. toolu_) to a cited toolCallId, which the
// real app still resolves via this same normalization when rendering
// citations. Matching it here keeps "invalid citation" counts aligned with
// what a user actually sees in the UI, instead of being spuriously stricter.
function stripToolCallPrefix(toolCallId: string): string {
  return toolCallId.replace(/^(toolu_|call_|search-)/, '')
}

// Same anchor format lib/utils/citation.ts's processCitations matches:
// [number](#toolCallId).
const CITATION_PATTERN = /\[\s*(\d+)\s*\]\(#([^)]+)\)/g

function scoreCitations(
  answerText: string,
  toolCallIds: string[]
): CitationScore {
  const known = new Set(toolCallIds)
  const knownNormalized = new Set(toolCallIds.map(stripToolCallPrefix))

  let citedCount = 0
  let invalidCount = 0
  for (const match of answerText.matchAll(CITATION_PATTERN)) {
    citedCount++
    const cited = match[2]
    const valid =
      known.has(cited) || knownNormalized.has(stripToolCallPrefix(cited))
    if (!valid) invalidCount++
  }

  return {
    citedCount,
    invalidCount,
    validPct:
      citedCount > 0 ? ((citedCount - invalidCount) / citedCount) * 100 : null
  }
}

function errorRunResult(
  question: Question,
  config: EvalConfig,
  chatId: string,
  startedAt: Date,
  error: string
): RunResult {
  return {
    questionId: question.id,
    questionText: question.text,
    configName: config.name,
    chatId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs: null,
    answerText: '',
    answerChars: 0,
    toolCalls: 0,
    searches: 0,
    fetches: 0,
    toolCallIds: [],
    citation: { citedCount: 0, invalidCount: 0, validPct: null },
    error
  }
}

// A single retry on a network-level fetch failure (connection reset, socket
// closed, DNS blip, etc — never on an HTTP error response, which is a real
// application-level result worth recording as-is). Observed live during
// development: back-to-back long-running turns to the same host can hand a
// second request a keep-alive connection the server already tore down after
// the first turn's multi-minute SSE stream, surfacing as "socket connection
// was closed unexpectedly" on the very first byte. `Connection: close`
// avoids reusing that pooled connection in the first place; the retry is a
// defense-in-depth backstop for any other transient network blip.
async function postChatTurn(
  apiUrl: string,
  payload: unknown,
  config: EvalConfig
): Promise<Response> {
  const attempt = () =>
    fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Connection: 'close',
        Cookie: buildCookieHeader(config)
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS)
    })

  try {
    return await attempt()
  } catch (error) {
    console.log(
      `  (network error on first attempt, retrying once: ${error instanceof Error ? error.message : String(error)})`
    )
    await sleep(2_000)
    return attempt()
  }
}

async function runTurn(
  question: Question,
  config: EvalConfig,
  apiUrl: string
): Promise<RunResult> {
  const chatId = generateChatId()
  const startedAt = new Date()
  const userMessage = buildUserMessage(question.text)
  const payload = {
    chatId,
    trigger: 'submit-message',
    message: userMessage,
    isNewChat: true
  }

  let response: Response
  try {
    response = await postChatTurn(apiUrl, payload, config)
  } catch (error) {
    return errorRunResult(
      question,
      config,
      chatId,
      startedAt,
      `fetch failed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return errorRunResult(
      question,
      config,
      chatId,
      startedAt,
      `HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`
    )
  }

  const { sawError, errorText } = await drainResponseBody(response)

  const turn = await pollForAssistantMessage(chatId)
  if (!turn || !turn.assistantMessageId) {
    return errorRunResult(
      question,
      config,
      chatId,
      startedAt,
      `assistant message never appeared in DB for chat ${chatId} within ${DB_POLL_TIMEOUT_MS}ms` +
        (sawError ? ` (stream also reported an error: ${errorText})` : '')
    )
  }

  const answerText = turn.answerText ?? ''
  const toolParts = turn.toolParts ?? []
  const toolCallIds = toolParts
    .map(p => p.toolCallId)
    .filter((id): id is string => !!id)

  const latencyMs =
    turn.userCreatedAt && turn.assistantCreatedAt
      ? new Date(turn.assistantCreatedAt).getTime() -
        new Date(turn.userCreatedAt).getTime()
      : null

  const result: RunResult = {
    questionId: question.id,
    questionText: question.text,
    configName: config.name,
    chatId,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    latencyMs,
    answerText,
    answerChars: answerText.length,
    toolCalls: toolParts.length,
    searches: toolParts.filter(p => p.type === 'tool-search').length,
    fetches: toolParts.filter(p => p.type === 'tool-fetch').length,
    toolCallIds,
    citation: scoreCitations(answerText, toolCallIds)
  }

  // Sanity check: the persisted message really was generated with the model
  // we asked for via the selectedModel cookie. A mismatch means we measured
  // the WRONG config for this run — that corrupts the comparison, so it's
  // recorded as an error and excluded from aggregates rather than silently
  // attributed to `config.name`.
  const actualModelId = turn.metadata?.modelId
  if (actualModelId && actualModelId !== config.model) {
    result.configMismatch = `expected model "${config.model}", persisted message used "${actualModelId}"`
    result.error = result.configMismatch
  }
  if (sawError && !result.error) {
    result.error = `stream reported an error event: ${errorText ?? '(no detail captured)'}`
  }
  if (!answerText && !result.error) {
    result.error = 'assistant message persisted with no final text part'
  }

  return result
}

// ---------------------------------------------------------------------------
// Bounded concurrency runner
// ---------------------------------------------------------------------------

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  async function lane(): Promise<void> {
    for (;;) {
      const i = nextIndex++
      if (i >= items.length) return
      if (i > 0) await sleep(RUN_DELAY_MS)
      results[i] = await worker(items[i], i)
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => lane())
  )
  return results
}

// ---------------------------------------------------------------------------
// Objective aggregates
// ---------------------------------------------------------------------------

interface ConfigAggregate {
  name: string
  runs: number
  errors: number
  avgToolCalls: number | null
  avgSearches: number | null
  avgFetches: number | null
  avgLatencyMs: number | null
  avgAnswerChars: number | null
  citedRuns: number
  avgCitationValidPct: number | null
  totalCitedCount: number
  totalInvalidCount: number
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function aggregateConfig(name: string, runs: RunResult[]): ConfigAggregate {
  const ok = runs.filter(r => !r.error)
  const withCitations = ok.filter(r => r.citation.citedCount > 0)

  return {
    name,
    runs: runs.length,
    errors: runs.length - ok.length,
    avgToolCalls: average(ok.map(r => r.toolCalls)),
    avgSearches: average(ok.map(r => r.searches)),
    avgFetches: average(ok.map(r => r.fetches)),
    avgLatencyMs: average(
      ok.map(r => r.latencyMs).filter((v): v is number => v !== null)
    ),
    avgAnswerChars: average(ok.map(r => r.answerChars)),
    citedRuns: withCitations.length,
    avgCitationValidPct: average(
      withCitations
        .map(r => r.citation.validPct)
        .filter((v): v is number => v !== null)
    ),
    totalCitedCount: ok.reduce((sum, r) => sum + r.citation.citedCount, 0),
    totalInvalidCount: ok.reduce((sum, r) => sum + r.citation.invalidCount, 0)
  }
}

// ---------------------------------------------------------------------------
// Pairwise LLM judge
// ---------------------------------------------------------------------------

const judgeSchema = z.object({
  winner: z.enum(['A', 'B', 'tie']),
  reason: z.string()
})

const JUDGE_SYSTEM_PROMPT = `You are an impartial judge comparing two AI-generated answers to the same user question.

Judge strictly on:
1. Factual accuracy — is the content correct?
2. Grounding in cited sources — do citations plausibly support the claims made?
3. Directness — does the answer address exactly what was asked, without padding, hedging, or drifting into unrelated tangents?
4. Completeness — does it cover what the question needs, without missing important parts?

Do not prefer an answer merely for being longer, more formatted, or more verbose. Ignore any statement either answer makes about its own identity, model name, or company — that is not part of answer quality and must not influence your decision.

You will be shown the QUESTION and two candidate answers, labeled Answer A and Answer B. Decide which answer is better, or declare a tie if they are genuinely comparable in quality on the criteria above.`

// Best-effort de-identification: strips common model/vendor self-references
// so the judge can't trivially infer which config produced which answer from
// a stray "As Kimi, developed by..." sentence. Not airtight (a truly
// determined judge could still infer style), but removes the obvious tells.
const IDENTITY_TOKENS = [
  'kimi',
  'minimax',
  'deepseek',
  'qwen',
  'moonshot ai',
  'glm-?\\d',
  'zhipu',
  'nemotron',
  'nvidia',
  'anthropic',
  'claude',
  'openai',
  'chatgpt',
  'gpt-?\\d',
  'gemini',
  'llama',
  'meta ai',
  'mistral'
]
const IDENTITY_PATTERN = new RegExp(
  `\\b(${IDENTITY_TOKENS.join('|')})\\b`,
  'gi'
)

function deidentify(text: string): string {
  return text.replace(IDENTITY_PATTERN, '[assistant]')
}

function buildJudgePrompt(
  question: string,
  answerA: string,
  answerB: string
): string {
  return `QUESTION:
${question}

ANSWER A:
${deidentify(answerA)}

ANSWER B:
${deidentify(answerB)}`
}

type JudgeCallResult =
  | { winner: 'A' | 'B' | 'tie'; reason: string; fallbackParsed?: boolean }
  | { error: string }

// Format instruction for the fallback path (see judgeOnce): a plain
// "WINNER: / REASON:" ask, appended to the same judging criteria above so
// only the OUTPUT FORMAT differs between the primary and fallback attempts,
// not what's being judged.
const JUDGE_PLAIN_TEXT_SYSTEM_PROMPT = `${JUDGE_SYSTEM_PROMPT}

Respond with EXACTLY two lines and nothing else — no markdown, no code fences, no extra commentary:
WINNER: A, B, or tie
REASON: one sentence`

function parsePlainTextVerdict(
  text: string
): { winner: 'A' | 'B' | 'tie'; reason: string } | null {
  const winnerMatch = text.match(/WINNER:\s*(A|B|tie)\b/i)
  if (!winnerMatch) return null
  const token = winnerMatch[1].toLowerCase()
  const winner = token === 'a' ? 'A' : token === 'b' ? 'B' : 'tie'
  const reasonMatch = text.match(/REASON:\s*([\s\S]*)/i)
  const reason = (reasonMatch ? reasonMatch[1] : text).trim().slice(0, 500)
  return { winner, reason }
}

async function judgeOnce(
  question: string,
  answerA: string,
  answerB: string,
  judgeModelId: string
): Promise<JudgeCallResult> {
  try {
    // Deferred to runtime (not a static top-level import) so this module can
    // be imported/parsed without triggering lib/utils/registry.ts's
    // module-eval-time `process.env.OLLAMA_BASE_URL` read before our own
    // dotenvConfig() call above has had a chance to run — static imports are
    // hoisted ahead of any of this file's own top-level statements in ESM,
    // dotenvConfig() included, so a static import here could silently see an
    // empty env and permanently disable the ollama provider for the process.
    const { getModel } = await import('@/lib/utils/registry')
    const model = getModel(judgeModelId)
    const prompt = buildJudgePrompt(question, answerA, answerB)

    try {
      const { output } = await generateText({
        model,
        system: JUDGE_SYSTEM_PROMPT,
        prompt,
        temperature: 0,
        output: Output.object({ schema: judgeSchema })
      })
      if (output) return output
    } catch {
      // Schema-constrained generation failed — every model available in
      // this deployment's OLLAMA_MODELS was live-tested against this exact
      // call during development (qwen3.5:397b:cloud, the default judge
      // model, plus kimi-k2.6:cloud, glm-5.2:cloud, deepseek-v4-flash:cloud,
      // minimax-m3:cloud) and NONE reliably honored the requested JSON
      // schema: some answered in bare prose ("tie"), others wrapped a real
      // verdict in self-invented JSON shapes (`better_answer`,
      // `overall_winner`, criteria-nested `winner` keys) that legitimately
      // don't match what we asked for. Falls through to a plain-text ask
      // below rather than giving up — see README Limitations for the full
      // finding.
    }

    // Fallback: a second, real model call with a much lower output-format
    // bar. Verified live to parse cleanly across every model above where
    // Output.object failed — this is still a genuine judgment from a real
    // call, just requested in a format more models reliably follow.
    const { text } = await generateText({
      model,
      system: JUDGE_PLAIN_TEXT_SYSTEM_PROMPT,
      prompt,
      temperature: 0
    })
    const parsed = parsePlainTextVerdict(text)
    if (parsed) return { ...parsed, fallbackParsed: true }
    return {
      error: `judge response had no parseable verdict (tried schema output, then plain-text fallback): ${text.trim().slice(0, 300)}`
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/** Judges a question's pair of answers in BOTH orders and only counts a win
 * when the judge is consistent across both — position bias is a strong,
 * well-documented effect for LLM judges, and without this control the
 * win/loss numbers are noise. An inconsistent (or tied, or errored) verdict
 * scores as a tie. */
async function judgePair(
  question: Question,
  answerA: string,
  answerB: string,
  configAName: string,
  configBName: string,
  judgeModelId: string
): Promise<JudgeVerdict> {
  const [forward, reverseRaw] = await Promise.all([
    judgeOnce(question.text, answerA, answerB, judgeModelId), // position A = configA
    judgeOnce(question.text, answerB, answerA, judgeModelId) // position A = configB
  ])

  if ('error' in forward || 'error' in reverseRaw) {
    return {
      questionId: question.id,
      configA: configAName,
      configB: configBName,
      result: 'error',
      forward,
      reverse: reverseRaw
    }
  }

  // Remap the reverse call's position-relative winner back to A/B space:
  // in that call, position A held configB's answer and position B held
  // configA's.
  const reverseRemapped: {
    winner: 'A' | 'B' | 'tie'
    reason: string
    fallbackParsed?: boolean
  } = {
    winner:
      reverseRaw.winner === 'A' ? 'B' : reverseRaw.winner === 'B' ? 'A' : 'tie',
    reason: reverseRaw.reason,
    fallbackParsed: reverseRaw.fallbackParsed
  }

  const consistent =
    forward.winner !== 'tie' && forward.winner === reverseRemapped.winner
  const result: 'A' | 'B' | 'tie' = consistent ? forward.winner : 'tie'

  return {
    questionId: question.id,
    configA: configAName,
    configB: configBName,
    result,
    forward,
    reverse: reverseRemapped
  }
}

interface PairwiseAggregate {
  configA: string
  configB: string
  judged: number
  errors: number
  aWins: number
  bWins: number
  ties: number
  aWinRate: number | null
  bWinRate: number | null
  tieRate: number | null
  // Count of individual judge calls (forward + reverse, so 0-2 per verdict)
  // that had to fall back to the plain-text WINNER/REASON ask because the
  // judge model didn't return schema-conforming output — see judgeOnce.
  fallbackParsedCalls: number
}

function aggregatePairwise(section: JudgeSection): PairwiseAggregate {
  const errors = section.verdicts.filter(v => v.result === 'error').length
  const decided = section.verdicts.filter(v => v.result !== 'error')
  const aWins = decided.filter(v => v.result === 'A').length
  const bWins = decided.filter(v => v.result === 'B').length
  const ties = decided.filter(v => v.result === 'tie').length
  const denom = decided.length
  const fallbackParsedCalls = section.verdicts.reduce((sum, v) => {
    const f = 'fallbackParsed' in v.forward && v.forward.fallbackParsed ? 1 : 0
    const r = 'fallbackParsed' in v.reverse && v.reverse.fallbackParsed ? 1 : 0
    return sum + f + r
  }, 0)

  return {
    configA: section.configA,
    configB: section.configB,
    judged: section.verdicts.length,
    errors,
    aWins,
    bWins,
    ties,
    aWinRate: denom > 0 ? (aWins / denom) * 100 : null,
    bWinRate: denom > 0 ? (bWins / denom) * 100 : null,
    tieRate: denom > 0 ? (ties / denom) * 100 : null,
    fallbackParsedCalls
  }
}

async function runJudge(
  runsA: RunResult[],
  runsB: RunResult[],
  configAName: string,
  configBName: string,
  judgeModelId: string
): Promise<JudgeSection> {
  const byIdA = new Map(runsA.map(r => [r.questionId, r]))
  const byIdB = new Map(runsB.map(r => [r.questionId, r]))
  const questionIds = [...new Set([...byIdA.keys(), ...byIdB.keys()])].sort()

  const skipped: JudgeSection['skipped'] = []
  const verdicts: JudgeVerdict[] = []

  let done = 0
  for (const questionId of questionIds) {
    const a = byIdA.get(questionId)
    const b = byIdB.get(questionId)
    if (!a || a.error || !a.answerText) {
      skipped.push({
        questionId,
        reason: !a
          ? `no run for ${configAName}`
          : `${configAName} run failed: ${a.error}`
      })
      continue
    }
    if (!b || b.error || !b.answerText) {
      skipped.push({
        questionId,
        reason: !b
          ? `no run for ${configBName}`
          : `${configBName} run failed: ${b.error}`
      })
      continue
    }

    const question: Question = { id: questionId, text: a.questionText }
    const verdict = await judgePair(
      question,
      a.answerText,
      b.answerText,
      configAName,
      configBName,
      judgeModelId
    )
    verdicts.push(verdict)
    done++
    console.log(
      `  [judge ${done}/${questionIds.length - skipped.length}] ${questionId}: ${verdict.result}`
    )
  }

  return {
    judgeModel: judgeModelId,
    judgedAt: new Date().toISOString(),
    configA: configAName,
    configB: configBName,
    skipped,
    verdicts
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmt(n: number | null, digits = 1): string {
  return n === null ? 'n/a' : n.toFixed(digits)
}

function printObjectiveTable(aggregates: ConfigAggregate[]): void {
  console.log('\n=== Objective metrics ===\n')
  const header = [
    'config',
    'runs',
    'errors',
    'avgTools',
    'avgSearch',
    'avgFetch',
    'avgLatency(s)',
    'avgChars',
    'citedRuns',
    'avgValidPct'
  ]
  const rows = aggregates.map(a => [
    a.name,
    String(a.runs),
    String(a.errors),
    fmt(a.avgToolCalls),
    fmt(a.avgSearches),
    fmt(a.avgFetches),
    a.avgLatencyMs === null ? 'n/a' : (a.avgLatencyMs / 1000).toFixed(1),
    a.avgAnswerChars === null ? 'n/a' : Math.round(a.avgAnswerChars).toString(),
    `${a.citedRuns}/${a.runs - a.errors}`,
    a.avgCitationValidPct === null ? 'n/a' : `${fmt(a.avgCitationValidPct)}%`
  ])
  printTable(header, rows)
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  )
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join('  ')
  console.log(line(header))
  console.log(widths.map(w => '-'.repeat(w)).join('  '))
  for (const row of rows) console.log(line(row))
}

function printPairwiseReport(agg: PairwiseAggregate, judgeModel: string): void {
  console.log(`\n=== Pairwise judge: ${agg.configA} vs ${agg.configB} ===\n`)
  console.log(`judge model: ${judgeModel}`)
  console.log(`questions judged: ${agg.judged}`)
  console.log(
    `  ${agg.configA} wins:  ${agg.aWins}${agg.aWinRate !== null ? ` (${fmt(agg.aWinRate)}%)` : ''}`
  )
  console.log(
    `  ${agg.configB} wins:  ${agg.bWins}${agg.bWinRate !== null ? ` (${fmt(agg.bWinRate)}%)` : ''}`
  )
  console.log(
    `  ties:              ${agg.ties}${agg.tieRate !== null ? ` (${fmt(agg.tieRate)}%)` : ''}  <- includes position-bias-inconsistent verdicts`
  )
  console.log(`  judge errors:      ${agg.errors}`)
  if (agg.fallbackParsedCalls > 0) {
    console.log(
      `  (${agg.fallbackParsedCalls} of ${agg.judged * 2} judge calls fell back to lenient text parsing —` +
        ` the judge model didn't return schema-conforming JSON. See README Limitations.)`
    )
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  configA?: string
  configB?: string
  limit?: number
  concurrency: number
  judgeOnly?: string
  questionsFile: string
  outDir: string
  apiUrl: string
  judgeModel: string
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  const options: CliOptions = {
    concurrency: 1,
    questionsFile: DEFAULT_QUESTIONS_FILE,
    outDir: DEFAULT_RESULTS_DIR,
    apiUrl: EVAL_API_URL,
    judgeModel: EVAL_JUDGE_MODEL
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--config-a':
        options.configA = args[++i]
        break
      case '--config-b':
        options.configB = args[++i]
        break
      case '--limit':
        options.limit = Number(args[++i])
        break
      case '--concurrency':
        options.concurrency = Number(args[++i])
        break
      case '--judge-only':
        options.judgeOnly = args[++i]
        break
      case '--questions':
        options.questionsFile = path.resolve(args[++i])
        break
      case '--out-dir':
        options.outDir = path.resolve(args[++i])
        break
      case '--api-url':
        options.apiUrl = args[++i]
        break
      case '--judge-model':
        options.judgeModel = args[++i]
        break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
    }
  }

  return options
}

function printHelp(): void {
  console.log(`
Ask eval harness — pairwise answer-quality comparison between two configs.

Usage:
  bun run eval --config-a <name> --config-b <name> [options]
  bun run eval --judge-only <resultsFile> [--config-a <name> --config-b <name>]

Options:
  --config-a <name>     First config to compare (see CONFIGS in this file)
  --config-b <name>     Second config to compare
  --limit <n>           Cap the number of questions used
  --concurrency <n>     Parallel turns (default: 1 — sequential)
  --judge-only <file>   Re-judge an existing results file instead of running turns
  --questions <path>    Questions file (default: scripts/eval/questions.json)
  --out-dir <path>      Results output directory (default: scripts/eval/results)
  --api-url <url>       Override $EVAL_API_URL (default: ${EVAL_API_URL})
  --judge-model <id>    Override $EVAL_JUDGE_MODEL (default: ${EVAL_JUDGE_MODEL})
  -h, --help            Show this help message

Available configs: ${Object.keys(CONFIGS).join(', ')}

Env vars:
  EVAL_API_URL          Chat API endpoint (default: http://localhost:3739/api/chat)
  EVAL_DB_CONTAINER     Postgres container to read results from (default: ask-postgres-admin-feature)
  EVAL_DB_USER          Postgres user (default: morphic)
  EVAL_DB_NAME          Postgres database (default: morphic)
  EVAL_JUDGE_MODEL      Judge model, providerId:modelId (default: ollama:qwen3.5:397b:cloud)
`)
}

function loadQuestions(file: string, limit?: number): Question[] {
  const raw = readFileSync(file, 'utf-8')
  const all = JSON.parse(raw) as Question[]
  return typeof limit === 'number' && Number.isFinite(limit)
    ? all.slice(0, limit)
    : all
}

function resolveConfig(name: string | undefined, label: string): EvalConfig {
  if (!name) {
    console.error(`❌ ${label} is required (see --help for available configs)`)
    process.exit(1)
  }
  const config = CONFIGS[name]
  if (!config) {
    console.error(
      `❌ Unknown config "${name}". Available: ${Object.keys(CONFIGS).join(', ')}`
    )
    process.exit(1)
  }
  return config
}

function writeResultsFile(outDir: string, file: EvalRunFile): string {
  mkdirSync(outDir, { recursive: true })
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  const outPath = path.join(outDir, filename)
  writeFileSync(outPath, JSON.stringify(file, null, 2) + '\n')
  return outPath
}

async function runEval(options: CliOptions): Promise<void> {
  const configA = resolveConfig(options.configA, '--config-a')
  const configB = resolveConfig(options.configB, '--config-b')

  verifyDbConnectivity()

  const questions = loadQuestions(options.questionsFile, options.limit)
  console.log(
    `Loaded ${questions.length} question(s) from ${options.questionsFile}`
  )
  console.log(
    `Configs: A=${configA.name} (${configA.model}, ${configA.searchMode})` +
      ` vs B=${configB.name} (${configB.model}, ${configB.searchMode})`
  )
  console.log(
    `API: ${options.apiUrl}  DB: ${EVAL_DB_CONTAINER}  concurrency: ${options.concurrency}\n`
  )

  // Interleaved [ (q1,A), (q1,B), (q2,A), (q2,B), ... ] so an interrupted run
  // still has paired data for the questions that finished, rather than a
  // completed A pass and a mostly-empty B pass.
  type Job = { question: Question; config: EvalConfig }
  const jobs: Job[] = []
  for (const question of questions) {
    jobs.push({ question, config: configA })
    jobs.push({ question, config: configB })
  }

  let completed = 0
  const results = await runWithConcurrency(
    jobs,
    options.concurrency,
    async job => {
      const result = await runTurn(job.question, job.config, options.apiUrl)
      completed++
      const status = result.error
        ? `ERROR: ${result.error}`
        : `${result.answerChars} chars, ${result.toolCalls} tool calls`
      console.log(
        `[${completed}/${jobs.length}] ${job.question.id} × ${job.config.name}: ${status}`
      )
      return result
    }
  )

  const runsA = results.filter(r => r.configName === configA.name)
  const runsB = results.filter(r => r.configName === configB.name)

  console.log('\nRunning pairwise judge...')
  const judge = await runJudge(
    runsA,
    runsB,
    configA.name,
    configB.name,
    options.judgeModel
  )

  const file: EvalRunFile = {
    createdAt: new Date().toISOString(),
    apiUrl: options.apiUrl,
    dbContainer: EVAL_DB_CONTAINER,
    questionsFile: options.questionsFile,
    configs: [configA, configB],
    runs: results,
    judge
  }

  const outPath = writeResultsFile(options.outDir, file)
  console.log(`\nRaw results written to ${outPath}`)

  printReport(file)
}

async function runJudgeOnly(options: CliOptions): Promise<void> {
  const filePath = path.resolve(options.judgeOnly!)
  const file = JSON.parse(readFileSync(filePath, 'utf-8')) as EvalRunFile

  const presentConfigs = [...new Set(file.runs.map(r => r.configName))]
  const configAName = options.configA ?? presentConfigs[0]
  const configBName = options.configB ?? presentConfigs[1]

  if (!configAName || !configBName || configAName === configBName) {
    console.error(
      `❌ Could not determine two distinct configs to compare from ${filePath}.\n` +
        `   Found: ${presentConfigs.join(', ')}. Pass --config-a/--config-b explicitly.`
    )
    process.exit(1)
  }

  const runsA = file.runs.filter(r => r.configName === configAName)
  const runsB = file.runs.filter(r => r.configName === configBName)
  if (runsA.length === 0 || runsB.length === 0) {
    console.error(
      `❌ No runs found for one of "${configAName}" / "${configBName}" in ${filePath}`
    )
    process.exit(1)
  }

  console.log(`Re-judging ${filePath}: ${configAName} vs ${configBName}`)
  console.log(`Judge model: ${options.judgeModel}\n`)

  const judge = await runJudge(
    runsA,
    runsB,
    configAName,
    configBName,
    options.judgeModel
  )

  file.judge = judge
  writeFileSync(filePath, JSON.stringify(file, null, 2) + '\n')
  console.log(`\nUpdated ${filePath} with new judge results.`)

  printReport(file)
}

function printReport(file: EvalRunFile): void {
  const configNames = [...new Set(file.runs.map(r => r.configName))]
  const aggregates = configNames.map(name =>
    aggregateConfig(
      name,
      file.runs.filter(r => r.configName === name)
    )
  )
  printObjectiveTable(aggregates)

  if (file.judge) {
    const pairwise = aggregatePairwise(file.judge)
    printPairwiseReport(pairwise, file.judge.judgeModel)
    if (file.judge.skipped.length > 0) {
      console.log(
        `\n  (${file.judge.skipped.length} question(s) skipped — failed run on one side, see judge.skipped in the results file)`
      )
    }
  }
  console.log('')
}

async function main(): Promise<void> {
  const options = parseArgs()

  if (options.judgeOnly) {
    await runJudgeOnly(options)
    return
  }

  await runEval(options)
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
