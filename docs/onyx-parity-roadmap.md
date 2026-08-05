# Ask ← Onyx parity roadmap

Goal: bring Ask to feature-parity with Onyx's user-facing capabilities, and where
features overlap, adopt Onyx's (better) implementation. **No connectors / private
knowledge index** — Ask stays a live-web engine. Every item is lab-first on
`ask-flow` (:3742), A/B'd where measurable, then ported staging→prod **only after
explicit approval**. Reference clone: `/home/nightfury/selfhosted/onyx`.

## Feature matrix (Onyx → Ask)

| Onyx feature | Ask status | Plan |
|---|---|---|
| Agentic loop (tool-loop RAG) | HAVE (`ToolLoopAgent`) | keep; upgrade retrieval inside it |
| Web search (multi-provider + crawler) | HAVE (SearXNG/degoog/crawl4ai) | adopt Onyx's two-phase + fusion + chunking |
| Image generation | HAVE (`generate-image.ts`) | minor compare |
| Reasoning | HAVE | keep |
| MCP / dynamic tools | PARTIAL (`dynamicTool`, `MCPClient`) | extend to full Actions |
| Deep Research (plan → parallel sub-agents → report) | PARTIAL (mode label only) | build real (fake-tools) |
| Custom Agents (personas) | GAP | build |
| Artifacts (downloadable docs/graphics) | GAP | build |
| Code Execution (sandbox) | GAP | build (design checkpoint first) |
| Voice (STT/TTS) | GAP | build |

## Waves (ordered by ROI + risk)

### Wave 1 — match Onyx on shared features (the "steal" list)
> **AUDITED 2026-08-04 — SKIP.** Evidence-check found Ask already implements ~90% of this,
> often better than Onyx (two-stage cross-encoder retrieval + snippet-gate; streamdown;
> `consumeStream` persistence; rigorous citation-integrity prompt). Genuine residuals are
> minor/low-value and deferred: kwarg param-degradation for weak models; live stream
> *reconnect* on reload (answer is already persisted, just not re-streamed); citation-reminder
> tail placement; a scroll-follow refinement.
- [ ] **1. Retrieval upgrade** — chunk crawled pages before rerank; two-phase (snippet search → LLM picks URLs to deep-fetch); score fusion (min-max normalize + alpha, RRF across expanded queries); query expansion; two-stage section assembly. *Onyx: `onyx/indexing/chunker.py`, `tools/tool_implementations/{web_search,open_url}`, `document_index/opensearch/search.py`, `context/search/pipeline.py`.*
- [ ] **2. Answer/prompt layer** — prompt-placement discipline (citation reminder at tail, single-int source ids, in-section tool instructions); streaming citation processor; kwarg retry ladder for weak Ollama models. *Onyx: `chat/COMPRESSION.md`, `chat/citation_processor.py`, `llm/multi_llm.py`.*
- [ ] **3. Frontend polish** — hide citations until source resolves; streaming-hardened markdown (defer highlighting, escape partial LaTeX/fences); resumable streams via cursor; scroll-follow only breaks on scroll-up. *Onyx: `web/src/app/app/message/MemoizedTextComponents.tsx`, `MessageTextRenderer.tsx`, `lib.tsx::resumeStream`, `ChatScrollContainer.tsx`.*

### Wave 2 — new capabilities that fit the stack
- [x] **4. Deep Research** — BUILT (lab, `lib/agents/deep-research/`), A/B in evaluation. Multi-agent orchestration ABOVE the researcher (flow-variants can't fan out): planner decomposes → parallel sub-agents (`balanced`, capped) → synthesizer merges each sub-agent's citations into one URL-deduped space (our `collapse_citations` analog) and composes one cited report. Baseline arm = today's single-agent `quality` mode (= Ask's deep-research protocol). A/B harness: `scripts/eval/deep-research-ab/` (blind judge, depth/coverage/specificity/citation). *Onyx: `deep_research/dr_loop.py`, `dr_mock_tools.py`.*
- [ ] **5. Custom Agents / personas** — DB-backed user-defined agents (instructions + allowed tools + optional pinned model).
- [ ] **6. Voice Mode** — STT input + TTS output (provider or local).

### Wave 3 — heavier / infra-dependent
- [ ] **7. Artifacts** — generate + render + download documents/graphics.
- [ ] **8. Code Execution** — sandbox. **Design + security checkpoint before any code.** (Onyx mounts the Docker socket — we pick a safer isolation model.)

### Wave 4 — supporting / infra hygiene
- [ ] **9a. MCP → full Actions**
- [ ] **9b. cgroup-aware sizing** — fixes crawl4ai-cgroup-blind (read `/sys/fs/cgroup`, not host RAM). *Onyx: `backend/model_server/main.py`.*
- [ ] **9c. Generated compose from one template** — kills prod/staging/lab drift. *Onyx: `deployment/docker_compose/docker-compose.template.yml`.*

## Explicitly SKIP (implementation/infra, not features — same feature cheaper on Ask's stack)
OpenSearch/Vespa index · 40 connectors + ingestion · Celery worker fleet · dedicated
model_server · schema-per-tenant multi-tenancy (keep RLS) · litellm-equivalent (AI SDK
is the abstraction) · Opal/Style-Dictionary build pipeline · MinIO/certbot ·
the 40-type packet protocol · wholesale cross-encoder replacement (keep it; add a light
"which pages to cite" LLM pass).

## Status log
- 2026-08-04: roadmap approved (no connectors).
- 2026-08-04: Wave 1 AUDITED → already implemented (~90%), often ahead of Onyx. Skipped;
  minor residuals deferred. Pivoting to Wave 2 #4 (Deep Research) — the biggest verified gap.
- 2026-08-04: Wave 2 #4 Deep Research BUILT on lab (6 slices, 35 unit tests, typecheck/lint
  clean): planner → sub-agent runner → orchestrator → synthesizer (citation-merge) → entry
  points (both A/B arms) → A/B harness. Key codebase fact: `quality` searchMode IS Ask's
  deep-research protocol (no separate 'deep-research' mode). Sub-agents run `balanced` so
  multi-agent tests decomposition at a comparable search budget, not "N× more searching".
  UI streaming behind an A/B flag deferred until the A/B shows multi-agent wins. Next: run
  the full A/B; then web-search focus (Onyx open_url vs Ask cross-encoder snippet-gate).
