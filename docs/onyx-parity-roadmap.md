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
- [x] **4. Deep Research** — A/B-TESTED → **KEEP SINGLE-AGENT** (multi-agent shelved as a lab experiment, never shipped). Built the full multi-agent stack (lab, `lib/agents/deep-research/`): planner → parallel sub-agents (`balanced`) → citation-merging synthesizer, plus a blind-judge A/B harness (`scripts/eval/deep-research-ab/`). Clean n=3 A/B: today's **single-agent `quality`** deep research beat multi-agent on depth/coverage/specificity/citation (5.0/5.0/5.0/4.3 vs 4.0/4.3/4.0/3.7) — single gathers 3–10× more sources (80–126 vs 10–33) and turns that into more depth. Decomposition-at-comparable-budget + a compressive synthesis step *lost* depth. Consistent with Ask already being ahead of Onyx on retrieval. Not adopted; experiment code + A/B harness REMOVED from the lab (nothing adopted → lab reverted to match prod/staging), preserved in git tag `onyx-parity-experiment`. *Onyx: `deep_research/dr_loop.py`, `dr_mock_tools.py`.*
- [x] **(web search) Pre-crawl snippet gate** — INVESTIGATED (H1) → **KEEP OFF** (Ask's own dormant feature; not an Onyx adoption). Shadow-measured on lab (5 quality-mode turns, 80 returned sources): at the built-in `TOP_N=40` the gate would drop **~11% of cited sources** (35% on the worst spec-comparison query) to save 21% of crawls; no `TOP_N` gives both real savings and ~0% loss (safe ≈52 saves only ~6%). The two-stage design's value is real — the post-crawl full-content rerank rescues sources the snippet ranking buries. Current prod config (`off`) validated. Latency wins live elsewhere (crawl tail-latency; query-centered truncation = H2). *Onyx has no web-path reranker.*
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
- 2026-08-04: Deep Research A/B run on lab (flaresolverr repointed to host for in-process
  runs). Two harness fairness bugs found + fixed before trusting any verdict: (1) collector
  glued inter-step narration into the answer — now collects the final answer (text after the
  last tool call, citations preserved); (2) judge 12k cap truncated long single-agent reports
  — raised to 32k. Clean n=3: single-agent wins 3/3 on every dimension. DECISION: keep
  single-agent, shelve multi-agent (lab experiment, unshipped). Pivoting to web-search focus.
- 2026-08-05: Web-search H1 (pre-crawl snippet gate) validated in shadow on lab — gate flipped
  to `shadow` (behavior-neutral) via container env, 5 quality-mode turns driven through the
  browser, `returned_ranks` telemetry analysed, lab restored to `off`. Result: enabling it
  trades quality for latency (~11% cited-source loss at `TOP_N=40`); KEEP OFF, current prod
  config validated. No code change (runtime flip only, reverted).
- 2026-08-05: Nothing from the Onyx-parity program was adopted (Deep Research and the snippet
  gate both concluded "don't ship"). Reverted the lab to match prod/staging: removed the
  deep-research experiment code + A/B harness, deleted eval result artifacts (gitignored).
  Experiment preserved in git tag `onyx-parity-experiment`; findings retained in this roadmap
  + memory. Lab now carries only this roadmap doc over the prod/staging baseline.
- 2026-08-07..08: H2 (per-page crop). Crop-position shadow instrument built (v1 read-scoped,
  v2 citation-scoped) + a lab crop A/B: 20k recovers ~22% of sources' best content (shadow
  tail-loss ~0.45→~0.2) with no visible TTFT hit. Shipped 20k + shadow to prod+staging behind
  env flags for a real-traffic read (`crop-20k-shadow-live` memory). Crop-position finding: the
  crop touches only the ONE advanced (deep-crawled) search/turn; answers cite broadly across
  uncropped basic searches, so its answer-impact is bounded.
- 2026-08-08: Re-surveyed vs a refreshed clone (ff47db7 → 5200dad, thru 08-07; tag
  v4.5.0-cloud.5; 46 commits, 20 feat). **Almost all new work is OUT of scope:** enterprise
  usage/spending-limits/analytics/log-export admin, connectors (sharepoint, web-connector),
  the DESKTOP app (summon shortcuts), and the Opal design system. **The one net-new capability
  is "Craft"** — Onyx's new "AI coworker": an agentic K8s-isolated sandbox (OpenCode runtime)
  that executes code / builds webapps / produces durable artifacts, with permissioned retrieval,
  secret injection, and action-approval gating. It's the UNION of already-tracked Code Execution
  (#8) + Artifacts (#7), scaled up and enterprise-wrapped — not a new small gap. In-scope gap
  list unchanged; the mobile "force-a-tool + per-agent enable/disable" commit reinforces Custom
  Agents (#5) as a real Onyx feature.
