# Mobile-Friendly Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Ask web UI usable at phone width (~390px) by collapsing overflowing control rows to icons/stacks, without changing the desktop (`≥ sm`) layout.

**Architecture:** Mobile-first Tailwind. Base classes target the phone; `sm:` (640px) restores today's desktop treatment. The composer, library header, and selector controls hide their text labels below `sm`; the model selector shows a derived short hint on phones. One behavioral change: the sidebar drawer closes on navigation. Verification is primarily visual (Playwright at a 390px viewport against the lab), plus one unit-tested pure helper and the existing component test suites.

**Tech Stack:** Next.js 16, React 19, Tailwind, shadcn/ui (sidebar = Sheet), Vitest + @testing-library/react, Playwright MCP (viewport rendering only).

## Global Constraints

- Lab only (`ask-flow` worktree, branch `flow-design`, container `ask-lab` :3742). Do NOT touch staging/prod until the whole plan is done, bug-reviewed, and the user approves the port.
- Desktop (`≥ sm`, 640px) must render identically to today — every label-hide uses `hidden sm:inline` (or `sm:block`), never an unconditional removal.
- Breakpoint is `sm` (640px). No JS viewport detection for layout (SSR-safe); the only JS behavior change is drawer auto-close via the existing `useSidebar().setOpenMobile`.
- Pre-commit gate for every task: `bun typecheck` == 0 errors AND `bun lint` == 0 errors AND `bun run test` green for touched tests. ABORT the commit if any fail.
- Follow existing code style; className changes only, except the new helper + the drawer onClick.

---

### Task 1: `modelShortName` helper

Pure function that drops the shared, redundant provider tag (`:cloud` / `:free` / `:latest`) from a model name so the phone hint is compact. CSS handles width-capping; this only strips the tag.

**Files:**
- Create: `lib/utils/model-short-name.ts`
- Test: `lib/utils/model-short-name.test.ts`

**Interfaces:**
- Produces: `export function modelShortName(name: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest'

import { modelShortName } from './model-short-name'

describe('modelShortName', () => {
  test('drops the shared cloud/free/latest tag', () => {
    expect(modelShortName('kimi-k2.6:cloud')).toBe('kimi-k2.6')
    expect(modelShortName('deepseek-v4-pro:cloud')).toBe('deepseek-v4-pro')
    expect(modelShortName('some-model:free')).toBe('some-model')
    expect(modelShortName('other:latest')).toBe('other')
  })

  test('keeps a meaningful internal colon (e.g. size tag)', () => {
    // qwen3.5:397b is the model identity, not a cloud tag — keep it
    expect(modelShortName('qwen3.5:397b')).toBe('qwen3.5:397b')
  })

  test('returns names without a known tag unchanged', () => {
    expect(modelShortName('gpt-5')).toBe('gpt-5')
    expect(modelShortName('minimax-m3')).toBe('minimax-m3')
  })

  test('tolerates empty / non-string input', () => {
    expect(modelShortName('')).toBe('')
    // @ts-expect-error runtime guard
    expect(modelShortName(undefined)).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/utils/model-short-name.test.ts`
Expected: FAIL — `modelShortName` is not defined / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// Drop the shared cloud provider tag from a model name so the phone-width
// model hint stays compact (e.g. "kimi-k2.6:cloud" -> "kimi-k2.6"). Only the
// known redundant tags are stripped; an internal identity colon like
// "qwen3.5:397b" is preserved. CSS truncation is the hard width safety net.
const KNOWN_TAG = /:(cloud|free|latest)$/i

export function modelShortName(name: string): string {
  if (typeof name !== 'string' || name.length === 0) return name ?? ''
  return name.replace(KNOWN_TAG, '')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/utils/model-short-name.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
bun typecheck
git add lib/utils/model-short-name.ts lib/utils/model-short-name.test.ts
git commit -m "feat(mobile): add modelShortName helper for compact model hint"
```

---

### Task 2: Composer — icon-only controls on phones + model hint

The chosen C+D layout. Below `sm`, the depth (SearchModeSelector) and source (SourceSelector) pills show only their icon; the model selector shows Cpu icon + short hint + chevron; the Send button is untouched (fixed size, always visible). At `sm:`+ everything is exactly as today.

**Files:**
- Modify: `components/search-mode-selector.tsx` (trigger label + chevron + padding)
- Modify: `components/source-selector.tsx` (trigger label + chevron + padding)
- Modify: `components/model-selector-client.tsx:105-116` (dual name span)
- Test: `components/__tests__/search-mode-selector.test.tsx` (existing — must stay green; add mobile-visibility assertion)

**Interfaces:**
- Consumes: `modelShortName` from `@/lib/utils/model-short-name` (Task 1)

- [ ] **Step 1: SearchModeSelector — hide label + chevron below sm, tighten padding**

In `components/search-mode-selector.tsx`, the trigger button (~L76) currently has `... px-3 py-1.5 ...`. Change the padding to `px-2 py-1.5 sm:px-3`. The label span (~L91) `<span>{selectedMode?.label}</span>` becomes:
```tsx
<span className="hidden sm:inline">{selectedMode?.label}</span>
```
The trailing `ChevronDown` (~L92-99): add `hidden sm:block` to its existing `className` (via the `cn(...)` call) so it disappears on phones.

- [ ] **Step 2: SourceSelector — same treatment**

In `components/source-selector.tsx`, trigger (~L76-88): change padding `px-3` → `px-2 sm:px-3`. Label span (~L85) `<span>{triggerLabel}</span>` becomes:
```tsx
<span className="hidden sm:inline">{triggerLabel}</span>
```
Add `hidden sm:block` to the `IconChevronDown` className (~L86-88).

- [ ] **Step 3: ModelSelectorClient — full name on desktop, short hint on phones**

In `components/model-selector-client.tsx`, add the import:
```tsx
import { modelShortName } from '@/lib/utils/model-short-name'
```
Replace the single name span (L108-110):
```tsx
<span className="truncate max-w-40 text-xs font-medium">
  {selectedModel.name}
</span>
```
with two spans (desktop full name, phone hint):
```tsx
<span className="hidden truncate max-w-40 text-xs font-medium sm:inline">
  {selectedModel.name}
</span>
<span className="truncate max-w-24 text-xs font-medium sm:hidden">
  {modelShortName(selectedModel.name)}
</span>
```
Leave the `Cpu` icon and `ChevronDown` as-is (both stay on phones — the model keeps a glanceable identity).

- [ ] **Step 4: Add a mobile-visibility assertion to the existing selector test**

In `components/__tests__/search-mode-selector.test.tsx`, add a test asserting the label span carries the `hidden sm:inline` classes (so a future edit can't silently un-hide it and re-break mobile):
```tsx
test('trigger label is hidden below the sm breakpoint', () => {
  render(<SearchModeSelector />) // match existing render/setup in this file
  const label = screen.getByText(/balanced|quality|quick|thorough/i)
  expect(label.className).toContain('hidden')
  expect(label.className).toContain('sm:inline')
})
```
(Adapt the render call and matched label text to the file's existing setup and the real default mode label.)

- [ ] **Step 5: Gate — typecheck, lint, tests**

Run:
```bash
bun typecheck && bun lint && bun run test components/__tests__/search-mode-selector.test.tsx components/__tests__/model-selector-client.test.tsx
```
Expected: 0 type errors, 0 lint errors, tests green. (If `model-selector-client.test.tsx` does not exist, omit it.)

- [ ] **Step 6: Commit**

```bash
git add components/search-mode-selector.tsx components/source-selector.tsx components/model-selector-client.tsx components/__tests__/search-mode-selector.test.tsx
git commit -m "feat(mobile): collapse composer controls to icons below sm, add model hint"
```

---

### Task 3: Library page header — stack + wrap on phones

`app/library/page.tsx:378` header row is `flex items-start justify-between gap-4` (title left, `count pill + SortDropdown + Clear all` right). The right group overflows at 390px. Stack the header on phones and let the controls wrap.

**Files:**
- Modify: `app/library/page.tsx` (header row ~L378 and controls group ~L389)

- [ ] **Step 1: Stack the header below sm**

Change the outer header row (currently `flex items-start justify-between gap-4`) to:
```tsx
<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
```

- [ ] **Step 2: Let the controls wrap below sm**

Change the controls group (currently `flex items-center gap-2 mt-1`) to:
```tsx
<div className="flex flex-wrap items-center gap-2 sm:mt-1">
```

- [ ] **Step 3: Gate + commit**

Run: `bun typecheck && bun lint`
Expected: clean.
```bash
git add app/library/page.tsx
git commit -m "fix(mobile): stack library header controls below sm so pills don't overflow"
```

---

### Task 4: Sidebar drawer — close on navigation

`components/app-sidebar.tsx` nav links (`NAV_ITEMS`, ~L71-90) and the New-chat link don't close the mobile Sheet on tap, so the drawer stays over the destination. Close it via the existing `useSidebar().setOpenMobile`.

**Files:**
- Modify: `components/app-sidebar.tsx`

- [ ] **Step 1: Pull setOpenMobile/isMobile from context**

In the sidebar component body, add (near the existing hooks):
```tsx
const { isMobile, setOpenMobile } = useSidebar()
```
Import `useSidebar` from `@/components/ui/sidebar` if not already imported.

- [ ] **Step 2: Close the drawer on nav-item tap**

Add a handler and wire it to each nav `Link` (~L74) and the New-chat link (~L60):
```tsx
const closeDrawerOnMobile = () => {
  if (isMobile) setOpenMobile(false)
}
```
On the nav `Link`: `onClick={closeDrawerOnMobile}`. On the New-chat link, chain it with the existing `handleNewChatClick`:
```tsx
onClick={e => { handleNewChatClick(e); closeDrawerOnMobile() }}
```
(Match the existing `handleNewChatClick` signature; if it takes no event, drop the `e`.)

- [ ] **Step 3: Gate + commit**

Run: `bun typecheck && bun lint`
Expected: clean.
```bash
git add components/app-sidebar.tsx
git commit -m "fix(mobile): close sidebar drawer on navigation"
```

Note: the mobile drawer width (`SIDEBAR_WIDTH_MOBILE = '18rem'` in `components/ui/sidebar.tsx`) is a standard drawer width and reads fine at 390px — leave it unchanged (YAGNI).

---

### Task 5: Verify answer table/code overflow at phone width

The design flagged wide tables / long code lines as a possible whole-page horizontal-scroll source, unconfirmed. Verify before changing anything.

**Files:**
- Investigate: `lib/render/*`, `components/message.tsx` (streamdown renderers)
- Modify (only if confirmed): the table / `pre`/`code` renderer to add an `overflow-x-auto max-w-full` wrapper.

- [ ] **Step 1: Reproduce**

With the lab running (Task 6 rebuild, or a dev server), open a chat answer that contains a Markdown table and a long code line at a 390px viewport. In the page console check:
```js
document.documentElement.scrollWidth - document.documentElement.clientWidth
```
Expected finding: `0` means no page-level horizontal overflow → streamdown already handles it → **no code change**; record that it was verified and skip to Step 3. A positive value means the page scrolls sideways → proceed to Step 2.

- [ ] **Step 2: (only if overflow > 0) Wrap the offending renderer**

Locate the table (and/or `pre`) renderer in the streamdown spec/components and wrap its output in a scroll container, e.g.:
```tsx
<div className="max-w-full overflow-x-auto">{/* table / pre */}</div>
```
Re-run the Step 1 check; expect `0`.

- [ ] **Step 3: Commit (or record no-op)**

If changed:
```bash
git add <changed files>
git commit -m "fix(mobile): keep wide tables/code from scrolling the page body"
```
If no change was needed, note "verified: streamdown handles table/code overflow; no change" in the task and move on.

---

### Task 6: Rebuild lab + full visual verification at 390px

Single lab rebuild, then confirm every fixed surface visually (screenshots are the source of truth — the audit showed `getBoundingClientRect` is unreliable here due to hidden duplicate elements).

**Files:** none (verification only)

- [ ] **Step 1: Rebuild the lab container**

```bash
cd /home/nightfury/selfhosted/ask-flow
docker compose -p ask-stack-lab -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml up -d --build ask
```
Wait for `http://localhost:3742/` to return 200.

- [ ] **Step 2: Screenshot each surface at 390px (Playwright)**

Set viewport 390×844, then capture and eyeball:
1. `/` — composer: depth+source are icons, model shows Cpu + hint (e.g. `kimi-k2.6`) + chevron, **Send fully visible**.
2. `/search/<an existing id>` — reply composer: same.
3. `/library` — header stacks; count/sort/Clear all no longer clip the right edge.
4. `/` → open drawer → tap Discover → drawer closes and Discover is visible.
5. An answer with a table/code — no sideways page scroll.

- [ ] **Step 3: Desktop regression check**

Set viewport 1280×800, screenshot `/` and `/library` — confirm labels are back and the layout matches today.

- [ ] **Step 4: Full test suite**

Run: `bun run test`
Expected: green.

- [ ] **Step 5: Commit any verification notes** (if screenshots surfaced a tweak, loop back to the relevant task; otherwise nothing to commit).

---

## Self-Review

- **Spec coverage:** composer C+D (Task 2 + helper Task 1), library header (Task 3), drawer auto-close (Task 4), drawer width (Task 4 note — intentionally no-op), table/code overflow (Task 5), testing + desktop regression (Task 6). All spec sections mapped.
- **Placeholders:** none — every change gives exact classes/strings; the one conditional task (5) has an explicit measured branch.
- **Type consistency:** `modelShortName(name: string): string` defined in Task 1, imported and called identically in Task 2.
- **Deferred-by-design:** Task 3 uses the "stack" option (chosen over per-pill icon-only for the library header because the title+subtitle already occupy the row; stacking is cleaner). Task 5's fix is gated on a real measurement.
