# Chat with Docs & URLs — Slice 1 (Grounding + Citations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attached documents and pasted URLs become both grounded and **citable** — the answer cites `[n]` anchors that resolve to source cards showing the exact excerpt + filename/URL, exactly like search/fetch citations.

**Architecture:** Auto-retrieved doc/URL chunks are surfaced as a synthetic `tool-documentRetrieval` result (shaped like a fetch result: `{ results: [{title,url,content}], … }`), so the entire citation stack (`citationMaps`, `processCitations`, `auditCitations`, `CitationLink`, `SearchResults`) is reused with a one-line whitelist add. Retrieval lifts from the user-message text transform into the streaming assembly so the synthetic result is both persisted as a UI part and made citable by the model. Pasted URLs are auto-fetched + chunked and ride the same path.

**Tech Stack:** Next.js 16, Vercel AI SDK v5, the existing `upload-rag` (chunk/embed/rerank) + `fetch` tool + `citation.ts` machinery, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-chat-with-docs-urls-grounding-citations-design.md`

## Global Constraints

- **Lab-first on `flow-design`** (`ask-flow`). Build + verify on the anonymous lab `:3742` (upload a doc, ask, see citations — no auth barrier). Port to staging/prod later.
- **Reuse, don't reinvent** the citation stack. The synthetic part must satisfy `extractCitationMaps` (`lib/utils/citation.ts`) unchanged except the whitelist: `output.state==='complete'` is not required by the extractor, but `part.state==='output-available'`, `part.toolCallId`, and `part.output.results: {title,url,content}[]` are. Verify exact shapes against the real code before coding — line numbers here are indicative (mapped on `admin-feature`).
- **Fail-open everywhere.** Any retrieval/fetch failure yields no synthetic part for that source; the answer is never blocked (mirror `transform-file-parts.ts` + the voice `emitSpokenGist` isolation).
- **Non-goals (do NOT build):** persistent library/collections, pgvector migration, in-doc viewer, cross-document search, retrieval-budget overhaul.
- Commits: repo default author (Tin Tran). NO AI/Claude/Co-Authored-By trailer.
- Each commit passes `bun typecheck`, `bun lint`, and the touched tests.

---

### Task 1: SPIKE — prove synthetic `tool-documentRetrieval` is citable end-to-end

**Type: spike.** Output is an answer + the smallest working proof, not polished code. This resolves the one real unknown before the build: **can the model cite a retrieval it did not itself invoke, and what is the minimal way to surface the citable `toolCallId` to it?**

**Files (read first):** `lib/streaming/create-chat-stream-response.ts` (the stream writer + where `transformFileParts` is called + `onFinish`), `lib/streaming/helpers/transform-file-parts.ts`, `lib/utils/citation.ts` (`CITABLE_TOOL_PART_TYPES`, `extractCitationMaps`), `lib/tools/researcher.ts` (tool registration), `lib/types/index.ts` (`SearchResultItem`, `SearchResults`), `components/tool-section.tsx`.

- [ ] **Step 1:** Determine, from the AI SDK v5 usage in this repo, the two candidate mechanisms and pick one by prototyping the cheaper one first:
  - **(A) Injected tool call+result pair** in the model input messages (an assistant `tool-call` for `documentRetrieval` + its `tool-result`, with a fixed `toolCallId`), plus the matching UI `tool-documentRetrieval` part written to the stream. Preferred — needs no new prompt grammar.
  - **(B) Prompt-declared fixed anchor:** keep the excerpts in context, and the prompt tells the model "the attached document's excerpts are citable as `[n](#<fixed-id>)`", while the UI part (fixed id) is written for the client map.
- [ ] **Step 2:** Prototype the chosen mechanism minimally on `flow-design`: for ONE attached text file, emit a synthetic `tool-documentRetrieval` UI part with 2 fabricated chunks and wire the citable id, add `'tool-documentRetrieval'` to `CITABLE_TOOL_PART_TYPES`, rebuild the lab, and drive one turn asking about the file.
- [ ] **Step 3:** Confirm in the browser: the answer contains a `[1](#…)` that survives `processCitations` (not stripped) and shows a source popover. Capture whether the model reliably cites the doc.
- [ ] **Step 4 (report):** In the task report, state the CHOSEN mechanism (A or B), the exact code shape that made the model cite (the tool-part object, the model-input injection or prompt clause), the precise files/functions the build must touch, and any deviation from this plan's later tasks. **This report parameterizes Tasks 5–6.** Label the prototype code throwaway (or keep it as the seed for Task 5 if clean).

---

### Task 2: Whitelist `tool-documentRetrieval` as citable

**Files:** Modify `lib/utils/citation.ts`; Test `lib/utils/__tests__/citation-*.test.ts` (extend the nearest existing citation test).

**Interfaces:** Produces: a citable tool part type `'tool-documentRetrieval'` recognized by `extractCitationMaps` + `auditCitations`.

- [ ] **Step 1: Write the failing test** — a message with a `tool-documentRetrieval` part (`state:'output-available'`, `toolCallId:'doc-1'`, `output.results:[{title:'f.pdf',url:'/uploads/x',content:'excerpt'}]`) yields `citationMaps['doc-1'][1]` via `extractCitationMaps`, and `processCitations('see [1](#doc-1)', maps)` keeps the citation (not stripped).
- [ ] **Step 2:** Run it, confirm it fails (type not whitelisted → no map → citation stripped).
- [ ] **Step 3:** Add `'tool-documentRetrieval'` to `CITABLE_TOOL_PART_TYPES` (the single Set at ~`citation.ts:127`). Change nothing else — `extractCitationMaps`, `processCitations`, `auditCitations` all key off that set.
- [ ] **Step 4:** Run it, confirm pass.
- [ ] **Step 5: Commit** — `feat(docs): make tool-documentRetrieval citations resolvable`.

---

### Task 3: `buildDocumentRetrievalPart` — shape ranked chunks into a citable tool part

**Files:** Create `lib/streaming/helpers/document-retrieval-part.ts`; Test alongside.

**Interfaces:**
- Consumes: ranked chunk strings + attachment metadata.
- Produces: `buildDocumentRetrievalPart(input: { sourceId: string; title: string; url: string; chunks: string[]; query?: string }): DocumentRetrievalPart` where the returned object matches the citable tool-part shape from Task 1's report (default: `{ type:'tool-documentRetrieval', state:'output-available', toolCallId: sourceId, output: { state:'complete', query: query ?? '', images: [], results: chunks.map(c => ({ title, url, content: c })) } }`).

- [ ] **Step 1: Write the failing test** — asserts the returned part has `type`, `state:'output-available'`, `toolCallId===sourceId`, and `output.results` is one `{title,url,content}` per chunk in order; empty `chunks` → returns `null` (nothing to cite).
- [ ] **Step 2:** Run, confirm fail.
- [ ] **Step 3:** Implement the pure shaping function (no I/O). Stable `sourceId` scheme: `doc-<fileId>` for files, `url-<sha1(url).slice(0,12)>` for URLs (helper `documentSourceId(kind, key)`).
- [ ] **Step 4:** Run, confirm pass.
- [ ] **Step 5: Commit** — `feat(docs): document-retrieval tool-part builder`.

---

### Task 4: URL fetch + chunk path (ephemeral, per-chat)

**Files:** Create `lib/embeddings/url-rag.ts` (fetch → extract → chunk → embed → retrieve, reusing `upload-rag` helpers + the `fetch` tool's extraction); Test alongside (mock the fetcher + `embedTexts`).

**Interfaces:**
- Produces: `retrieveUrlChunks(url: string, query: string, topK?: number): Promise<{ chunks: string[]; title: string } | null>` — fetches the URL's readable content (reuse `fetchTool`'s extraction chain or its underlying extractor — verify the exposed function in `lib/tools/fetch.ts`), splits with the same `splitText(…, 512, 128)` as `upload-rag`, embeds, cosine + cross-encoder rerank (reuse `queryFileChunks`'s ranking logic — factor the shared ranking out of `upload-rag.ts` if needed rather than duplicating), returns the top-K chunk texts + a page title. `null` on fetch failure (fail-open).

- [ ] **Step 1: Write the failing test** — mock the fetch/extract to return known text + mock `embedTexts`/reranker; assert `retrieveUrlChunks` returns the top-K ordered chunks; a fetch that throws returns `null` (no throw).
- [ ] **Step 2:** Run, confirm fail.
- [ ] **Step 3:** Implement, reusing `upload-rag`'s chunk/embed/rank (extract a shared `rankChunks(query, chunks)` helper from `queryFileChunks` if it isn't already reusable — DRY). Cache per-chat is out of scope; retrieval is per-turn (documented limitation).
- [ ] **Step 4:** Run, confirm pass.
- [ ] **Step 5: Commit** — `feat(docs): retrieveUrlChunks — fetch + chunk + rank a pasted URL`.

---

### Task 5: Wire retrieval into the streaming assembly (emit citable parts, feed the model)

**Files:** Modify `lib/streaming/create-chat-stream-response.ts` and `lib/streaming/helpers/transform-file-parts.ts` (remove/replace its text injection for attached docs); possibly `lib/streaming/helpers/convert-data-part.ts` (the `data-sourceUrl` trigger).

**Interfaces:** Consumes Task 3's `buildDocumentRetrievalPart`, Task 4's `retrieveUrlChunks`, and Task 1's chosen model-input mechanism.

**This task follows Task 1's report for the model-input mechanism.** The default (mechanism A) below is written against the injected-pair approach; adjust per the spike.

- [ ] **Step 1:** For each user-message `file` part with a ready chunk store, retrieve chunks (`queryFileChunks(localPath, query, 10)` — already computed in `transform-file-parts.ts`; lift or share it), and for each `data-sourceUrl` part, `retrieveUrlChunks(url, query, 10)`.
- [ ] **Step 2:** For each non-empty result, `buildDocumentRetrievalPart(...)` and (a) `writer.write(part)` onto the assistant stream (so the client's `extractCitationMaps` sees it — mirror the existing `writer.write` used for other parts / the voice emit), and (b) surface it to the model input per Task 1 (injected tool call+result pair with the same `toolCallId`).
- [ ] **Step 3:** Remove the now-redundant plain-text excerpt injection for attached docs in `transform-file-parts.ts` (the excerpts now live in the tool result the model reads). Keep the image/vision path and the pending/failed/expired status notes untouched. Keep everything wrapped so a failure logs + skips (fail-open) and never affects the answer.
- [ ] **Step 4:** Verify with `bun typecheck` + `bun lint`. (Behavior is covered by the Task 8 lab pass + the unit tests of Tasks 2–4; a full stream integration test is optional and only if a harness exists.)
- [ ] **Step 5: Commit** — `feat(docs): retrieve + emit citable document/URL sources in the stream`.

---

### Task 6: Prompt — name document retrieval as a citable source

**Files:** Modify `lib/agents/prompts/search-mode-prompts.ts` (the citation-integrity clause, ~`:139`/`:261`).

- [ ] **Step 1:** Extend the existing rule ("cite ONLY the toolCallId of a `search` or `fetch` call…") to also name the `documentRetrieval` result as citable — same `[n](#toolCallId)` grammar, no new syntax. Match Task 1's mechanism (if mechanism B, state the fixed-anchor instruction instead).
- [ ] **Step 2:** `bun typecheck` + `bun lint` (prompt strings only).
- [ ] **Step 3: Commit** — `feat(docs): teach the model that attached docs/URLs are citable`.

---

### Task 7: Render `tool-documentRetrieval` as a Sources card

**Files:** Modify `components/tool-section.tsx` (the tool-part dispatch, ~`:72-96`); reuse `SearchResults`.

- [ ] **Step 1:** Add a `case 'tool-documentRetrieval'` that renders the `output.results` through `SearchResults` (the same "Sources" grid search uses), so the collapsed sources list shows the doc/URL cards. The inline citation popover already works from Task 2 (no card component needed for it).
- [ ] **Step 2:** `bun typecheck` + `bun lint`; if a light render test fits the existing `tool-section`/`search-results` test pattern, add one asserting a `tool-documentRetrieval` part renders its results.
- [ ] **Step 3: Commit** — `feat(docs): show a Sources card for retrieved documents/URLs`.

---

### Task 8: Lab rebuild + manual verification

**Files:** none (build + browser on the anonymous lab `:3742`).

- [ ] **Step 1:** Rebuild the lab app: `docker compose -f docker-compose.yaml -f docker-compose.lab.yaml -f docker-compose.vpn.lab.yaml up -d --build ask` (from `ask-flow`).
- [ ] **Step 2:** Upload a small PDF/text file, ask a question answerable from it → the answer cites `[n]`, the citation popover shows the excerpt + filename, and a "Sources" card lists the doc.
- [ ] **Step 3:** Paste a URL (as the sole composer input → the chip), ask about it → the answer cites the page with the real URL/favicon in the source card.
- [ ] **Step 4:** Fail-open check: stop the reranker or embedder mid-test → the answer still returns (uncited for that source), no crash.
- [ ] **Step 5:** No commit; record in the report the observed citation behavior + any follow-ups (e.g. model citation reliability, the known re-inject-all-attachments context bloat).

## Self-Review

- **Spec coverage:** grounding+citations for docs (T2,3,5,6,7) + URLs (T4,5) + the citable mechanism (T1) + reuse of the citation stack (T2,7) + fail-open (T4,5) + lab verify (T8). Non-goals (library/pgvector/viewer/cross-doc/budget) excluded. ✓
- **Placeholders:** T1 is a deliberate spike (its report parameterizes T5/T6) — not a placeholder; every other task has concrete files, shapes, and test intent. The one conditional ("mechanism A vs B") is resolved by T1 before T5 runs. ✓
- **Type consistency:** `buildDocumentRetrievalPart` (T3) shape consumed by T5; `tool-documentRetrieval` whitelisted (T2) → rendered (T7) → prompted (T6); `retrieveUrlChunks` (T4) consumed by T5. `documentSourceId` scheme shared T3/T5. ✓
