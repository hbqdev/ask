import { describe, expect, it } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'
import { extractCitationMaps, processCitations } from '@/lib/utils/citation'

import {
  buildDocumentResults,
  buildDocumentRetrievalArtifacts,
  buildDocumentRetrievalModelMessages,
  buildDocumentRetrievalPart,
  buildDocumentRetrievalStreamChunks,
  documentSourceId
} from '../document-retrieval-part'

const BASE_URL = 'https://ask.local/uploads/u1/chats/c1/notes.txt'

describe('documentSourceId', () => {
  it('produces a UUID-shaped id: 36 chars, four hyphens, hex only', () => {
    const id = documentSourceId('doc', 'file-123')
    expect(id).toHaveLength(36)
    expect(id.split('-')).toHaveLength(5) // 8-4-4-4-12 → four hyphens
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('is deterministic for the same (kind, key)', () => {
    expect(documentSourceId('doc', 'file-123')).toBe(
      documentSourceId('doc', 'file-123')
    )
    expect(documentSourceId('url', BASE_URL)).toBe(
      documentSourceId('url', BASE_URL)
    )
  })

  it('distinguishes kinds and keys', () => {
    expect(documentSourceId('doc', 'k')).not.toBe(documentSourceId('url', 'k'))
    expect(documentSourceId('doc', 'a')).not.toBe(documentSourceId('doc', 'b'))
  })
})

describe('buildDocumentResults', () => {
  it('maps one { title, url, content } per chunk, in order', () => {
    const results = buildDocumentResults('notes.txt', BASE_URL, ['a', 'b', 'c'])
    expect(results).toHaveLength(3)
    expect(results.map(r => r.content)).toEqual(['a', 'b', 'c'])
    expect(results.every(r => r.title === 'notes.txt')).toBe(true)
  })

  it('gives every excerpt an absolute url with a distinct #chunk-N fragment', () => {
    const results = buildDocumentResults('notes.txt', BASE_URL, ['a', 'b'])
    expect(results[0].url).toBe(`${BASE_URL}#chunk-1`)
    expect(results[1].url).toBe(`${BASE_URL}#chunk-2`)
    // Absolute: each survives new URL(...) — the check processCitations runs.
    for (const r of results) expect(() => new URL(r.url)).not.toThrow()
  })

  it('throws on a relative url (would be silently stripped when cited)', () => {
    expect(() =>
      buildDocumentResults('notes.txt', '/uploads/u1/notes.txt', ['a'])
    ).toThrow(/absolute URL/)
  })

  it('returns an empty array for empty chunks', () => {
    expect(buildDocumentResults('notes.txt', BASE_URL, [])).toEqual([])
  })
})

describe('buildDocumentRetrievalPart', () => {
  const sourceId = documentSourceId('doc', 'file-123')

  it('returns the citable tool part with one result per chunk, in order', () => {
    const part = buildDocumentRetrievalPart({
      sourceId,
      title: 'notes.txt',
      url: BASE_URL,
      chunks: ['revenue 4.2M', 'headcount 37'],
      query: 'what does the doc say?'
    })

    expect(part).not.toBeNull()
    expect(part!.type).toBe('tool-documentRetrieval')
    expect(part!.state).toBe('output-available')
    expect(part!.toolCallId).toBe(sourceId)
    expect(part!.output.state).toBe('complete')
    expect(part!.output.query).toBe('what does the doc say?')
    expect(part!.output.images).toEqual([])
    expect(part!.output.results.map(r => r.content)).toEqual([
      'revenue 4.2M',
      'headcount 37'
    ])
  })

  it('defaults query to an empty string', () => {
    const part = buildDocumentRetrievalPart({
      sourceId,
      title: 'notes.txt',
      url: BASE_URL,
      chunks: ['x']
    })
    expect(part!.input.query).toBe('')
    expect(part!.output.query).toBe('')
  })

  it('returns null when there is nothing to cite (empty chunks)', () => {
    expect(
      buildDocumentRetrievalPart({
        sourceId,
        title: 'notes.txt',
        url: BASE_URL,
        chunks: []
      })
    ).toBeNull()
  })
})

describe('buildDocumentRetrievalStreamChunks', () => {
  const sourceId = documentSourceId('doc', 'file-123')
  const [inputChunk, outputChunk] = buildDocumentRetrievalStreamChunks({
    sourceId,
    title: 'notes.txt',
    url: BASE_URL,
    chunks: ['a', 'b'],
    query: 'q'
  })

  it('emits tool-input-available then tool-output-available with the same id', () => {
    expect(inputChunk.type).toBe('tool-input-available')
    expect(outputChunk.type).toBe('tool-output-available')
    expect(inputChunk.toolCallId).toBe(sourceId)
    expect(outputChunk.toolCallId).toBe(sourceId)
  })

  it('names the documentRetrieval tool on the input chunk with the query input', () => {
    expect(inputChunk.toolName).toBe('documentRetrieval')
    expect(inputChunk.input).toEqual({ query: 'q' })
  })

  it('carries the complete, indexed results on the output chunk (no dynamic flag)', () => {
    expect(outputChunk.output.state).toBe('complete')
    expect(outputChunk.output.results).toHaveLength(2)
    // No `dynamic` key → the reducer builds a STATIC tool part.
    expect('dynamic' in outputChunk).toBe(false)
    expect('dynamic' in inputChunk).toBe(false)
  })
})

describe('buildDocumentRetrievalModelMessages', () => {
  const sourceId = documentSourceId('doc', 'file-123')
  const [assistant, toolMsg] = buildDocumentRetrievalModelMessages({
    sourceId,
    title: 'notes.txt',
    url: BASE_URL,
    chunks: ['a', 'b'],
    query: 'q'
  })

  it('emits an assistant tool-call then a tool tool-result with the same id', () => {
    expect(assistant.role).toBe('assistant')
    expect(toolMsg.role).toBe('tool')

    const call = (assistant.content as any[])[0]
    const result = (toolMsg.content as any[])[0]
    expect(call.type).toBe('tool-call')
    expect(call.toolCallId).toBe(sourceId)
    expect(call.toolName).toBe('documentRetrieval')
    expect(call.input).toEqual({ query: 'q' })

    expect(result.type).toBe('tool-result')
    expect(result.toolCallId).toBe(sourceId)
  })

  it('wraps the results as a json tool-result with { state, results }', () => {
    const result = (toolMsg.content as any[])[0]
    expect(result.output.type).toBe('json')
    expect(result.output.value.state).toBe('complete')
    expect(result.output.value.results.map((r: any) => r.content)).toEqual([
      'a',
      'b'
    ])
  })
})

describe('buildDocumentRetrievalArtifacts', () => {
  it('returns null when there is nothing to cite', () => {
    expect(
      buildDocumentRetrievalArtifacts({
        sourceId: documentSourceId('doc', 'x'),
        title: 't',
        url: BASE_URL,
        chunks: []
      })
    ).toBeNull()
  })

  it('bundles part, stream chunks, and model messages under one shared id', () => {
    const sourceId = documentSourceId('doc', 'file-123')
    const artifacts = buildDocumentRetrievalArtifacts({
      sourceId,
      title: 'notes.txt',
      url: BASE_URL,
      chunks: ['a', 'b'],
      query: 'q'
    })!

    expect(artifacts.toolCallId).toBe(sourceId)
    expect(artifacts.part.toolCallId).toBe(sourceId)
    expect(artifacts.streamChunks[0].toolCallId).toBe(sourceId)
    expect(artifacts.streamChunks[1].toolCallId).toBe(sourceId)
    expect((artifacts.modelMessages[0].content as any[])[0].toolCallId).toBe(
      sourceId
    )
    expect((artifacts.modelMessages[1].content as any[])[0].toolCallId).toBe(
      sourceId
    )
  })

  // Integration guard: the assembled part must be genuinely citable through the
  // real citation machinery (whitelist -> extractCitationMaps -> processCitations)
  // that Task 1 whitelisted. This ties Task 3's output to the client behavior.
  it('produces a part the citation machinery resolves and keeps', () => {
    const sourceId = documentSourceId('doc', 'file-123')
    const { part } = buildDocumentRetrievalArtifacts({
      sourceId,
      title: 'notes.txt',
      url: BASE_URL,
      chunks: ['revenue 4.2M', 'headcount 37'],
      query: 'q'
    })!

    const message = {
      id: 'm1',
      role: 'assistant',
      parts: [part, { type: 'text', text: `Revenue. [1](#${sourceId})` }]
    } as unknown as UIMessage

    const maps = extractCitationMaps(message)
    expect(Object.keys(maps)).toContain(sourceId)
    expect(maps[sourceId][1].url).toBe(`${BASE_URL}#chunk-1`)
    expect(maps[sourceId][2].content).toBe('headcount 37')

    const out = processCitations(`Revenue. [1](#${sourceId})`, maps)
    // The anchor survived (rewritten to a source link), not stripped.
    expect(out).not.toContain(`#${sourceId})`)
    expect(out).toContain(`${BASE_URL}#chunk-1`)
  })
})
