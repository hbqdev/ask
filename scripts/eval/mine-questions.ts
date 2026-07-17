#!/usr/bin/env bun
/**
 * Mines eval questions from real chat history in the PROD database.
 *
 * Extracts the first user message of every chat (prod DB, only reachable
 * in-container, so this shells out via `docker exec ... psql`), keeps the
 * ones whose length falls in [minLen, maxLen], and writes them to
 * questions.json as a stable, numbered set — the question bank run-eval.ts
 * replays against each config under test.
 *
 * Deterministic and re-runnable: candidates are ordered by their chat's
 * created_at (oldest first, via SQL's own ORDER BY — not JS array order,
 * which json_agg does not otherwise guarantee) before ids are assigned, so
 * re-running this script against an unchanged DB reproduces byte-identical
 * output, and running it again later only appends new ids after the
 * existing ones.
 *
 * Questions containing a URL are skipped by default (the app routes those
 * straight to the fetch tool rather than search, a different code path) —
 * pass --include-urls to keep them, tagged with tags: ["url"] so run-eval.ts
 * / a reader can still tell them apart.
 *
 * Usage:
 *   bun run eval:mine
 *   bun run scripts/eval/mine-questions.ts --container ask-postgres --include-urls
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT_FILE = path.join(SCRIPT_DIR, 'questions.json')

interface Question {
  id: string
  text: string
  tags?: string[]
}

interface MineOptions {
  container: string
  dbUser: string
  dbName: string
  minLen: number
  maxLen: number
  includeUrls: boolean
  outFile: string
}

interface MinedRow {
  chat_id: string
  created_at: string
  text_text: string
}

const URL_PATTERN = /https?:\/\//i

function parseArgs(): MineOptions {
  const args = process.argv.slice(2)
  const options: MineOptions = {
    // Prod DB — question mining always reads real user history from prod,
    // never from staging (which only holds eval/test traffic).
    container: process.env.EVAL_MINE_DB_CONTAINER || 'ask-postgres',
    dbUser: process.env.EVAL_DB_USER || 'morphic',
    dbName: process.env.EVAL_DB_NAME || 'morphic',
    minLen: 20,
    maxLen: 300,
    includeUrls: false,
    outFile: DEFAULT_OUT_FILE
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--container':
        options.container = args[++i]
        break
      case '--db-user':
        options.dbUser = args[++i]
        break
      case '--db-name':
        options.dbName = args[++i]
        break
      case '--min-len':
        options.minLen = Number(args[++i])
        break
      case '--max-len':
        options.maxLen = Number(args[++i])
        break
      case '--include-urls':
        options.includeUrls = true
        break
      case '--out':
        options.outFile = path.resolve(args[++i])
        break
      case '-h':
      case '--help':
        printHelp()
        process.exit(0)
    }
  }

  if (!Number.isFinite(options.minLen) || !Number.isFinite(options.maxLen)) {
    console.error('❌ --min-len / --max-len must be numbers')
    process.exit(1)
  }

  return options
}

function printHelp(): void {
  console.log(`
Mine eval questions from the first user message of every prod chat.

Usage: bun run scripts/eval/mine-questions.ts [options]

Options:
  --container <name>   Docker container running the prod postgres
                        (default: ask-postgres, or $EVAL_MINE_DB_CONTAINER)
  --db-user <name>     Postgres user (default: morphic, or $EVAL_DB_USER)
  --db-name <name>     Postgres database (default: morphic, or $EVAL_DB_NAME)
  --min-len <n>        Minimum question length in chars (default: 20)
  --max-len <n>        Maximum question length in chars (default: 300)
  --include-urls       Keep URL-containing questions (tagged tags: ["url"])
                        instead of skipping them
  --out <path>         Output file (default: scripts/eval/questions.json)
  -h, --help           Show this help message
`)
}

/** Runs a SQL statement in the given postgres container, returns raw stdout. */
function runPsql(options: MineOptions, sql: string): string {
  return execFileSync(
    'docker',
    [
      'exec',
      options.container,
      'psql',
      '-U',
      options.dbUser,
      '-d',
      options.dbName,
      '-t',
      '-A',
      '-c',
      sql
    ],
    { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  )
}

function fetchCandidates(options: MineOptions): MinedRow[] {
  // json_agg(row_to_json(...)) emits the whole result set as one JSON blob.
  // This deliberately avoids psql's default row-per-line output, which
  // breaks the instant a question's text contains an embedded newline —
  // several real first messages in this DB do (multi-paragraph questions).
  const sql = `
WITH first_user_msg AS (
  SELECT DISTINCT ON (m.chat_id) m.id AS message_id, m.chat_id, m.created_at
  FROM messages m
  WHERE m.role = 'user'
  ORDER BY m.chat_id, m.created_at ASC
),
first_text_part AS (
  SELECT DISTINCT ON (p.message_id) p.message_id, p.text_text
  FROM parts p
  WHERE p.type = 'text' AND p.text_text IS NOT NULL
  ORDER BY p.message_id, p."order" ASC
),
candidates AS (
  SELECT fum.chat_id, fum.created_at, ftp.text_text
  FROM first_user_msg fum
  JOIN first_text_part ftp ON ftp.message_id = fum.message_id
  WHERE length(ftp.text_text) BETWEEN ${options.minLen} AND ${options.maxLen}
)
SELECT json_agg(row_to_json(candidates) ORDER BY candidates.created_at ASC) FROM candidates;
`.trim()

  const raw = runPsql(options, sql).trim()
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : []
}

function main(): void {
  const options = parseArgs()

  console.log(`Mining questions from container "${options.container}"...`)

  let rows: MinedRow[]
  try {
    rows = fetchCandidates(options)
  } catch (error) {
    console.error(
      `❌ Failed to query "${options.container}" — is the container running?`
    )
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }

  console.log(
    `Found ${rows.length} chats with a first message between ${options.minLen}-${options.maxLen} chars.`
  )

  let skippedUrls = 0
  const questions: Question[] = []

  for (const row of rows) {
    const text = row.text_text.trim()
    // Defensive re-check: length() in SQL ran on the untrimmed text.
    if (text.length < options.minLen || text.length > options.maxLen) continue

    const hasUrl = URL_PATTERN.test(text)
    if (hasUrl && !options.includeUrls) {
      skippedUrls++
      continue
    }

    questions.push({
      id: `q${String(questions.length + 1).padStart(3, '0')}`,
      text,
      ...(hasUrl ? { tags: ['url'] } : {})
    })
  }

  mkdirSync(path.dirname(options.outFile), { recursive: true })
  writeFileSync(options.outFile, JSON.stringify(questions, null, 2) + '\n')

  console.log(
    `Skipped ${skippedUrls} question(s) containing a URL (use --include-urls to keep them, tagged).`
  )
  console.log(`Wrote ${questions.length} questions to ${options.outFile}`)
}

main()
