# History & Library Overhaul — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Collapsible left sidebar with a Recent chat list (full `/library` grid retained); a real chat count instead of "30+"; fast indexed keyword search with semantic recall gated to submit.

**Architecture:** Reuse the shadcn sidebar (collapse already exists) + the orphaned `chat-menu-item` row; add a slim `getRecentChats`. Add an RLS-aware `countUserChats`. Add a `pg_trgm` GIN index so the existing substring `ILIKE` keyword search is index-backed, and gate the semantic arm to explicit submit.

**Tech Stack:** Next.js 16 App Router, React 19, Drizzle + Postgres (RLS via `app_user`, migrations via superuser `morphic`), shadcn/ui sidebar.

**Spec:** `docs/superpowers/specs/2026-08-16-history-library-overhaul-design.md`

## Global Constraints
- Lab-first on `flow-design` (`:3742`); no staging/prod port in this plan.
- All chat list/count/search DB queries run **inside `withRLS(userId, …)`** (`lib/db/with-rls.ts`) — the count and the trigram-backed search must respect the same per-user RLS policy.
- Commits by Tin Tran, NO AI/Co-Authored-By trailer.
- `bun typecheck` clean, `bun lint` 0 errors, `bun format:check` clean, `bun run test` green (NOT `bun test`).
- Trigram (substring) semantics — do NOT switch search to `tsvector`/word FTS (would change what matches).
- Fail-open: a search/count/recent failure must never break the page (return `[]`/`0`, log).

---

### Task 1: `pg_trgm` migration + trigram indexes

**Files:**
- Create: `drizzle/0021_pg_trgm_search_indexes.sql`
- Modify: `drizzle/meta/_journal.json` (append the migration entry — mirror how `0020` was added)
- Reference: `lib/db/migrate.ts` (runner), existing `drizzle/0019_*.sql` / `0020_*.sql` for the hand-written-SQL + journal pattern.

**Interfaces:**
- Produces: two GIN trigram indexes usable by Task 3's keyword search: `chats_title_trgm_idx` on `chats.title`, `parts_text_text_trgm_idx` on `parts.text_text`.

- [ ] **Step 1:** Inspect `drizzle/0020_preferred_chat_model.sql` + the tail of `drizzle/meta/_journal.json` to learn the exact file+journal convention (idx, tag, `when` timestamp shape). Confirm `lib/db/migrate.ts` connects as a role that can `CREATE EXTENSION` (superuser `morphic`); if it connects as `app_user`, the extension line must be pre-created out-of-band — note this in the report.
- [ ] **Step 2:** Write `drizzle/0021_pg_trgm_search_indexes.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS chats_title_trgm_idx ON chats USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS parts_text_text_trgm_idx ON parts USING gin (text_text gin_trgm_ops);
```
(Use `CREATE INDEX` — not `CONCURRENTLY` — since drizzle runs migrations in a transaction; the lab tables are small.)
- [ ] **Step 3:** Append the matching entry to `drizzle/meta/_journal.json`.
- [ ] **Step 4:** Run `bun migrate` against the lab DB; confirm no error and that `\di chats_title_trgm_idx parts_text_text_trgm_idx` and `\dx pg_trgm` all exist (via `docker exec ask-postgres-lab psql -U morphic -d morphic`).
- [ ] **Step 5:** `EXPLAIN ANALYZE` a representative `SELECT … WHERE parts.text_text ILIKE '%zorblax%'` before vs after — capture that it uses a Bitmap Index Scan on `parts_text_text_trgm_idx` (record numbers in the report).
- [ ] **Step 6:** Commit `feat(history): pg_trgm trigram indexes for fast chat search`.

---

### Task 2: `countUserChats` — real total

**Files:**
- Modify: `lib/db/actions.ts` (add near `getChatsPage` ~:424)
- Modify: `lib/actions/chat.ts` (expose a server-callable wrapper near `getChatsPage` ~:53)
- Modify: `app/api/chats/route.ts` (return the total, e.g. when `?withCount=1`, alongside the first page) OR add `app/api/chats/count/route.ts`
- Modify: `app/library/page.tsx` (replace the `chats.length + '+'` render ~:390-396 with the real total)
- Test: `lib/db/__tests__/…` or the existing db-actions test file

**Interfaces:**
- Produces: `countUserChats(userId: string): Promise<number>` (in `lib/db/actions.ts`, inside `withRLS`); a server action/route returning `{ total: number }`.
- Consumed by: Task 4 (sidebar footer count) and `app/library/page.tsx` header.

- [ ] **Step 1: Failing test** — `countUserChats` returns the number of a user's chats and is RLS-scoped (a chat owned by another user is not counted). Mirror the existing db-actions test setup.
- [ ] **Step 2:** Implement `countUserChats` inside `withRLS`: `const [{ value }] = await tx.select({ value: count() }).from(chats).where(eq(chats.userId, userId)); return value` (drizzle `count()` from `drizzle-orm`). It relies on `chats_user_id_idx`.
- [ ] **Step 3:** Expose via `lib/actions/chat.ts` + surface the total to the client (extend `/api/chats` response with `total` under `?withCount=1`, or a dedicated count route — pick the smaller diff; keep it one round-trip with the first page if easy).
- [ ] **Step 4:** In `app/library/page.tsx`, fetch the total on first load and render the real number (`{total} chats`), removing the `nextOffset !== null ? '+' : ''` heuristic for the header count. Keep infinite-scroll pagination unchanged.
- [ ] **Step 5:** Tests green; commit `feat(history): real chat count via countUserChats (replaces "30+")`.

---

### Task 3: Gate the semantic search arm (keyword instant, semantic on submit)

**Files:**
- Modify: `lib/db/actions.ts` (`searchUserChatsHybrid` ~:793, `searchUserChats` ~:851) — add `includeSemantic: boolean`
- Modify: `lib/actions/chat.ts` (`searchChats` ~:73) + `app/api/chats/search/route.ts:14` (read a `semantic` query param, default false)
- Modify: `app/library/page.tsx` (search box ~:417) — call keyword-only on keystroke (debounced), include semantic only on Enter/submit
- Test: db-actions test asserting the semantic arm (`recallSearch`) is NOT invoked when `includeSemantic=false`

**Interfaces:**
- Consumes: Task 1's trigram indexes (keyword arm is now index-backed — no query shape change needed, just confirm it hits the index).
- Produces: `searchUserChats(userId, query, { includeSemantic })`.

- [ ] **Step 1: Failing test** — with `includeSemantic:false`, `searchUserChatsHybrid` runs only the keyword arm and does not call the embedding/recall path (spy/mocked `recallSearch` not called); with `true` it does.
- [ ] **Step 2:** Thread `includeSemantic` through `searchUserChatsHybrid`/`searchUserChats`; when false, skip the `recallSearch` arm entirely and return keyword results only.
- [ ] **Step 3:** `app/api/chats/search/route.ts` reads `?semantic=1`; `searchChats` passes it. Default (no param) = keyword-only (fast).
- [ ] **Step 4:** `app/library/page.tsx`: the debounced as-you-type search calls without `semantic` (instant keyword); pressing Enter (or a submit affordance) re-issues with `semantic=1` to blend in recall. Preserve current result rendering.
- [ ] **Step 5:** Tests green; commit `perf(history): gate semantic chat search to submit; keyword stays instant`.

---

### Task 4: `getRecentChats` + sidebar Recent list + collapse

**Files:**
- Modify: `lib/db/actions.ts` (add `getRecentChats`), `lib/actions/chat.ts` (wrapper)
- Modify: `components/app-sidebar.tsx` (add the Recent section + count footer; keep the icon-rail collapsed state)
- Reuse/adapt: `components/sidebar/chat-menu-item.tsx` (row), optionally salvage bits of `chat-history-section.tsx`; do NOT mount the infinite-scroll `chat-history-client.tsx`
- Reference: `components/ui/sidebar.tsx` (collapse state, `useSidebar`), the `current-chat-deleted` CustomEvent pattern (in `components/chat.tsx`)
- Test: a render test for the Recent section (renders rows; empty state; collapsed hides the list)

**Interfaces:**
- Consumes: `countUserChats` (Task 2) for the footer count.
- Produces: `getRecentChats(userId, limit=10): Promise<{ id: string; title: string; lastViewedAt: Date | null }[]>` (slim select, ordered by `lastViewedAt DESC NULLS LAST, createdAt DESC`, inside `withRLS`, reusing `chats_user_id_last_viewed_at_idx`).

- [ ] **Step 1: Failing test** — `getRecentChats` returns ≤ limit rows, newest-first, RLS-scoped, selecting only id/title/lastViewedAt.
- [ ] **Step 2:** Implement `getRecentChats`; expose via `lib/actions/chat.ts`.
- [ ] **Step 3:** In `app-sidebar.tsx`, when the sidebar is expanded render: New chat, a **Recent** section (date-grouped Today/Yesterday/Previous using `lastViewedAt`/`createdAt`), a **See all →** link to `/library`, the existing nav, and the real count (from Task 2) in the footer. When collapsed, render today's icon rail only (the shadcn `collapsible` state already drives width; ensure the Recent list is hidden when collapsed).
- [ ] **Step 4:** Live-refresh the Recent list on new chat / delete / rename — listen for the existing `current-chat-deleted` event and `router.refresh()` (or re-fetch); ensure a newly created chat appears. Reuse `chat-menu-item.tsx` for each row (active-state highlight for the current chat).
- [ ] **Step 5:** Mobile: the Sheet drawer shows the same expanded content. Verify no layout regression to the chat area at the widened expanded width (~260px) vs 80px collapsed.
- [ ] **Step 6:** Render test green; `bun typecheck`/`lint`/`format` clean; commit `feat(history): recent chats in a collapsible sidebar`.

---

### Task 5: Lab rebuild + manual verification + measurement

**Files:** none (verification).

- [ ] **Step 1:** Rebuild the lab: `docker compose -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml up -d --build ask` (run the migration first via `bun migrate` if the container doesn't run it on boot — confirm).
- [ ] **Step 2:** Browser (`:3742`): sidebar shows Recent chats; collapses to the icon rail and the state persists across reloads; a new chat and a delete both reflect in Recent; the footer + Library header show the **real count**.
- [ ] **Step 3:** Search: typing is instant (keyword) and finds a phrase inside a message body; pressing Enter blends in semantic recall. `EXPLAIN ANALYZE` confirms the trigram index scan; record before/after latency.
- [ ] **Step 4:** Fail-open: stop the reranker/embedder and confirm search still returns keyword hits and the page doesn't error.
- [ ] **Step 5:** Report the verification + measurements. (Port to staging/prod is a separate, user-approved step — NOT in this plan.)
