import { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  narrationCleanView,
  stripNarrationFromMessage
} from '../strip-narration-from-message'
import {
  findGluedHeadingSeam,
  looksLikeInterStepChatter,
  stripGluedHeadingPreamble,
  stripNarrationPreamble
} from '../strip-narration-preamble'

// Language-agnostic structural rules (D20 addendum). Fixtures come from a real
// prod chat (pq6zs7w88m1kmowjdu9udfrw, deepseek-v4-pro:cloud, Vietnamese,
// 2026-09-28), trimmed to what each case needs.

const texts = (msg: UIMessage) =>
  (msg.parts as any[]).filter(p => p.type === 'text').map(p => p.text as string)

const assistant = (parts: unknown[]) =>
  ({ id: 'm1', role: 'assistant', parts }) as unknown as UIMessage

// A realistic answer body, long enough to outweigh any preamble in front of it.
const VI_BODY =
  '\n\nDưới đây là diễn biến chi tiết theo **từng chương** trong nguyên tác tiểu thuyết.\n\n---\n\n### HỒI 1 — Cái chết của Cự Phủ Sáng Thế Giả\n\n' +
  '- Cự Phủ Sáng Thế Giả cầm **tàn đồ Khuynh Phong Giới** do La Phong dâng lên, một mình tiến vào vùng nội thành hung hiểm.\n'.repeat(
    10
  )

// --- Real prod fixtures -----------------------------------------------------

const VI_CHATTER_1 =
  'Tôi cần đọc trang fandom này để lấy cấu trúc chi tiết từng chương mà người dùng muốn.'
const VI_CHATTER_2 =
  'Tôi đã thấy cấu trúc của trang wiki. Bây giờ tôi cần đọc trang chi tiết về Huge Axe Dojo (Vũ Trường Cự Phủ), True God, và đặc biệt là trang về các nhân vật liên quan đến cuộc chiến (Huge Axe Founder, Hao Lei Star Master). Hãy tìm các trang cụ thể.'
const VI_CHATTER_3 =
  'Các trang fandom này không trả về nội dung thực tế (chỉ có menu điều hướng và cookie). Tôi cần tìm nguồn khác chi tiết hơn về từng trận đánh trong cuộc chiến. Để tôi tìm kiếm trực tiếp với nội dung chi tiết từng trận.'

// Final part of message 5QwVrzsknYgVionD: narration + a bullet list of
// "sources", then a stray </think> glued to the answer heading.
const VI_PREAMBLE_THINK =
  'Tôi đã có thông tin rất chi tiết từ các chương tiểu thuyết gốc (hetushu.com, longzu5.net, 52shuku.net) về trận chiến La Phong giết Hạo Lôi Tinh Chủ qua từng chương. Tôi có đủ chi tiết để viết câu trả lời theo đúng cấu trúc "qua từng chương truyện" mà người dùng muốn. Bây giờ tôi sẽ tổng hợp thành câu trả lời đầy đủ.\n\n' +
  'Các nguồn chính:\n' +
  '- Chương "最强者的陨落" (Sự vẫn lạc của kẻ mạnh nhất)\n' +
  '- Chương 12 "海底之战" (Trận chiến dưới đáy biển)\n' +
  '- Chương 11 "等着收网" (Chờ thu lưới)\n' +
  '- Chương 334 "击杀至强者" (Giết chí cường giả)\n' +
  '- Chương 15 "声威" (Thanh thế)\n' +
  '- Chương 7 "抓了等你" (Bắt lại chờ ngươi)\n\n' +
  'Tôi đã có đủ chi tiết để viết một câu trả lời chi tiết theo từng chương.</think>'
const VI_HEADING_1 =
  '## **吞噬星空 (Tūnshì Xīngkōng — Thôn Phệ Tinh Không): Toàn cảnh từng chương — từ cái chết Cự Phủ đến khi kết thúc chiến tranh**'

// Final part of message CudKSRYhSNZxq2Ox: the heading glued straight after a
// sentence, no tag, no newline.
const VI_PREAMBLE_GLUED =
  'Tôi đã có đủ thông tin. Kết quả tìm kiếm cho thấy sự kiện "Cự Phủ chết" chính là "巨斧创始者陨落" (Cự Phủ Sáng Thế Giả vẫn lạc). Tôi có đủ tài liệu để viết câu trả lời đầy đủ.\n\n' +
  'Lưu ý: cần xác định rõ "cự phủ" ở đây. Trong ngữ cảnh Thôn Phệ Tinh Không, "Cự Phủ" = 巨斧创始者 (Cự Phủ Sáng Thế Giả / Cự Phủ Sáng Lập Giả), người sáng lập Vũ Trường Cự Phủ. Tôi sẽ viết theo đúng nghĩa này.\n\n' +
  'Bây giờ viết câu trả lời.'
const VI_HEADING_2 =
  '## **吞噬星空 (Tūnshì Xīngkōng — Thôn Phệ Tinh Không): Diễn biến sau khi Cự Phủ Sáng Thế Giả vẫn lạc cho tới khi cuộc chiến kết thúc**'

describe('real Vietnamese chat (pq6zs7w88m1kmowjdu9udfrw)', () => {
  it('drops every inter-step status part and cuts the </think>-glued preamble', () => {
    const msg = assistant([
      { type: 'step-start' },
      { type: 'text', text: VI_CHATTER_1 },
      { type: 'tool-fetch', toolCallId: 'f1' },
      { type: 'tool-fetch', toolCallId: 'f2' },
      { type: 'step-start' },
      { type: 'text', text: VI_CHATTER_2 },
      { type: 'tool-fetch', toolCallId: 'f3' },
      { type: 'step-start' },
      { type: 'text', text: VI_CHATTER_3 },
      { type: 'tool-search', toolCallId: 's1' },
      { type: 'tool-search', toolCallId: 's2' },
      { type: 'step-start' },
      { type: 'text', text: VI_PREAMBLE_THINK + VI_HEADING_1 + VI_BODY }
    ])

    const out = stripNarrationFromMessage(msg)
    expect(texts(out)).toEqual([VI_HEADING_1 + VI_BODY])
    // Tool and step parts are untouched.
    expect((out.parts as any[]).filter(p => p.type !== 'text')).toHaveLength(9)
  })

  it('cuts a preamble glued to the heading with no newline ("…lời.## ")', () => {
    const text = VI_PREAMBLE_GLUED + VI_HEADING_2 + VI_BODY
    expect(findGluedHeadingSeam(text)).toBe(VI_PREAMBLE_GLUED.length)
    expect(stripNarrationPreamble(text)).toBe(VI_HEADING_2 + VI_BODY)
  })

  it('is idempotent', () => {
    const once = stripNarrationPreamble(
      VI_PREAMBLE_THINK + VI_HEADING_1 + VI_BODY
    )
    expect(stripNarrationPreamble(once)).toBe(once)
    const msg = assistant([
      { type: 'text', text: VI_CHATTER_1 },
      { type: 'tool-fetch', toolCallId: 'f1' },
      { type: 'text', text: VI_PREAMBLE_GLUED + VI_HEADING_2 + VI_BODY }
    ])
    const cleaned = stripNarrationFromMessage(msg)
    expect(stripNarrationFromMessage(cleaned)).toBe(cleaned)
  })
})

describe('other languages', () => {
  const ZH_BODY =
    '\n\n截至2026年9月，Node.js 的当前 LTS 版本是 24.x，维护期至2028年4月。[1](#t1)\n\n' +
    '### 支持周期\n\n- 活跃 LTS：18 个月\n- 维护 LTS：12 个月\n'.repeat(4)

  it('Chinese: drops inter-step chatter and cuts a glued seam', () => {
    const msg = assistant([
      { type: 'text', text: '让我为您查询最新的 Node.js LTS 版本信息。' },
      { type: 'tool-search', toolCallId: 't1' },
      {
        type: 'text',
        text: '搜索结果不够具体，我再抓取一下官方发布计划页面。'
      },
      { type: 'tool-fetch', toolCallId: 't2' },
      {
        type: 'text',
        text:
          '我已经收集到足够的信息，现在开始撰写答案。## Node.js LTS 版本与支持周期' +
          ZH_BODY
      }
    ])
    expect(texts(stripNarrationFromMessage(msg))).toEqual([
      '## Node.js LTS 版本与支持周期' + ZH_BODY
    ])
  })

  it('Spanish: drops inter-step chatter and cuts a glued seam', () => {
    const ES_BODY =
      '\n\nLa RTX 5060 cuesta alrededor de 299 USD y rinde un 20 % más que la RTX 4060 en 1080p. [1](#t1)\n\n' +
      '### Rendimiento\n\n'.concat(
        'En la mayoría de los juegos modernos supera los 100 FPS con DLSS activado. '.repeat(
          5
        )
      )
    const msg = assistant([
      {
        type: 'text',
        text: 'Déjame buscar más información sobre el precio actual en tiendas.'
      },
      { type: 'tool-search', toolCallId: 't1' },
      {
        type: 'text',
        text:
          'Ya tengo suficiente información. Ahora escribiré la respuesta.## Comparativa RTX 5060' +
          ES_BODY
      }
    ])
    expect(texts(stripNarrationFromMessage(msg))).toEqual([
      '## Comparativa RTX 5060' + ES_BODY
    ])
  })

  it('English: the structural rule also catches chatter the phrase list missed', () => {
    // Stored prod examples the English starters never matched.
    for (const chatter of [
      'The fetches failed. I will try other sources from the search results.',
      'Let me try different search approaches.',
      'One more check on the specific DJI model’s UPS specs.'
    ]) {
      const answer =
        '## Answer\n\nThe DJI Power 1000 V2 switches to battery in under 20 ms, which is fast enough for most PCs. [1](#t1)'
      const msg = assistant([
        { type: 'text', text: chatter },
        { type: 'tool-search', toolCallId: 't1' },
        { type: 'text', text: answer }
      ])
      expect(texts(stripNarrationFromMessage(msg))).toEqual([answer])
    }
  })

  it('English: existing phrase-rule behaviour is unchanged', () => {
    const preamble =
      'I have comprehensive data now. Let me construct the comparison.\n'
    const answer = '## Intel Arc B770 vs RTX 5060\nHere is the comparison.'
    expect(stripNarrationPreamble(preamble + answer)).toBe(answer)
    // A genuine intro before a proper heading stays.
    const intro =
      'TCP and UDP are both transport-layer protocols, but they serve opposite design goals.\n\n## TCP\n\nTCP is reliable.'
    expect(stripNarrationPreamble(intro)).toBe(intro)
  })

  it('cuts a stray glyph glued in front of the heading (prod: "និ## How to…")', () => {
    const text =
      'និ## How to Change a Flat Bike Tire\n\nChanging a flat tire is a fundamental skill for every cyclist.'
    expect(stripNarrationPreamble(text)).toBe(
      '## How to Change a Flat Bike Tire\n\nChanging a flat tire is a fundamental skill for every cyclist.'
    )
  })
})

describe('false-positive guards', () => {
  it('keeps a real intro paragraph before a proper "\\n\\n## " heading, in any language', () => {
    const en =
      'Your SSH server inside WSL2 is running perfectly — the problem is on the Windows side.\n\n## Fix the port proxy\n\nRun these commands.'
    const vi =
      'Tôi đã có đủ thông tin chi tiết. Bây giờ tôi có thể tổng hợp câu trả lời.\n\n## Kết quả\n\nNội dung trả lời.'
    expect(stripNarrationPreamble(en)).toBe(en)
    // Non-English narration before a PROPER heading is a known residual: the
    // structural seam rule never touches a real line-start heading.
    expect(stripNarrationPreamble(vi)).toBe(vi)
  })

  it('keeps a long or structured partial answer written before a tool call', () => {
    const structured =
      '## Key Findings:\n\n1. **GPU Architectures:** Pascal (GP106) vs Turing (TU102)\n2. **Driver EOL:** R580 is the last Pascal branch [1](#t1)\n3. Turing is still supported.'
    const table =
      'Quick comparison:\n\n| Card | Price |\n|---|---|\n| A310 | $110 |'
    const list =
      'Here is what I have so far:\n- Gaur is the largest wild bovine\n- Belgian Blue is the most muscular\n- Water buffalo is the strongest worker'
    const cited =
      'The P551 is discontinued. [1](#t1) Let me get the PBLMS01B specs.'
    const long = 'Zwischenergebnis: '.concat(
      'Die Karte ist schnell und sparsam. '.repeat(20)
    )
    for (const interim of [structured, table, list, cited, long]) {
      expect(looksLikeInterStepChatter(interim)).toBe(false)
      const msg = assistant([
        { type: 'text', text: interim },
        { type: 'tool-todoWrite', toolCallId: 't1' },
        { type: 'text', text: '## Report\n\n' + 'Full findings. '.repeat(60) }
      ])
      expect(texts(stripNarrationFromMessage(msg))[0]).toBe(interim)
    }
  })

  it('keeps a short real reply followed by a side-effect tool and a shorter sign-off', () => {
    const msg = assistant([
      {
        type: 'text',
        text: 'The capital of Australia is Canberra, not Sydney.'
      },
      { type: 'dynamic-tool', toolName: 'remember', toolCallId: 't1' },
      { type: 'text', text: 'Noted.' }
    ])
    expect(stripNarrationFromMessage(msg)).toBe(msg)
  })

  it('keeps a non-final text part that is followed by text, not a tool', () => {
    const msg = assistant([
      { type: 'text', text: 'Tôi sẽ trả lời ngay.' },
      { type: 'reasoning', text: '…' },
      {
        type: 'text',
        text: '## Trả lời\n\nNội dung trả lời đầy đủ ở đây, dài hơn phần mở đầu.'
      }
    ])
    expect(stripNarrationFromMessage(msg)).toBe(msg)
  })

  it('never cuts at a "##" inside a fenced code block or inline code', () => {
    const fenced =
      'Use this Markdown:\n\n```md\nIntro.## Not a seam\n```\n\n## Real heading\n\nBody text here.'
    const inline =
      'Write `Title.## Sub` literally, then continue with the rest of the answer text.'
    const unclosed = 'Streaming code:\n```\nfoo.## bar'
    expect(findGluedHeadingSeam(fenced)).toBeNull()
    expect(findGluedHeadingSeam(inline)).toBeNull()
    expect(findGluedHeadingSeam(unclosed)).toBeNull()
    for (const t of [fenced, inline, unclosed]) {
      expect(stripNarrationPreamble(t)).toBe(t)
    }
  })

  it('never treats "## " after a space, "###", or an escaped "\\##" as a seam', () => {
    const spaced =
      'In Markdown, use ## for a level-two heading and ### for level three.'
    const h3 =
      'Summary first.### Details\n\nMore text that is longer than the summary.'
    const escaped =
      'Literal hashes: foo\\## bar and more explanatory text after it.'
    for (const t of [spaced, h3, escaped]) {
      expect(findGluedHeadingSeam(t)).toBeNull()
      expect(stripNarrationPreamble(t)).toBe(t)
    }
  })

  it('keeps the text when the prefix has its own heading, cites, or outweighs the rest', () => {
    const ownHeading =
      '## Answer\n\nFirst section of the real answer.## Second section\n\nMore.'
    const cites =
      'The RTX 5060 costs $299 [1](#t1).## Details\n\n' +
      'Longer body text. '.repeat(20)
    const outweighs =
      'This is a long paragraph of real answer prose that goes on and on. '.repeat(
        3
      ) + '## Short tail'
    const huge =
      'Tôi đang suy nghĩ. '.repeat(120) + '## Heading\n\n' + 'x '.repeat(3000)
    for (const t of [ownHeading, cites, outweighs, huge]) {
      expect(stripGluedHeadingPreamble(t)).toBe(t)
    }
  })
})

describe('narrationCleanView (render path)', () => {
  it('memoizes per message object and passes user messages through', () => {
    const msg = assistant([
      { type: 'text', text: VI_CHATTER_1 },
      { type: 'tool-fetch', toolCallId: 'f1' },
      { type: 'text', text: VI_PREAMBLE_GLUED + VI_HEADING_2 + VI_BODY }
    ])
    const view = narrationCleanView(msg)
    expect(narrationCleanView(msg)).toBe(view)
    expect(texts(view)).toEqual([VI_HEADING_2 + VI_BODY])
    const user = {
      id: 'u',
      role: 'user',
      parts: [{ type: 'text', text: VI_CHATTER_1 }]
    } as any
    expect(narrationCleanView(user)).toBe(user)
  })

  it('cleans a streaming message as soon as the seam and the next tool call arrive', () => {
    // Mid-stream snapshots, as @ai-sdk/react would hand them to the renderer.
    const s1 = assistant([{ type: 'text', text: VI_CHATTER_1 }])
    expect(texts(narrationCleanView(s1))).toEqual([VI_CHATTER_1]) // nothing follows yet
    const s2 = assistant([
      { type: 'text', text: VI_CHATTER_1 },
      { type: 'tool-fetch', toolCallId: 'f1' },
      { type: 'text', text: VI_PREAMBLE_GLUED.slice(0, 120) }
    ])
    // The chatter is gone once a tool call follows; the final part is still
    // the (muted, heading-less) preamble in progress.
    expect(texts(narrationCleanView(s2))).toEqual([
      VI_PREAMBLE_GLUED.slice(0, 120)
    ])
    const s3 = assistant([
      { type: 'text', text: VI_CHATTER_1 },
      { type: 'tool-fetch', toolCallId: 'f1' },
      { type: 'text', text: VI_PREAMBLE_GLUED + VI_HEADING_2 + VI_BODY }
    ])
    expect(texts(narrationCleanView(s3))).toEqual([VI_HEADING_2 + VI_BODY])
  })
})
