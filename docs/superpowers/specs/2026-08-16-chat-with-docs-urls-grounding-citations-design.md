# Chat with Your Docs & URLs — Slice 1: Grounding + Citations

- **Date:** 2026-08-16
- **Status:** Design approved (approach); pending written-spec review
- **Branch / env:** Lab-first on `flow-design` (`ask-flow`, lab `:3742`, anonymous — browser-testable without the prod auth barrier). Ported to staging (`admin-feature`) then prod (`dev`) after it works, via the normal cherry-pick flow.

## 1. Goal

When a user **attaches a document** or **pastes a URL** and asks about it, the answer must be **grounded** in that source's content (already true for files) **and cite back into it** — an inline `[n]` citation that resolves to a source card showing the exact excerpt and the file name / URL, exactly like a search/fetch citation. So: *drop in a PDF or a link, ask, and the answer cites the passage it used.*

## 2. What already exists (reuse as-is)

- **Per-document RAG for uploads.** On upload, files are extracted → chunked (512/128) → embedded → and at answer time `transformFileParts` re-retrieves the top chunks (cosine + cross-encoder rerank) and injects them. Chunks live in on-disk `.chunks.json` sidecars. (`lib/embeddings/upload-rag.ts`, `lib/streaming/helpers/transform-file-parts.ts`, wired at `create-chat-stream-response.ts`.)
- **The whole citation stack.** The model cites `[n](#toolCallId)`; the client builds `citationMaps: Record<toolCallId, Record<number, SearchResultItem>>` from `tool-search`/`tool-fetch` output parts (`extractCitationMaps`, `lib/utils/citation.ts`), validates/rewrites anchors (`processCitations`), and renders inline citation popovers (`CitationLink`) + a "Sources" grid (`SearchResults`). A whitelist `CITABLE_TOOL_PART_TYPES = {'tool-search','tool-fetch'}` (`citation.ts:127`) gates which parts are citable; the same set drives the `auditCitations` telemetry, so they never diverge.
- **Robust per-turn URL fetch.** A pasted URL rides in as a `data-sourceUrl` part; the model may call the `fetch` tool (plain → Crawl4AI → FlareSolverr → Jina/Tavily → Firecrawl, + YouTube/PDF branches), which returns a `SearchResults` object (already citable). (`lib/tools/fetch.ts`.)
- **Shared embedder + reranker** services (remote GPU + local fallback), already used by both search and doc chunks.

**The one gap:** auto-retrieved doc chunks enter as a plain **text part on the user message** (`transform-file-parts.ts:196-205`) — never a tool part, never in `citationMaps` — so they are grounded but **not citable**. Pasted URLs are citable only if the model happens to `fetch` them, and their content is stuffed per-turn (up to 50k chars) rather than semantically retrieved.

## 3. Non-goals (YAGNI — later slices)

- No persistent **document library / collections / "chat with this doc"** — Slice 1 keeps the existing **per-chat attachment** model on its TTL.
- No **pgvector migration** for doc chunks — keep the `.chunks.json` sidecar store; retrieval is unchanged.
- No **in-document viewer / page jumps** — a citation shows the excerpt card, not a rendered PDF location.
- No **cross-document search** ("search across my library").
- No **retrieval-budget overhaul** — see §7 (known limitation): all prior attachments still re-retrieve each turn.

## 4. Architecture — synthetic citable retrieval (Approach A)

Reuse the tool-result shape so the citation machinery is untouched. Instead of appending retrieved chunks as text to the user message, surface them as a **synthetic `tool-documentRetrieval` result** the system performed on the user's behalf:

```
{ type: 'tool-documentRetrieval', state: 'output-available', toolCallId: <stable id>,
  output: { state: 'complete', query, images: [],
            results: [ { title: <filename or page title>, url: <doc/URL ref>, content: <chunk excerpt> }, … ] } }
```

Two facts make this work:
1. `SearchResultItem` is just `{ title, url, content }` — a doc chunk (`title=filename`, `url=/uploads/<objectKey>` or the pasted URL, `content=excerpt`) slots in with no schema change.
2. Adding `'tool-documentRetrieval'` to `CITABLE_TOOL_PART_TYPES` (one line) makes `extractCitationMaps`, `processCitations`, `auditCitations`, and the inline `CitationLink` popover all treat it identically to a search/fetch source — the anchor stays an ordinary `[n](#toolCallId)`.

**The one real cost:** the model can only cite a `toolCallId` it can see. Since it didn't call the tool, the retrieval must be surfaced to the model as a tool call/result it "made", carrying a stable `toolCallId`, **before** generation — and the matching UI part must be persisted on the assistant message so the client builds the citation map. So retrieval lifts from a user-message text transform into the streaming assembly, which both (a) writes the UI `tool-documentRetrieval` part and (b) puts the corresponding tool call/result into the model input. (Implementation note: whether this is done as an injected assistant tool-call+result pair in the model messages, or by declaring the fixed anchor to the model in the prompt while persisting the UI part, is settled in the plan by a short spike — both reach the same citable end state; the injected-pair form is preferred as it needs no new prompt grammar.)

**URLs ride the identical path.** A pasted `data-sourceUrl` chip triggers an **auto-fetch** (reusing `fetchTool`'s extraction chain) → chunk + embed (reuse the doc pipeline) → retrieve top chunks → emit the **same** synthetic `tool-documentRetrieval` part (with the real URL as `url`, so the favicon + `SearchResults`/`FetchSection` card come for free). No separate citation path.

## 5. Components (each isolated, testable)

| Unit | Responsibility | Depends on |
|---|---|---|
| **Doc/URL retrieval step** (new, in `lib/streaming` — lifted out of `transform-file-parts`) | For each attached doc + pasted-URL chip, produce ranked chunks and shape a `tool-documentRetrieval` result (stable `toolCallId` per attachment) | `queryFileChunks` (docs), a new URL fetch+chunk path (URLs) |
| **Model-input + UI-part emit** (in `create-chat-stream-response.ts`) | Inject the synthetic retrieval into the model messages (citable id) and persist the matching UI tool part | AI SDK message assembly |
| **Citation whitelist** (`lib/utils/citation.ts`) | Add `'tool-documentRetrieval'` to `CITABLE_TOOL_PART_TYPES` (1 line) | — |
| **Prompt** (`lib/agents/prompts/search-mode-prompts.ts`) | Name the document-retrieval result as a citable source alongside search/fetch | — |
| **Card rendering** (`components/tool-section.tsx`) | Route `tool-documentRetrieval` to the `SearchResults` "Sources" grid (one `case`) | existing `SearchResults` |
| **URL ingestion** (new path; `convert-data-part.ts` trigger + fetch/chunk reuse) | Fetch a pasted URL, chunk + embed it (ephemeral, per-chat), feed the retrieval step | `fetchTool`, `upload-rag` chunk/embed |

`transform-file-parts.ts`'s text-injection for attached docs is **replaced** by the retrieval step's tool-part emission (the model still receives the excerpts — now inside the tool result, which is where a cited source belongs).

## 6. Data flow (one turn)

1. User attaches `report.pdf` + pastes `https://site/x`, asks "what does it say about Y?".
2. Server, before generation: retrieve `report.pdf` top chunks (`queryFileChunks`); auto-fetch + chunk + retrieve `site/x` top chunks.
3. Emit two synthetic `tool-documentRetrieval` results (stable ids `doc-<fileId>`, `url-<hash>`), each with `results: [{title,url,content}]` — persisted as UI parts **and** placed in the model input.
4. Model answers grounded in those results and cites `[1](#doc-<fileId>)`, `[2](#url-<hash>)`.
5. Client: `extractCitationMaps` picks up the two tool parts (now whitelisted) → `processCitations` resolves the anchors → inline citation popovers + a "Sources" card list show the filename/URL + excerpt.

## 7. Error handling / fail-open (Ask's signature)

- **Retrieval or fetch fails / empty** → no synthetic part for that source (or a short status note as today); the answer is unaffected, just uncited for that source. Never throws into the answer path (mirrors the current `transform-file-parts` fail-open + the voice `emitSpokenGist` isolation).
- **URL fetch fails** (paywall, JS wall exhausts the rescue chain) → fall back to today's behavior (the model may still `fetch` per-turn) or a "couldn't read that page" note. No hard failure.
- **Pending/processing/failed/expired** attachments keep their existing status notes.
- **Known limitation (documented, not fixed here):** every prior attachment re-retrieves each turn (`transform-file-parts` re-runs over history), so a chat with many attachments bloats context and the Sources list. Slice 1 preserves today's behavior; a shared retrieval budget + relevance gating is a fast-follow.

## 8. Testing

- **Unit:** the retrieval-step shaping (chunks → a well-formed `tool-documentRetrieval` result with a stable id); the URL fetch+chunk path (mocked fetch); the `CITABLE_TOOL_PART_TYPES` addition (a `tool-documentRetrieval` part yields a citation map via `extractCitationMaps`, and `processCitations` resolves `[n](#id)` against it).
- **Integration:** a turn with an attached doc → assert a citable `tool-documentRetrieval` part is emitted with the ranked excerpts, and a model answer citing `[1](#doc-…)` renders a resolvable citation (no strip).
- **Lab manual (anonymous `:3742`):** upload a PDF + paste a URL, ask a grounded question, confirm the answer cites both with source cards showing the right excerpts; kill the reranker/embedder to confirm fail-open.

## 9. Slices (ship order)

- **Slice 1 (this doc):** attached docs + pasted URLs are grounded **and citable**, per-chat, reusing the citation stack. *Drop in a doc/URL, ask, see cited excerpts.*
- **Slice 2 (later):** persistent **document library / collections** ("chat with this doc" over time), doc chunks in **pgvector** (cross-document retrieval), smarter shared retrieval budget.
