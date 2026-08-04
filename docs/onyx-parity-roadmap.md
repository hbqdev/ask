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
- [ ] **1. Retrieval upgrade** — chunk crawled pages before rerank; two-phase (snippet search → LLM picks URLs to deep-fetch); score fusion (min-max normalize + alpha, RRF across expanded queries); query expansion; two-stage section assembly. *Onyx: `onyx/indexing/chunker.py`, `tools/tool_implementations/{web_search,open_url}`, `document_index/opensearch/search.py`, `context/search/pipeline.py`.*
- [ ] **2. Answer/prompt layer** — prompt-placement discipline (citation reminder at tail, single-int source ids, in-section tool instructions); streaming citation processor; kwarg retry ladder for weak Ollama models. *Onyx: `chat/COMPRESSION.md`, `chat/citation_processor.py`, `llm/multi_llm.py`.*
- [ ] **3. Frontend polish** — hide citations until source resolves; streaming-hardened markdown (defer highlighting, escape partial LaTeX/fences); resumable streams via cursor; scroll-follow only breaks on scroll-up. *Onyx: `web/src/app/app/message/MemoizedTextComponents.tsx`, `MessageTextRenderer.tsx`, `lib.tsx::resumeStream`, `ChatScrollContainer.tsx`.*

### Wave 2 — new capabilities that fit the stack
- [ ] **4. Deep Research** — fake-tools orchestration (`research_agent`/`think_tool`/`generate_report`) on the AI SDK + citation renumbering. *Onyx: `deep_research/dr_loop.py`, `dr_mock_tools.py`.*
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
- 2026-08-04: roadmap approved (no connectors). Starting Wave 1 #1 (retrieval) in lab.
