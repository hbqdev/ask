# History & Library Overhaul — Slice 1

- **Date:** 2026-08-16
- **Status:** Design approved in chat ("looks good"); lab-first on `flow-design`.
- **Env:** Build + measure on the lab (`ask-flow`, `:3742`). Port to staging (`admin-feature`) then prod (`dev`) — WITH the DB migration — only after the user approves the lab result.

## 1. Goal

Overhaul chat history so that: (a) recent chats appear in a **collapsible left sidebar** (quick jump), with the full `/library` grid retained for deep management; (b) the history count shows the **real total** ("142 chats") instead of the meaningless "30+"; (c) **text search is fast** — indexed keyword search over titles + message content, with semantic recall kept but no longer fired on every keystroke.

## 2. Current state (from codebase map)

- **Sidebar:** `components/app-sidebar.tsx` mounted in `app/layout.tsx:86` inside a shadcn `SidebarProvider`. It is an **80px icon rail** — logo, New-chat `+`, three nav tiles (Home/Discover/Library), account footer. **No chats render.** Collapse/expand already exists (shadcn `sidebar_state` cookie + keyboard shortcut + mobile Sheet). A full chat-in-sidebar implementation exists but is **orphaned/dead** (`components/sidebar/chat-history-section.tsx`, `chat-history-client.tsx`, `chat-menu-item.tsx`, …) — imported by nothing.
- **Library page:** `app/library/page.tsx` (client) → `/api/chats?offset&limit=30` → `getChatsPage` (`lib/db/actions.ts:424`). Offset pagination, page size 30, infinite scroll.
- **"30+":** `app/library/page.tsx:390-396` renders `chats.length` + `'+'` whenever `nextOffset !== null`; `nextOffset = results.length === limit ? offset+limit : null` (`lib/db/actions.ts:440`). **No `COUNT(*)` of chats exists.**
- **Search:** `/api/chats/search` → `searchUserChatsHybrid` (`lib/db/actions.ts:793`). Keyword arm `searchUserChatsKeyword` (`:718`) runs `ILIKE '%q%'` over **unindexed `parts.text_text`** across a 3-table join + DISTINCT ON (seq scan scaling with message volume). Semantic arm (`recallSearch`: embed + pgvector + rerank) fires **in parallel on every debounced keystroke** (300ms).
- **DB facts (lab):** superuser role `morphic` (migrations), app runtime role `app_user` (non-super, RLS). `pg_trgm` **available, not installed**; `vector` installed. All list/search/count queries run inside `withRLS(userId, …)` (`lib/db/with-rls.ts`).

## 3. Design

### 3a. Sidebar — Recent list + collapse
- **Expanded (~260px):** logo · **New chat** · **Recent** section (most-recent ~10 chats, date-grouped Today/Yesterday/Previous) · **See all →** (`/library`) · Home/Discover/Library nav · real chat count in footer.
- **Collapsed:** today's 80px icon rail (unchanged). Toggle via the existing shadcn collapse (cookie-persisted). Mobile keeps the Sheet drawer with the expanded content.
- **Data:** slim RLS-aware `getRecentChats(userId, limit=10)` — `id`, `title`, `lastViewedAt` only (reuse the `chats_user_id_last_viewed_at_idx`). Live-refresh on chat create/rename/delete (reuse the existing `current-chat-deleted` CustomEvent pattern + router refresh).
- Reuse `chat-menu-item.tsx` row rendering from the orphaned set; do NOT revive its infinite-scroll client (that's the `/library` job).

### 3b. Real count
- New RLS-aware `countUserChats(userId): Promise<number>` → `select count(*) from chats where user_id = …` inside `withRLS` (indexed on `user_id`). Exposed via the chats action/API. Rendered as the true total in the Library header AND the sidebar footer; the `chats.length + '+'` heuristic is removed.

### 3c. Fast search (keyword indexed + semantic gated)
- **Migration:** `CREATE EXTENSION IF NOT EXISTS pg_trgm` (runs as superuser `morphic`, same path pgvector took) + GIN trigram indexes: `chats.title gin_trgm_ops` and `parts.text_text gin_trgm_ops`. Trigram preserves the current substring `ILIKE '%q%'` semantics (no change to *what* matches) while making it index-backed. Verify the extension + index build on the lab; app role `app_user` only reads the index (no privilege issue).
- **Keyword arm:** unchanged query shape, now index-backed → runs per keystroke, fast.
- **Semantic arm:** KEPT but GATED — only fires on explicit submit (Enter) or a longer query after a pause, never on every debounced keystroke. Client passes an intent flag (e.g. `?semantic=1` on submit) or the server splits into a fast keyword endpoint (per keystroke) + a semantic blend (on submit). Prefer the smaller change.
- Count, indexes, and both arms stay inside `withRLS`.

## 4. Non-goals (Slice 2+)
- No full `/library` grid redesign (kept as the deep manager). No offset→cursor pagination change. No cross-device state sync changes. No FTS/`tsvector` (trigram chosen to preserve substring semantics). No pinned/favorite chats, no bulk-select in the sidebar.

## 5. Testing
- Unit: `countUserChats` (RLS scoping), `getRecentChats` (limit + order), the search gating (semantic not called on keystroke, called on submit).
- Migration: applies cleanly (extension + both GIN indexes); `EXPLAIN ANALYZE` on the keyword search shows an index/bitmap scan (not seq scan) — measure before/after latency on the lab.
- Manual (lab `:3742`): sidebar Recent list renders, collapses to the icon rail (persisted), updates on new/delete; Library header + sidebar show the real count; search is instant while typing, semantic blends on Enter. Kill the reranker to confirm search still returns keyword results (fail-open).

## 6. Rollout
Lab-first (`flow-design`, `:3742`). Port to staging + prod (with the migration run on each DB) only after the user approves the lab result.
