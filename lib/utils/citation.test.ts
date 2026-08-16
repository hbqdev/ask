import { describe, expect, test } from 'vitest'

import type { UIMessage } from '@/lib/types/ai'

import { extractCitationMaps, processCitations } from './citation'

// SPIKE (chat-with-docs-urls Slice 1, Task 1): proves the CLIENT-SIDE citation
// machinery treats a synthetic `tool-documentRetrieval` part exactly like a
// `search`/`fetch` part — i.e. the model can cite a retrieval it never invoked
// itself, as long as the streaming layer writes the matching UI part (fixed
// toolCallId) that this test simulates.
//
// This is deterministic and model-free on purpose: it isolates the machinery
// (whitelist -> extractCitationMaps -> processCitations) from the open question
// the coordinator's live rebuild answers (does the model actually EMIT the
// anchor). If this test passes, the plumbing is proven; only the prompt-side
// "will the model cite it" remains.
describe('documentRetrieval citation machinery', () => {
  // A fixed id the streaming layer would inject as the synthetic retrieval's
  // toolCallId, and that the model would echo back as `[n](#<id>)`.
  const DOC_ID = 'document-retrieval-0000-0000-000000000000'

  // NOTE: absolute URLs are REQUIRED. processCitations calls isValidUrl (new
  // URL(...)), and a relative `/uploads/...` path throws and gets stripped —
  // so the real feature (Task 5) must give doc chunks absolute URLs too.
  const message = {
    id: 'm1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-documentRetrieval',
        toolCallId: DOC_ID,
        state: 'output-available',
        input: { query: 'what does the doc say?' },
        output: {
          state: 'complete',
          query: 'what does the doc say?',
          images: [],
          results: [
            {
              title: 'notes.txt — excerpt 1',
              url: 'https://ask.local/uploads/u1/chats/c1/notes.txt#chunk-1',
              content: 'The quarterly revenue was 4.2M.'
            },
            {
              title: 'notes.txt — excerpt 2',
              url: 'https://ask.local/uploads/u1/chats/c1/notes.txt#chunk-2',
              content: 'Headcount grew to 37 people.'
            }
          ]
        }
      },
      { type: 'text', text: 'Revenue was 4.2M. [1](#' + DOC_ID + ')' }
    ]
  } as unknown as UIMessage

  test('extractCitationMaps builds a per-index map for the synthetic part', () => {
    const maps = extractCitationMaps(message)

    // The part yielded a citation map keyed by its toolCallId.
    expect(Object.keys(maps)).toContain(DOC_ID)
    // Citation numbers are 1-based and map to results[n-1].
    expect(maps[DOC_ID][1].url).toBe(
      'https://ask.local/uploads/u1/chats/c1/notes.txt#chunk-1'
    )
    expect(maps[DOC_ID][2].content).toBe('Headcount grew to 37 people.')
  })

  test('processCitations keeps (rewrites) the anchor instead of stripping it', () => {
    const maps = extractCitationMaps(message)
    const out = processCitations('Revenue was 4.2M. [1](#' + DOC_ID + ')', maps)

    // The anchor survived: it was rewritten to [domain](url), NOT deleted.
    expect(out).not.toContain('#' + DOC_ID)
    expect(out).toContain('https://ask.local/uploads/u1/chats/c1/notes.txt#chunk-1')
    // displayUrlName reduces the host to its bare label.
    expect(out).toContain('[ask](')
  })

  test('a non-whitelisted synthetic tool part would NOT be citable (control)', () => {
    // Same shape under a different (non-whitelisted) part type resolves to no
    // map — confirming it is the whitelist entry, not the shape alone, that
    // makes documentRetrieval citable.
    const control = {
      id: 'm2',
      role: 'assistant',
      parts: [
        {
          type: 'tool-somethingElse',
          toolCallId: DOC_ID,
          state: 'output-available',
          output: {
            state: 'complete',
            results: [
              {
                title: 't',
                url: 'https://ask.local/x',
                content: 'c'
              }
            ]
          }
        }
      ]
    } as unknown as UIMessage

    expect(Object.keys(extractCitationMaps(control))).toHaveLength(0)
  })
})
