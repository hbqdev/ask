// RAG pipeline for uploaded files.
// At upload time: extract text → chunk → embed → store as .chunks.json
// At query time:  embed user query → cosine similarity → return top-k chunks

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { splitText } from './split-text'
import {
  cosineSimilarity,
  embedTexts,
  getConfiguredModel,
  type EmbeddingModelId,
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

export async function processFileForRAG(
  filePath: string,
  mediaType: string,
  filename: string
): Promise<void> {
  let text = ''

  if (mediaType === 'application/pdf') {
    text = await extractPdfText(filePath)
  } else if (mediaType === 'text/plain') {
    text = await fs.readFile(filePath, 'utf-8')
  } else {
    // Images and other types don't get RAG processing
    return
  }

  const trimmed = text.trim()
  if (trimmed.length < 50) return // too short to be useful

  const model = getConfiguredModel()
  const chunks = splitText(trimmed, 512, 128)
  if (chunks.length === 0) return

  const embeddings = await embedTexts(chunks, model)

  const stored: ChunksFile = {
    model,
    filename,
    chunks: chunks.map((content, i) => ({ content, embedding: embeddings[i] })),
  }

  await fs.writeFile(chunksFilePath(filePath), JSON.stringify(stored))
}

// ── Query-time retrieval ─────────────────────────────────────────────────────

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

  const [queryEmbedding] = await embedTexts([query], stored.model)

  const ranked = stored.chunks
    .map((chunk, i) => ({
      content: chunk.content,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  return {
    filename: stored.filename,
    chunks: ranked.map(r => r.content),
  }
}
