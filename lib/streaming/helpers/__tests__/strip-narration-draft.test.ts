import { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import { smoothAndStripNarration } from '../smooth-and-strip-narration'
import {
  narrationCleanView,
  stripNarrationFromMessage
} from '../strip-narration-from-message'
import {
  findDraftRestartSeam,
  stripDraftBeforeRestart,
  stripGluedHeadingPreamble,
  stripNarrationPreamble
} from '../strip-narration-preamble'

// A planning DRAFT written into the final text part, in front of an answer
// that restarts at a glued `## `. Fixtures are trimmed from prod chat
// mzwbeqoe15wgh12et66fybzo (glm-5.3-flash:cloud, 2026-10-06): each keeps the
// shape that matters (outline headings, notes using the prompt's vocabulary,
// the glued seam, an answer restating the outline) and drops the rest.

const assistant = (parts: unknown[]) =>
  ({ id: 'm1', role: 'assistant', parts }) as unknown as UIMessage

const texts = (msg: UIMessage) =>
  (msg.parts as any[]).filter(p => p.type === 'text').map(p => p.text as string)

const TOOL = {
  type: 'tool-search',
  toolCallId: 't1',
  state: 'output-available'
}

// --- KcVeSD8cpF3bn6dA: outline + toolCallId notes + "Structure:" outline ----

const KCVE_DRAFT =
  '## Why the same driver number behaves differently\n- explanation with citations\n\n' +
  '## First fix the build\n- 22.0.429 fix\n\n' +
  '## Pinpoint the crashing subsystem in 5 minutes\n- QT_QUICK_BACKEND software test\n- HOUDINI_OCL_DEVICETYPE CPU test\n\n' +
  'Keep it tight per user preference. Citations format: [n](#toolCallId). Available cite strings (toolCallIds) in this turn:\n' +
  '- 71cee5ba-bf5d-4418-9a2b-6e2feaed7510 — first search (multiple results share this id; results 1-31 all have same cite id [1](#71cee5ba...)).\n' +
  '- 74661147-ee6c-476e-b33e-a88136874505 — fetch of sidefx 462474 and 462171. The fetch returned results with cite "[1](#74661147-...)" and "[2](#74661147-...)".\n\n' +
  'For the 22.0.429 startup-crash fix claim: source = SideFX forum comment (Sept 6, 2026) "The issue was fixed in the last production build 22.0.429" [2](#74661147-ee6c-476e-b33e-a88136874505).\n\n' +
  'Structure:\n' +
  '## Why H22 segfaults where H21 doesn\'t (and why the two "same" drivers differ)\n' +
  '### Step 1 — update the H22 build\n' +
  '### Step 2 — make the NVIDIA-web package behave like the Windows Update package\n' +
  "### If it's still crashing\n- ticket + logs\n\n" +
  'Write final answer now. Remember: start with `## `, no preamble. Citations after periods. No citations after citation. Related spec block at end.'

const KCVE_ANSWER =
  '## Why the two "identical" drivers behave differently — and how to fix H22\'s startup segfault\n\n' +
  "The segfault you're seeing is a known failure class in Houdini 22's startup GPU initialization: it dies at the splash screen before the UI loads, while H21/21.5 run fine on the same machine. [1](#be7b3cbf-216f-48d0-ab58-5fb57f1ede37) SideFX themselves have acknowledged that current NVIDIA driver versions cause instability with H22. [2](#74661147-ee6c-476e-b33e-a88136874505)\n\n" +
  '### Step 1 — update the H22 build first\n\n' +
  '- If your copy is older than **22.0.429**, update it: the production build released ~Sept 1, 2026 fixed the Houdini 22 startup crash. [2](#74661147-ee6c-476e-b33e-a88136874505)\n\n' +
  '### Step 2 — make the NVIDIA website package behave like the Windows Update package\n\n' +
  '1. Run **DDU (Display Driver Uninstaller)** in Safe Mode first — you\'ve layered many drivers on this machine, and leftover mismatched OpenCL/Vulkan components are a classic cause of "same version still crashes."\n'

// --- 5smeUU2ObnUBdDMw: outline + "Citations mapping:" with shortened ids ----

const FIVE_DRAFT =
  "## You're already on the latest production build — the build isn't the problem\n" +
  '- .459 = latest production (Oct 1, 2026) per SteamDB + SideFX announcement; 462 is newest in changelog but no startup fix entries.\n\n' +
  '## Do this on the website driver (10 minutes)\n- hgpuinfo -q / houclinfo test to isolate\n- custom install display-driver-only + clean install + DDU, bisect components\n\n' +
  'Citations mapping:\n' +
  '- .459 latest production: [3](#17d98f5d) SteamDB; [5](#17d98f5d) sidefx announcement. Also changelog 462 [1](#bbad709f).\n' +
  '- Vulkan-only: [3](#bbad709f).\n\n' +
  "No images available (search results had none). Related questions spec block: worthwhile? The user prefers concise; I'll skip.\n\n" +
  'Format: start with ## heading immediately. Concise, bolded bullets.'

const FIVE_ANSWER =
  "## You're on the latest production build — the build is not the problem\n\n" +
  "- **22.0.459 is the current production build**, released Oct 1, 2026. [3](#17d98f5d-f270-46f8-92e8-e2acaa3a4705) SideFX announced it as the official production update. [5](#17d98f5d-f270-46f8-92e8-e2acaa3a4705) The changelog shows only 22.0.461/462 since then, no startup-crash fix among them. [1](#bbad709f-09fa-4dc7-87b4-584308580f6b) So updating further won't change your symptom.\n\n" +
  '## Why the website driver crashes at the same version number\n\n' +
  "- **H22 removed the OpenGL renderer entirely — the viewport is Vulkan-only now.** [3](#bbad709f-09fa-4dc7-87b4-584308580f6b) That's precisely why H21 tolerates every driver package and H22 doesn't.\n"

// --- O7Tv2K7F1524GQeU: heading-less notes, longer than the answer ----------

const O7TV_DRAFT =
  'I have the answer. The user asks where the policy is. Give exact paths:\n\n' +
  '**Group Policy (main one):**\n' +
  '`Computer Configuration → Administrative Templates → Windows Components → Windows Update → Manage updates offered from Windows Update → "Do not include drivers with Windows Updates"` → Enabled.\n\n' +
  'Note: on Win10 the path is `Windows Update` without the "Manage updates offered..." subfolder. Registry equivalent: HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate → DWORD ExcludeWUDriversInQualityUpdate = 1. This works on Home too.\n\n' +
  'The user\'s concern: they currently rely on Windows Update delivering 591.86 which works, and want to *keep* that driver but prevent WU from updating it further. So the policy to prevent Windows from updating the driver is "Do not include drivers with Windows Updates" — but careful: that also *stops* the thing that currently delivers their working 591.86.\n\n' +
  'Keep concise per user preference. Provide citation for ninjaone and MS Q&A. Both fetched results have same cite id but two entries [1] and [2].\n\n' +
  'Also worth a caution note: this policy blocks ALL driver delivery via WU — including future fixes from WU; they would manage drivers manually.\n\n' +
  'Related questions spec block? Simple factual lookup — skip.'

const O7TV_ANSWER =
  '## Group Policy location for driver updates via Windows Update\n\n' +
  '- **Path:** `Computer Configuration → Administrative Templates → Windows Components → Windows Update → Manage updates offered from Windows Update`\n' +
  '- **Setting:** **"Do not include drivers with Windows Updates"** → set to **Enabled** = Windows stops delivering driver updates; Disabled/Not Configured = drivers get delivered again.\n' +
  '- Then run `gpupdate /force` in an admin Command Prompt to apply immediately.\n\n' +
  '### Registry equivalent (works on Home edition too, where gpedit is absent)\n\n' +
  '- Key: `HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate` (create if missing). Reboot after setting the value. [2](#03550a31-1936-440f-ab0f-f9ef4a85bc4a)\n'

// --- fF2Egp8P0GA6jvzn: outline with ### steps, then `</think>## ` ----------

const FF2E_DRAFT =
  '## Getting Windows Update to install the NVIDIA driver again\n\n' +
  '### 1. Remove the block\n- Policy "Do not include drivers with Windows Updates" → **Not Configured** (or Disabled); registry: delete ExcludeWUDriversInQualityUpdate or set 0; gpupdate /force. [33 elevenforum]\n\n' +
  '### 3. Force it when it says "no updates available"\n- WU only offers a driver if it\'s newer than installed. DDU clean uninstall → reboot with internet → WU auto-installs the WU-flavored NVIDIA driver.\n\n' +
  'Bottom line: reverse the exclusion, check optional updates, or grab the exact WU package from the Update Catalog.\n\n' +
  'Keep it tight. Citations placed after periods. No emojis. No related-questions block (simple operational task — skip per rules).</think>'

const FF2E_ANSWER =
  '## Re-enabling Windows Update driver delivery\n\n' +
  '### 1. Undo any block you set earlier\n\n' +
  '- **Group Policy:** set `Windows Update → Manage updates offered from Windows Update → "Do not include drivers with Windows Updates"` to **Not Configured** (or Disabled) — when disabled/not configured, Windows Update includes updates with the Driver classification. [33](#7ce713d3-b481-4f83-9a3c-41be67519905)\n\n' +
  '### 3. Forcing it when WU says "no updates available"\n\n' +
  '- Windows Update only offers a driver that is newer than the one installed, so run DDU in Safe Mode, reboot with the network connected, and let Windows Update install its own NVIDIA package. [17](#7ce713d3-b481-4f83-9a3c-41be67519905)\n'

const REAL_SHAPES: Array<[string, string, string]> = [
  ['KcVe (outline + toolCallId notes, 15 KB in prod)', KCVE_DRAFT, KCVE_ANSWER],
  ['5sme (outline + "Citations mapping")', FIVE_DRAFT, FIVE_ANSWER],
  [
    'O7Tv (heading-less notes, longer than the answer)',
    O7TV_DRAFT,
    O7TV_ANSWER
  ],
  ['fF2E (### outline, then </think>## )', FF2E_DRAFT, FF2E_ANSWER]
]

describe('planning draft before a glued restart (prod mzwbeqoe15wgh12et66fybzo)', () => {
  it.each(REAL_SHAPES)(
    '%s: keeps exactly the answer',
    (_name, draft, answer) => {
      const raw = draft + answer
      expect(findDraftRestartSeam(raw)).toBe(draft.length)
      expect(stripDraftBeforeRestart(raw)).toBe(answer)
      expect(stripNarrationPreamble(raw)).toBe(answer)
    }
  )

  it.each(REAL_SHAPES)('%s: is idempotent', (_name, draft, answer) => {
    const once = stripNarrationPreamble(draft + answer)
    expect(stripNarrationPreamble(once)).toBe(once)
    expect(stripDraftBeforeRestart(answer)).toBe(answer)
  })

  it('was missed by the older rules (the prefix has its own headings or is too long)', () => {
    for (const [, draft, answer] of REAL_SHAPES) {
      expect(stripGluedHeadingPreamble(draft + answer)).toBe(draft + answer)
    }
  })

  it('never treats the `## ` inside inline code in the notes as the seam', () => {
    // KcVe's last note says "start with `## `" before the real seam.
    expect(KCVE_DRAFT).toContain('start with `## `')
    expect(findDraftRestartSeam(KCVE_DRAFT + KCVE_ANSWER)).toBe(
      KCVE_DRAFT.length
    )
  })

  it('cuts the final part at message level, and the render view agrees', () => {
    const msg = assistant([
      { type: 'step-start' },
      TOOL,
      { type: 'step-start' },
      { type: 'text', text: KCVE_DRAFT + KCVE_ANSWER }
    ])
    const cleaned = stripNarrationFromMessage(msg)
    expect(texts(cleaned)).toEqual([KCVE_ANSWER])
    expect(
      cleaned.parts.filter((p: any) => p.type === 'tool-search')
    ).toHaveLength(1)
    expect(stripNarrationFromMessage(cleaned)).toBe(cleaned)
    expect(texts(narrationCleanView(msg))).toEqual([KCVE_ANSWER])
  })

  it('cleans a streaming message once enough of the answer has arrived', () => {
    const partial = (n: number) =>
      assistant([
        TOOL,
        { type: 'text', text: FIVE_DRAFT + FIVE_ANSWER.slice(0, n) }
      ])
    // Only the heading so far: the answer is not yet substantial → unchanged.
    const early = partial(80)
    expect(texts(narrationCleanView(early))).toEqual([
      FIVE_DRAFT + FIVE_ANSWER.slice(0, 80)
    ])
    // The full answer: cut.
    expect(texts(narrationCleanView(partial(FIVE_ANSWER.length)))).toEqual([
      FIVE_ANSWER
    ])
  })
})

// --- Live stream: unchanged by design (D20) ---------------------------------

/** Run text deltas through the live transform; return the emitted deltas. */
async function streamThrough(deltas: string[]): Promise<string[]> {
  const stream = smoothAndStripNarration()({ tools: {}, stopStream: () => {} })
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()
  const out: string[] = []
  const read = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value.type === 'text-delta') out.push(value.text)
    }
  })()
  await writer.write({ type: 'text-start', id: 'p1' })
  for (const text of deltas)
    await writer.write({ type: 'text-delta', id: 'p1', text })
  await writer.write({ type: 'text-end', id: 'p1' })
  await writer.close()
  await read
  return out
}

const chunk = (s: string, size: number) =>
  Array.from({ length: Math.ceil(s.length / size) }, (_, i) =>
    s.slice(i * size, (i + 1) * size)
  )

describe('live transform (not changed: the cut needs the whole text)', () => {
  it('streams a heading-first draft through as it arrives; persist and render cut it', async () => {
    // The draft opens with `## `, exactly like a real answer, so the transform
    // cannot hold it without holding every answer. The cut depends on the text
    // AFTER the seam (no vocabulary there), so it is not final mid-stream.
    const raw = KCVE_DRAFT + KCVE_ANSWER
    const out = await streamThrough(chunk(raw, 40))
    expect(out.join('')).toBe(raw)
    expect(out.length).toBeGreaterThan(1)
    expect(stripNarrationPreamble(out.join(''))).toBe(KCVE_ANSWER)
  })

  it('holds an English-narration draft as before and flushes it unchanged at the end', async () => {
    const raw = O7TV_DRAFT + O7TV_ANSWER
    const out = await streamThrough(chunk(raw, 40))
    expect(out.join('')).toBe(raw)
    expect(stripNarrationPreamble(out.join(''))).toBe(O7TV_ANSWER)
  })
})

// --- False-positive guards --------------------------------------------------

// A real answer about Ask's citations / the AI SDK, with a glued `## ` (a
// missing newline) inside it.
const SDK_SECTION_A =
  '## How tool results are matched to calls\n\n' +
  'In the AI SDK every tool result carries a toolCallId, and the model refers back to it when it writes a citation. The id is generated per call, so two calls to the same tool never collide, and a result can always be traced to the request that produced it.'
const SDK_SECTION_B =
  '## Handling tool errors\n\n' +
  'When a tool throws, the SDK records an error result for that call instead of a normal output. The model sees the error text on the next step and can retry with different arguments, fall back to another tool, or explain to the user that the lookup failed. Keep error messages short and specific: they become part of the prompt, and a vague message makes the retry less likely to succeed. Log the full error on the server side, where it does not cost tokens.\n'

describe('false-positive guards', () => {
  it('keeps a real answer whose glued later section does not restate an earlier heading', () => {
    const raw = SDK_SECTION_A + SDK_SECTION_B
    expect(stripNarrationPreamble(raw)).toBe(raw)
  })

  it('keeps an answer that still uses the vocabulary after the seam', () => {
    const raw =
      KCVE_DRAFT +
      KCVE_ANSWER +
      'Each citation above is `[n](#toolCallId)` with the id copied from the tool result.\n'
    expect(findDraftRestartSeam(raw)).toBeNull()
    expect(stripNarrationPreamble(raw)).toBe(raw)
  })

  it('ignores the vocabulary inside code (a programming answer)', () => {
    const raw =
      '## Matching tool results in the AI SDK\n\n' +
      '```ts\nconst byId = new Map(results.map(r => [r.toolCallId, r]))\n```\n\n' +
      'Look the result up by id before rendering it.' +
      '## Matching tool results in the AI SDK (streaming)\n\n' +
      'While streaming, results arrive out of order, so keep the map in state and re-render when a new entry lands. A result whose call was cancelled never arrives; time it out instead of waiting forever. The same lookup works for both typed tools and dynamic tools, because the id is assigned by the SDK, not by the tool itself, and it is unique within a response.\n'
    expect(findDraftRestartSeam(raw)).toBeNull()
    expect(stripNarrationPreamble(raw)).toBe(raw)
  })

  it('does not count shortened ids in a valid anchor or "citation mapping" as vocabulary', () => {
    const raw =
      '## Citation mapping tools compared\n\n' +
      'VOSviewer and CiteSpace both build citation maps from a bibliography export. [2](#a1bf94e4)' +
      '## Citation mapping tools compared in practice\n\n' +
      'In practice CiteSpace is stronger for burst detection over time, while VOSviewer produces cleaner co-citation clusters and is easier to read for a first overview of a field. Both accept Web of Science and Scopus exports; Scopus files need their field names mapped first. For a quick look start with VOSviewer, then move to CiteSpace when you need timelines.\n'
    expect(findDraftRestartSeam(raw)).toBeNull()
    expect(stripNarrationPreamble(raw)).toBe(raw)
  })

  it('keeps a Vietnamese answer about citations (no prompt vocabulary)', () => {
    const raw =
      '## Cách trích dẫn nguồn trong bài luận\n\n' +
      'Mỗi trích dẫn cần ghi rõ tác giả, năm xuất bản và số trang để người đọc có thể kiểm tra lại nguồn.' +
      '## Cách trích dẫn nguồn trong bài luận theo APA\n\n' +
      'Theo chuẩn APA, trích dẫn trong văn bản gồm họ tác giả và năm, ví dụ (Nguyễn, 2020). Danh mục tài liệu tham khảo ở cuối bài được sắp xếp theo thứ tự chữ cái của họ tác giả, mỗi mục có tên sách in nghiêng, nhà xuất bản và năm. Với nguồn trực tuyến, ghi thêm đường dẫn đầy đủ và ngày truy cập nếu nội dung có thể thay đổi theo thời gian.\n'
    expect(findDraftRestartSeam(raw)).toBeNull()
    expect(stripNarrationPreamble(raw)).toBe(raw)
  })

  it('does not cut at a proper "\\n\\n## " restart (only a glued seam qualifies)', () => {
    const raw = `${KCVE_DRAFT}\n\n${KCVE_ANSWER}`
    expect(findDraftRestartSeam(raw)).toBeNull()
    expect(stripNarrationPreamble(raw)).toBe(raw)
  })

  it('does not cut when the answer after the seam is a stub', () => {
    const raw = `${KCVE_DRAFT}## Step 1 — update the H22 build first\n\nUpdate to 22.0.429.`
    expect(findDraftRestartSeam(raw)).toBeNull()
  })

  it('does not cut an outlined prefix that the answer never restates', () => {
    const raw =
      KCVE_DRAFT +
      '## A different answer entirely\n\n' +
      'This answer shares no heading with the outline in front of it, so nothing shows that outline was a plan for it; it might be real content with a missing newline. '.repeat(
        4
      )
    expect(findDraftRestartSeam(raw)).toBeNull()
  })

  it('does not match parallel sections that differ only in their number', () => {
    const raw =
      '## Part 1 — building the lookup table\n\n' +
      'Create a map keyed by toolCallId before the first step runs.' +
      '## Part 2 — building the lookup table\n\n' +
      'Then fill it as results stream in, keyed by the id the SDK assigns. '.repeat(
        10
      )
    expect(findDraftRestartSeam(raw)).toBeNull()
  })

  it('needs two vocabulary families, and no real citation, in a heading-less prefix', () => {
    const answer = O7TV_ANSWER
    const oneFamily =
      'I checked the policy paths and the spec block is not needed for this one. '.repeat(
        30
      )
    expect(findDraftRestartSeam(oneFamily + answer)).toBeNull()
    const citing =
      'The policy is documented by Microsoft. [1](#03550a31-1936-440f-ab0f-f9ef4a85bc4a) Both results share one cite id; the spec block is skipped. '.repeat(
        20
      )
    expect(findDraftRestartSeam(citing + answer)).toBeNull()
  })

  it('leaves user messages and non-text parts alone', () => {
    const user = {
      id: 'u1',
      role: 'user',
      parts: [{ type: 'text', text: KCVE_DRAFT + KCVE_ANSWER }]
    } as unknown as UIMessage
    expect(stripNarrationFromMessage(user)).toBe(user)
  })
})
