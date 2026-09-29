import { describe, expect, it } from 'vitest'

import { narrationCleanView } from '@/lib/streaming/helpers/strip-narration-from-message'
import { buildUIMessageFromDB } from '@/lib/utils/message-mapping'

import {
  applyPlanToRows,
  countChunksWithProbes,
  expectedRecallChunks,
  hashParts,
  type MessageRow,
  narrationOnlyInChunks,
  type PartRow,
  planMessageCleanup,
  recallAction,
  removedTextProbes
} from '../backfill-narration-plan'

// DB-row fixtures (the shape Drizzle selects from `parts`), so the tests run
// the real loader mapper (buildUIMessageFromDB) and the real cleanup.

const EMPTY_ROW: Omit<PartRow, 'id' | 'messageId' | 'order' | 'type'> = {
  text_text: null,
  reasoning_text: null,
  file_mediaType: null,
  file_filename: null,
  file_url: null,
  file_key: null,
  source_url_sourceId: null,
  source_url_url: null,
  source_url_title: null,
  source_document_sourceId: null,
  source_document_mediaType: null,
  source_document_title: null,
  source_document_filename: null,
  source_document_url: null,
  source_document_snippet: null,
  tool_toolCallId: null,
  tool_state: null,
  tool_errorText: null,
  tool_search_input: null,
  tool_search_output: null,
  tool_fetch_input: null,
  tool_fetch_output: null,
  tool_question_input: null,
  tool_question_output: null,
  tool_todoWrite_input: null,
  tool_todoWrite_output: null,
  tool_todoRead_input: null,
  tool_todoRead_output: null,
  tool_dynamic_input: null,
  tool_dynamic_output: null,
  tool_dynamic_name: null,
  tool_dynamic_type: null,
  data_prefix: null,
  data_content: null,
  data_id: null,
  providerMetadata: null,
  createdAt: new Date('2026-09-28T10:00:00Z')
}

function rowsFor(messageId: string, specs: Partial<PartRow>[]): PartRow[] {
  return specs.map((spec, order) => ({
    ...EMPTY_ROW,
    id: `${messageId}-p${order}`,
    messageId,
    order,
    type: 'text',
    ...spec
  })) as PartRow[]
}

const stepStart: Partial<PartRow> = { type: 'step-start' }
const text = (t: string): Partial<PartRow> => ({ type: 'text', text_text: t })
const search = (id: string): Partial<PartRow> => ({
  type: 'tool-search',
  tool_toolCallId: id,
  tool_state: 'output-available',
  tool_search_input: { query: 'q' },
  tool_search_output: { results: [{ url: 'https://example.com', title: 't' }] }
})
const fetchTool = (id: string): Partial<PartRow> => ({
  type: 'tool-fetch',
  tool_toolCallId: id,
  tool_state: 'output-available',
  tool_fetch_input: { url: 'https://example.com' },
  tool_fetch_output: { content: 'page' }
})

const message = (id: string, role = 'assistant'): MessageRow => ({
  id,
  chatId: 'chat-1',
  role,
  metadata: null,
  createdAt: new Date('2026-09-28T10:00:00Z')
})

// --- Real prod shapes (chat pq6zs7w88m1kmowjdu9udfrw, trimmed) ---------------

const VI_CHATTER_1 =
  'Tôi cần đọc trang fandom này để lấy cấu trúc chi tiết từng chương mà người dùng muốn.'
const VI_CHATTER_3 =
  'Các trang fandom này không trả về nội dung thực tế (chỉ có menu điều hướng và cookie). Tôi cần tìm nguồn khác chi tiết hơn về từng trận đánh trong cuộc chiến. Để tôi tìm kiếm trực tiếp với nội dung chi tiết từng trận.'
const VI_PREAMBLE_GLUED =
  'Tôi đã có đủ thông tin. Kết quả tìm kiếm cho thấy sự kiện "Cự Phủ chết" chính là "巨斧创始者陨落" (Cự Phủ Sáng Thế Giả vẫn lạc). Tôi có đủ tài liệu để viết câu trả lời đầy đủ.\n\n' +
  'Lưu ý: cần xác định rõ "cự phủ" ở đây. Trong ngữ cảnh Thôn Phệ Tinh Không, "Cự Phủ" = 巨斧创始者 (Cự Phủ Sáng Thế Giả / Cự Phủ Sáng Lập Giả), người sáng lập Vũ Trường Cự Phủ. Tôi sẽ viết theo đúng nghĩa này.\n\n' +
  'Bây giờ viết câu trả lời.'
const VI_ANSWER =
  '## **吞噬星空 (Thôn Phệ Tinh Không): Diễn biến sau khi Cự Phủ Sáng Thế Giả vẫn lạc**\n\n' +
  'Dưới đây là diễn biến chi tiết theo **từng chương** trong nguyên tác tiểu thuyết.\n\n---\n\n### HỒI 1 — Cái chết của Cự Phủ Sáng Thế Giả\n\n' +
  '- Cự Phủ Sáng Thế Giả cầm **tàn đồ Khuynh Phong Giới** do La Phong dâng lên, một mình tiến vào vùng nội thành hung hiểm [1](#s1).\n'.repeat(
    10
  )

const EN_STATUS = 'Let me search for more details on the release schedule.'
const EN_PREAMBLE =
  'I have enough information now to write a comprehensive answer.\n\n'
const EN_ANSWER =
  '## Release schedule\n\nThe next release ships in October [1](#s1). ' +
  'It focuses on performance and stability.'

describe('planMessageCleanup', () => {
  it('Vietnamese: drops the status parts and cuts the glued preamble, nothing else', () => {
    const msg = message('vi')
    const rows = rowsFor('vi', [
      stepStart,
      text(VI_CHATTER_1),
      fetchTool('f1'),
      stepStart,
      text(VI_CHATTER_3),
      search('s1'),
      {
        type: 'data-classifier',
        data_prefix: 'classifier',
        data_content: { intent: 'x' }
      },
      stepStart,
      text(VI_PREAMBLE_GLUED + VI_ANSWER)
    ])
    const outcome = planMessageCleanup(msg, rows)
    expect(outcome.status).toBe('change')
    if (outcome.status !== 'change') return
    const { plan } = outcome

    expect(plan.drops.map(d => d.order)).toEqual([1, 4])
    expect(plan.drops.map(d => d.text)).toEqual([VI_CHATTER_1, VI_CHATTER_3])
    expect(plan.rewrites).toHaveLength(1)
    expect(plan.rewrites[0]).toMatchObject({
      partId: 'vi-p8',
      order: 8,
      before: VI_PREAMBLE_GLUED + VI_ANSWER,
      after: VI_ANSWER
    })
    expect(plan.removedChars).toBe(
      VI_CHATTER_1.length + VI_CHATTER_3.length + VI_PREAMBLE_GLUED.length
    )

    // Post-state: non-text rows untouched and in place, order gaps kept.
    const post = applyPlanToRows(rows, plan)
    expect(post.map(r => r.order)).toEqual([0, 2, 3, 5, 6, 7, 8])
    expect(post.filter(r => r.type !== 'text')).toEqual(
      rows.filter(r => r.type !== 'text')
    )

    // The loader then returns exactly what the render path showed before.
    const renderedBefore = narrationCleanView(buildUIMessageFromDB(msg, rows))
    const loadedAfter = buildUIMessageFromDB(msg, post)
    expect(loadedAfter.parts).toEqual(renderedBefore.parts)
    expect(hashParts(loadedAfter.parts)).toBe(plan.renderViewHash)

    // Idempotent: a second run finds nothing.
    expect(planMessageCleanup(msg, post)).toEqual({ status: 'unchanged' })

    // Recall: extractIndexableText already cut the glued preamble, so the
    // indexable text is the same — but chunks indexed BEFORE that rule
    // contain the preamble, which the probes detect.
    expect(plan.indexableAfter).toBe(plan.indexableBefore)
    expect(plan.indexableAfter).not.toContain('Bây giờ viết câu trả lời')
    const probes = removedTextProbes(plan)
    expect(probes.length).toBeGreaterThan(0)
    const oldChunk = `${VI_PREAMBLE_GLUED}${VI_ANSWER}`.replace(/\s+/g, ' ')
    const newChunks = expectedRecallChunks('assistant', post, 512, 128).chunks
    expect(countChunksWithProbes([oldChunk], probes)).toBe(1)
    expect(newChunks.length).toBeGreaterThan(0)
    expect(countChunksWithProbes(newChunks, probes)).toBe(0)
  })

  it('English: drops the status part and cuts the phrase-anchored preamble', () => {
    const msg = message('en')
    const rows = rowsFor('en', [
      stepStart,
      text(EN_STATUS),
      search('s1'),
      stepStart,
      text(EN_PREAMBLE + EN_ANSWER),
      {
        type: 'tool-dynamic',
        tool_toolCallId: 'd1',
        tool_state: 'output-available',
        tool_dynamic_name: 'calculate',
        tool_dynamic_type: 'dynamic',
        tool_dynamic_input: { expression: '1+1' },
        tool_dynamic_output: { result: 2 }
      }
    ])
    const outcome = planMessageCleanup(msg, rows)
    expect(outcome.status).toBe('change')
    if (outcome.status !== 'change') return
    expect(outcome.plan.drops).toEqual([
      { partId: 'en-p1', order: 1, text: EN_STATUS }
    ])
    expect(outcome.plan.rewrites).toEqual([
      {
        partId: 'en-p4',
        order: 4,
        before: EN_PREAMBLE + EN_ANSWER,
        after: EN_ANSWER
      }
    ])
    const post = applyPlanToRows(rows, outcome.plan)
    expect(post.map(r => r.type)).toEqual([
      'step-start',
      'tool-search',
      'step-start',
      'text',
      'tool-dynamic'
    ])
    expect(planMessageCleanup(msg, post)).toEqual({ status: 'unchanged' })
    expect(buildUIMessageFromDB(msg, post).parts).toEqual(
      narrationCleanView(buildUIMessageFromDB(msg, rows)).parts
    )
  })

  it('leaves a clean answer unchanged', () => {
    const rows = rowsFor('clean', [
      stepStart,
      search('s1'),
      stepStart,
      text('## Title\n\nA clean answer [1](#s1).')
    ])
    expect(planMessageCleanup(message('clean'), rows)).toEqual({
      status: 'unchanged'
    })
  })

  it('never touches a user message, even one that looks like narration', () => {
    const rows = rowsFor('user', [
      text(EN_PREAMBLE + EN_ANSWER),
      text(EN_STATUS)
    ])
    expect(planMessageCleanup(message('user', 'user'), rows)).toEqual({
      status: 'unchanged'
    })
  })

  it('sorts rows by order like the loader, whatever order they arrive in', () => {
    const rows = rowsFor('shuffled', [
      stepStart,
      text(EN_STATUS),
      search('s1'),
      text(EN_ANSWER)
    ])
    const outcome = planMessageCleanup(message('shuffled'), [...rows].reverse())
    expect(outcome.status).toBe('change')
    if (outcome.status !== 'change') return
    expect(outcome.plan.drops.map(d => d.partId)).toEqual(['shuffled-p1'])
    expect(outcome.plan.rewrites).toEqual([])
  })

  it('skips a message whose part order is ambiguous', () => {
    const rows = rowsFor('dup', [
      text(EN_STATUS),
      search('s1'),
      text(EN_ANSWER)
    ])
    rows[2].order = 1
    const outcome = planMessageCleanup(message('dup'), rows)
    expect(outcome.status).toBe('skip')
  })

  it('skips a message the loader mapper cannot build', () => {
    const rows = rowsFor('bad', [
      text(EN_STATUS),
      { type: 'tool-search', tool_toolCallId: 's1', tool_state: null },
      text(EN_ANSWER)
    ])
    const outcome = planMessageCleanup(message('bad'), rows)
    expect(outcome).toMatchObject({ status: 'skip' })
    expect((outcome as { reason: string }).reason).toMatch(/unmappable/)
  })

  it('skips (rather than half-cleans) when one cleanup pass is not a fixpoint', () => {
    // Pass 1 keeps the short note (a text part follows it, not a tool) and
    // drops the "Let me search" part; pass 2 would then drop the note too.
    // Storing pass 1 would leave work for a second run, so it is skipped.
    const rows = rowsFor('fix', [
      text('Interesting page.'),
      text(EN_STATUS),
      search('s1'),
      text(EN_ANSWER)
    ])
    const outcome = planMessageCleanup(message('fix'), rows)
    expect(outcome).toMatchObject({ status: 'skip' })
    expect((outcome as { reason: string }).reason).toMatch(/fixpoint/)
  })
})

describe('removedTextProbes', () => {
  it('probes the removed prefix of a rewrite, not the kept answer', () => {
    const probes = removedTextProbes({
      drops: [],
      rewrites: [
        {
          partId: 'p',
          order: 0,
          before: EN_PREAMBLE + EN_ANSWER,
          after: EN_ANSWER
        }
      ]
    })
    expect(probes).toEqual([
      'I have enough information now to write a comprehensive answe'
    ])
    expect(countChunksWithProbes([EN_ANSWER], probes)).toBe(0)
  })
})

describe('recallAction', () => {
  const base = { rewrites: 0, chunksWithRemovedText: 0 }
  it('leaves unindexed and already-matching messages alone', () => {
    expect(recallAction({ ...base, existing: [], expected: ['a'] })).toBe(
      'not-indexed'
    )
    expect(recallAction({ ...base, existing: ['a'], expected: ['a'] })).toBe(
      'fresh'
    )
  })
  it('re-indexes stale chunks of a rewritten answer or holding removed text', () => {
    expect(
      recallAction({ ...base, rewrites: 1, existing: ['x a'], expected: ['a'] })
    ).toBe('reindex')
    expect(
      recallAction({
        ...base,
        chunksWithRemovedText: 1,
        existing: ['narration'],
        expected: ['answer']
      })
    ).toBe('reindex')
  })
  it('does not touch chunks that are stale for unrelated reasons', () => {
    expect(
      recallAction({ ...base, existing: ['old'], expected: ['new'] })
    ).toBe('stale-unrelated')
  })
})

describe('narrationOnlyInChunks', () => {
  it('finds a narration preamble the stored chunks hold but the index would not', () => {
    const stored = [
      'I now have comprehensive, high-quality information from multiple recent sources. Let me compose a thorough answer.\n\n## Title\n\nBody text here.'
    ]
    const expected = ['## Title\n\nBody text here.']
    // "Let me compose…" is not one of the app's starters; the first sentence is.
    expect(narrationOnlyInChunks(stored, expected)).toEqual([
      'I now have comprehensive, high-quality information from multiple recent sources.'
    ])
    expect(
      recallAction({
        existing: stored,
        expected,
        rewrites: 0,
        chunksWithRemovedText: 0
      })
    ).toBe('reindex')
  })
  it('ignores non-narration differences such as a stripped id', () => {
    const stored = [
      'Get the VMCreatorId (usually `{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}`), then check it.'
    ]
    const expected = ['Get the VMCreatorId (usually `{}`), then check it.']
    expect(narrationOnlyInChunks(stored, expected)).toEqual([])
  })
})
