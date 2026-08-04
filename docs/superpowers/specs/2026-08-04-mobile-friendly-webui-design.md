# Mobile-Friendly Web UI — Design

**Date:** 2026-08-04
**Status:** Approved design → implementation plan
**Scope:** Full mobile audit + fix (user-chosen). Lab-first (`ask-flow`/`flow-design`), then port to staging + prod per the established flow.

## Goal

Make the Ask web UI usable and clean on phone-width viewports (target ~390px, breakpoint `< sm` = 640px). The app is already largely responsive; the damage is concentrated in a few control rows that assume desktop width and overflow. Fix those and a small number of related mobile issues, without changing the desktop layout.

## Guiding principle

**Control rows must degrade, never overflow.** On phones, essential actions (Send, primary nav) stay visible and tappable; secondary/flexible content (control labels, the model name, header pills) collapses to icons, shrinks, or wraps. Everything is mobile-first Tailwind: base styles target the phone, `sm:`+ restores the desktop treatment. Desktop is visually unchanged.

## Audit findings (what we're fixing)

Confirmed at 390px via Playwright screenshots:

| # | Issue | Where | Severity |
|---|-------|-------|----------|
| 1 | Composer control row overflows; model name clips and **Send is pushed off-screen** | `chat-panel.tsx` controls row (~L820); home box + answer reply box | P0 — functional |
| 2 | Library header pill row (`30+ chats · Recent activity · Clear`) runs off the right edge | `library-panel.tsx` header (~L372/L393, `shrink-0` group) | P1 |
| 3 | Sidebar drawer does not auto-close on navigation — tapping a nav item leaves it covering the destination | sidebar drawer / nav items | P1 |
| 4 | Drawer is ~290px (desktop expanded width) on a 390px screen | sidebar drawer | P2 |
| 5 | Answer tables / wide code blocks may cause whole-page horizontal scroll (no `overflow-x` wrapper found) | `message.tsx` / `lib/render` streamdown components | P2 — verify then fix if real |

Already fine on mobile (no change): Discover (tabs wrap, cards stack), answer body text, model dropdown popover, login/auth pages, chat-list rows, settings dialog (coded near-fullscreen).

## Design by component

### 1. Composer control row (P0) — chosen direction: **C + D (icons on phones)**

Visual reference: the "C + D · chosen" frame in the design mockup artifact.

On phones (`< sm`), the entire control row collapses to icons; on `sm:`+ it renders exactly as today.

- **Attach** — already an icon; unchanged.
- **Depth selector** (Balanced/Quality) — text label `hidden sm:inline`; icon-only on phones.
- **Web / search-mode selector** — text label `hidden sm:inline`; icon-only on phones.
- **Model selector** — provider icon + **short hint** + chevron on phones; full name at `sm:`+.
  - Short hint = `model.name` with a trailing `:cloud` / `:free` / `:latest` tag stripped, rendered in a small `max-w-[~4rem] truncate`. With depth/mode as icons there is room, so most names show in full (`kimi-k2.6`, `glm-5.2`, `minimax-m3`); only very long ids ellipsize. Full name always available in the dropdown. No new config field; derivation is a pure helper (`lib/utils`), unit-tested.
  - The model must use a glyph distinct from the Web-mode globe. Use the model's provider icon if the selector already has one; otherwise a dedicated model glyph (e.g. a chip) so "mode" and "model" never look identical.
- **Send** — `shrink-0`, always rendered and fully visible. This is the invariant the whole change protects.

Row mechanics: keep the single `flex items-center justify-between` row; ensure the left group can shrink (`min-w-0`) and Send never shrinks. No wrapping needed once labels are icons — the icon row fits comfortably at 390px.

### 2. Library header (P1)

On phones, the `shrink-0` pill group (`30+ chats`, `Recent activity`, `Clear`) must not overflow. Apply the same rule: give the pills icon-only / abbreviated forms on phones (`hidden sm:inline` on their text), or let the header wrap to a second line (`flex-wrap`) — whichever reads better in-browser. Title stays `truncate min-w-0`. Decide the exact treatment during implementation by looking at both at 390px.

### 3. Sidebar drawer auto-close on navigation (P1)

On phones, selecting a nav item (Home/Discover/Library) or the New-chat action closes the drawer so the destination is visible. Desktop (persistent sidebar) is unaffected. Implement by closing the mobile drawer state on nav-item activation.

### 4. Drawer width (P2)

Give the mobile drawer a phone-appropriate width (e.g. `w-[min(88vw,20rem)]`) instead of the desktop expanded width, so a backdrop strip remains tappable to dismiss. Desktop width unchanged.

### 5. Answer tables / code overflow (P2)

Verify in-browser with an answer that contains a wide table and a long code line at 390px. If the page scrolls sideways, wrap the offending renderers (table, pre/code) in an `overflow-x-auto` container with `max-w-full` so only that block scrolls, never the page body. If streamdown already handles it, no change — record that it was verified.

## Breakpoint & mechanics

- Single breakpoint: `sm` (640px). Base = phone treatment, `sm:` = current desktop treatment. Mobile-first.
- Label hiding via `hidden sm:inline` (or `sm:inline-flex`) on the text spans, keeping the icon always present.
- No JS viewport detection for layout; pure CSS/Tailwind classes so it's SSR-safe and resize-correct. Drawer auto-close is the only behavioral (JS) change.

## Components likely touched

- `components/chat-panel.tsx` — composer control row.
- `components/model-selector-client.tsx` — mobile hint + icon; short-name helper usage.
- `components/search-mode-selector.tsx` (+ depth/attach controls) — icon-only labels on phones.
- `components/library/library-panel.tsx` — header pills.
- Sidebar component(s) — drawer auto-close + width.
- `lib/utils/model-short-name.ts` (new) — pure hint derivation + tests.
- Possibly `lib/render/*` / `message.tsx` — table/code overflow wrapper (only if verification shows a real overflow).

## Testing

- Playwright at a 390px viewport against the lab (auth-off, `:3742`): screenshot each fixed surface (composer on home + answer, Library header, drawer open + after-nav, an answer with a table/code) and confirm no horizontal overflow and Send always visible. (Playwright is used here only for deterministic viewport rendering; it does not replace the browser-based functional testing rule.)
- Unit test the model short-name helper (suffix strip + edge cases).
- Existing component tests for `chat-panel` / `search-mode-selector` / `model-selector` must stay green; add assertions where a label's mobile visibility is load-bearing.
- Desktop regression: confirm `sm:`+ renders identically to today (spot-check at ≥640px).

## Non-goals

- No redesign of desktop layout.
- No change to Discover, auth, answer body, or the model dropdown (already fine).
- No new mobile-only navigation paradigm beyond the drawer auto-close.
- No per-model config `short` field (derive the hint instead).

## Rollout

Lab first (`flow-design`), verify at 390px in-browser, then cherry-pick → staging (`admin-feature`), verify, → fast-forward `dev` (prod), reclaim, push `origin/dev`. Same flow used for the discover/entity fixes.

## Risks

- **Icon ambiguity** (mode globe vs model glyph) — mitigated by using distinct glyphs; verify visually.
- **Hint over-truncation** — a name could ellipsize to something unhelpful; the dropdown always shows the full name, and the cap is generous because depth/mode are icons.
- **Hidden-duplicate DOM** made JS measurement unreliable during the audit; rely on visual screenshots for verification, not `getBoundingClientRect`.
