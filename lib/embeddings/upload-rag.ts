// RAG pipeline for uploaded files.
// At upload time: extract text → chunk → embed → store as .chunks.json
// At query time:  embed user query → cosine similarity → return top-k chunks

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  crossEncoderScore,
  isCrossEncoderConfigured
} from '../utils/cross-encoder'

import { splitText } from './split-text'
import {
  cosineSimilarity,
  type EmbeddingModelId,
  embedTexts,
  getConfiguredModel
} from './transformers-embedding'

const execFileAsync = promisify(execFile)

interface StoredChunk {
  content: string
  embedding: number[]
}

interface ChunksFile {
  model: EmbeddingModelId
  filename: string
  chunks: StoredChunk[]
}

export function chunksFilePath(uploadedFilePath: string): string {
  return uploadedFilePath + '.chunks.json'
}

// ── Text extraction ──────────────────────────────────────────────────────────

async function extractPdfText(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', filePath, '-'],
      { maxBuffer: 10 * 1024 * 1024 }
    )
    return stdout
  } catch {
    return ''
  }
}

// ── Upload-time processing ───────────────────────────────────────────────────

// Extensions treated as plain text for the local fast path (code files
// often arrive as application/octet-stream, so extension matters too).
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'csv',
  'html',
  'htm',
  'json',
  'yaml',
  'yml',
  'toml',
  'ts',
  'js',
  'tsx',
  'jsx',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sh'
])

export function isTextFamily(mediaType: string, filename: string): boolean {
  if (mediaType === 'application/pdf') return true
  if (mediaType.startsWith('text/')) return true
  if (mediaType === 'application/json') return true
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.has(ext)
}

const MIN_MEANINGFUL_CHARS = 200

// Local fast-path ingestion. Returns true iff a chunks file was written —
// the upload route uses that to mark the file `ready` without the worker.
export async function processFileForRAG(
  filePath: string,
  mediaType: string,
  filename: string
): Promise<boolean> {
  let text = ''

  if (mediaType === 'application/pdf') {
    text = await extractPdfText(filePath)
  } else if (isTextFamily(mediaType, filename)) {
    try {
      text = await fs.readFile(filePath, 'utf-8')
    } catch {
      return false
    }
  } else {
    return false // media and office formats belong to the worker
  }

  const trimmed = text.trim()
  if (trimmed.length <= MIN_MEANINGFUL_CHARS) return false

  const model = getConfiguredModel()
  const chunks = splitText(trimmed, 512, 128)
  if (chunks.length === 0) return false

  const embeddings = await embedTexts(chunks, model)

  const stored: ChunksFile = {
    model,
    filename,
    chunks: chunks.map((content, i) => ({ content, embedding: embeddings[i] }))
  }

  await fs.writeFile(chunksFilePath(filePath), JSON.stringify(stored))
  return true
}

// Embed worker-extracted chunk texts and store them in the standard
// chunks-file format. Oversized entries are re-split defensively so a
// worker bug can't produce chunks beyond what the embedder handles well.
export async function storeExtractedChunks(
  filePath: string,
  filename: string,
  chunkTexts: string[]
): Promise<void> {
  const normalized = chunkTexts.flatMap(t =>
    t.length > 4000 ? splitText(t, 512, 128) : [t]
  )
  const model = getConfiguredModel()
  const embeddings = await embedTexts(normalized, model)
  const stored: ChunksFile = {
    model,
    filename,
    chunks: normalized.map((content, i) => ({
      content,
      embedding: embeddings[i]
    }))
  }
  await fs.writeFile(chunksFilePath(filePath), JSON.stringify(stored))
}

// ── Query-time retrieval ─────────────────────────────────────────────────────

// Relevance floor on the FINAL rank score, so an off-topic question against an
// attached doc/URL contributes nothing rather than the top-K "least-bad"
// chunks (citation-without-support). Deliberately LENIENT: keep a marginal
// chunk rather than drop a good one. The value is on the CROSS-ENCODER scale
// (the reranker runs in every env). Measured on this exact reranker + 512-tok
// chunk config (see lib/memory/recall-search.ts): relevant ~0.169 vs
// irrelevant ~0.0000164, so 0.01 sits ~17x below a relevant chunk yet ~600x
// above the irrelevant baseline. Matches recall's most-permissive gate
// (RECALL_SEARCH_MIN_SCORE=0.01) so the two RAG paths stay calibrated alike.
// RAG_MIN_SCORE=0 fully disables the floor; a negative/garbage value → default.
const DEFAULT_RAG_MIN_SCORE = 0.01
function ragMinScore(): number {
  const raw = process.env.RAG_MIN_SCORE
  if (raw === undefined || raw === '') return DEFAULT_RAG_MIN_SCORE
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RAG_MIN_SCORE
}

/**
 * Two-stage ranking shared by upload-RAG and URL-RAG (lib/embeddings/url-rag.ts).
 * Chunks carry precomputed embeddings; `queryEmbedding` is the already-embedded
 * query (both sides embedded with the same model by the caller). A bi-encoder
 * cosine pass pulls a wider candidate pool, then the cross-encoder reranks that
 * pool when configured — any reranker failure falls back to the cosine ordering.
 * Returns the top-K chunk texts, best first — or [] when nothing clears the
 * RAG_MIN_SCORE relevance floor (an off-topic doc simply contributes nothing).
 */
export async function rankChunks(
  query: string,
  chunks: StoredChunk[],
  queryEmbedding: number[],
  topK = 10
): Promise<string[]> {
  if (chunks.length === 0) return []

  const minScore = ragMinScore()

  // First stage: bi-encoder cosine to pull a wider candidate pool.
  const CANDIDATE_POOL = Math.max(topK * 3, 30)
  const candidates = chunks
    .map(chunk => ({
      content: chunk.content,
      score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_POOL)

  // Second stage: cross-encoder reranks the candidate pool when available.
  // Any failure falls back to the cosine ordering already computed.
  if (isCrossEncoderConfigured() && candidates.length > 1) {
    try {
      const scores = await crossEncoderScore(
        query,
        candidates.map(c => c.content),
        // Document chunks are 512 tokens; judge the whole chunk, not just
        // its first ~90 words like web passages (maxLength 512 vs the
        // service default 128). The batch is small (<=30 chunks), so the
        // higher cost is fine, and 10s is plenty for it on an interactive
        // document query — shorter than web search's 20s default so a hung
        // reranker degrades to cosine faster on this user-facing path.
        { maxLength: 512, timeoutMs: 10_000 }
      )
      let ranked = candidates
        .map((c, i) => ({ content: c.content, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score)
      // Scale gating: RAG_MIN_SCORE is a cross-encoder-scale floor, so it is
      // only applied on THIS path (where scores are on that scale). If none
      // clear it, return [] — the doc contributes nothing this turn.
      if (minScore > 0) ranked = ranked.filter(r => r.score >= minScore)
      return ranked.slice(0, topK).map(r => r.content)
    } catch (error) {
      console.error(
        '[rank-chunks] cross-encoder failed, using cosine order:',
        error
      )
    }
  }

  // Cosine fallback (reranker unconfigured, <2 candidates, or it threw). The
  // scores here are on the COSINE scale — a band far too narrow to gate on
  // reliably (measured relevant ~0.626 vs irrelevant ~0.570), and unrelated to
  // the cross-encoder scale RAG_MIN_SCORE is calibrated for. Recall fails
  // CLOSED in the same scale-mismatch spot, but that path is speculative
  // past-chat injection; here the user EXPLICITLY attached this doc, so
  // dropping it wholesale over a reranker hiccup is worse than the rare
  // off-topic-while-reranker-down case. Fail OPEN: return the cosine top-K
  // unfiltered, preserving the prior behavior on this path.
  return candidates.slice(0, topK).map(c => c.content)
}

export async function queryFileChunks(
  filePath: string,
  query: string,
  topK = 10
): Promise<{ filename: string; chunks: string[] } | null> {
  const storedPath = chunksFilePath(filePath)

  let stored: ChunksFile
  try {
    const raw = await fs.readFile(storedPath, 'utf-8')
    stored = JSON.parse(raw)
  } catch {
    return null // no chunks file — caller falls back to full-text
  }

  if (stored.chunks.length === 0) return null

  const [queryEmbedding] = await embedTexts([query], stored.model, {
    kind: 'query'
  })

  const chunks = await rankChunks(query, stored.chunks, queryEmbedding, topK)
  return { filename: stored.filename, chunks }
}
