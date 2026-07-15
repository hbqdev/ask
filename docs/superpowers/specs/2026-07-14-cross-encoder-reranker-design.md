# Cross-encoder reranker for Ask

**Date:** 2026-07-14
**Status:** Design — pending user review, then implementation plan
**Goal:** Replace Ask's bi-encoder cosine ranking of retrieved content with a
cross-encoder reranker, served on the spare Quadro P4000 box. Cross-encoders
score each (query, passage) pair *jointly* and are substantially better at
relevance ordering than comparing separately-embedded vectors — a direct,
low-risk upgrade to what the answering model reads.

## Context

- **Today's ranking is a bi-encoder.** `lib/embeddings/rerank.ts`
  (`rerankByEmbedding`) embeds the query and each passage separately with
  MiniLM and ranks by cosine similarity. It's fast but a fundamentally
  weaker method than a cross-encoder. Two call sites use bi-encoder cosine:
  1. Advanced web search — `app/api/advanced-search/route.ts` reranks
     crawled result passages (Phase 1 target).
  2. Upload-RAG — `lib/embeddings/upload-rag.ts` `queryFileChunks` ranks a
     PDF/document's pre-embedded chunks by cosine, returns top-K
     (Phase 2 target).
- **Hardware:** second server `192.168.50.160` (NightFuryS) — Quadro P4000
  8GB, driver 582.70, 20 cores, 58GB RAM, Debian 12 under WSL2. Ollama not
  installed; not needed for this.
- **Pascal constraint (verified).** The strongest rerankers (Qwen3-Reranker
  4B/8B) are *generative* and served via vLLM, which requires compute
  capability 7.0+. The P4000 is 6.1. Separately, HuggingFace TEI (the fast
  cross-encoder server) does not build for Pascal 6.1 either. **PyTorch does
  support Pascal**, so the service uses a PyTorch-based runtime
  (FlagEmbedding / sentence-transformers), not TEI or vLLM — the same
  cuda_v12-class fallback situation as Ollama on serenity.

## Model choice

`BAAI/bge-reranker-v2-m3` — 568M params, **true cross-encoder** (not
generative), Apache-2.0, ~1-2GB VRAM (trivially fits 8GB). It is about the
largest *pure* cross-encoder available; the higher-scoring v2 rerankers went
generative (Qwen-based), which is exactly what Pascal can't serve
efficiently. So this is the most capable model that actually runs well on
this GPU, not merely one that fits its VRAM. `Qwen3-Reranker-0.6B` (~+0.04
MTEB, generative) is noted as a later A/B, not built now.

## Component 1 — reranker service (on the P4000)

A small containerized Python service under `selfhosted/reranker/`:

- **Runtime:** FastAPI + FlagEmbedding `FlagReranker('BAAI/bge-reranker-v2-m3',
  use_fp16=True)` on `device=cuda` (falls back to CPU if CUDA is
  unavailable — this box has 20 cores, so CPU is acceptable, just slower).
- **Endpoint:**
  `POST /rerank  { "query": str, "passages": [str, ...] }  →  { "scores": [float, ...] }`
  Scores are the reranker's raw relevance logits, index-aligned to
  `passages`. Plus `GET /health`.
- **Auth:** a bearer token (env `RERANKER_API_TOKEN`), required on `/rerank`,
  same pattern as crawl4ai. `/health` is open.
- **Deployment:** own `docker-compose.yaml`, joined to the `shared-infra`
  docker network (same as crawl4ai/flaresolverr), **no host port
  published** — reachable only container-to-container. Model weights cached
  in a named volume (downloaded once on first start). Healthcheck, mem
  limit, `restart: unless-stopped`. GPU exposed via the WSL2 `/usr/lib/wsl`
  bridge, as on serenity.
- **Batching:** the service accepts the whole passage list in one request
  and batches internally (FlagReranker handles batch inference).

## Component 2 — Ask client

`lib/utils/cross-encoder.ts`:

- `isCrossEncoderConfigured()` → both `RERANKER_URL` and `RERANKER_API_TOKEN`
  set (gates the whole feature, like `isCrawl4aiConfigured()`).
- `crossEncoderScore(query, passages, opts?)` → `number[]` — a
  timeout-bounded POST to the service; throws on transport/auth/timeout so
  callers can fall back. Never returns partial/garbage.

## Phase 1 — web-search-result reranking

Integrate into the advanced-search rerank stage. A new
`rerankByCrossEncoder<T>(docs, query, topK)` in `lib/embeddings/rerank.ts`
mirrors `rerankByEmbedding`'s signature and return type (`RerankedDoc<T>[]`),
so `app/api/advanced-search/route.ts` is otherwise unchanged:

1. Split each doc into passages (reuse existing `splitText` +
   `MAX_PASSAGES_PER_DOC`).
2. Send all (query, passage) pairs to the reranker service in one call.
3. Each doc's score = its best passage's score; `topPassages` = its top
   passages by score.
4. Rank docs by score, return top-K.

**Fallback chain (layered, never errors a search):** cross-encoder service
→ *(down/timeout/error)* → existing `rerankByEmbedding` (bi-encoder MiniLM)
→ *(fails)* → keyword scorer. Selection: if `isCrossEncoderConfigured()`,
try cross-encoder; on throw, log and call `rerankByEmbedding`; that already
falls back to the keyword scorer. A reranker outage silently degrades to
today's behavior.

**Latency:** ~16 docs × up to 12 passages ≈ up to ~190 pairs/turn, one
batched call, expected ~1-3s on the P4000 — negligible against the crawl-
dominated 23-39s advanced turn. Timeout-bounded so a slow service can't
stall the turn.

## Phase 2 — upload-RAG reranking (text documents only)

`queryFileChunks` (`lib/embeddings/upload-rag.ts`) currently returns top-K
chunks by bi-encoder cosine. Change: retrieve a wider candidate pool by
cosine (e.g. top-30), then rerank those candidates with the cross-encoder
and return the best `topK`. Same fallback: if the service is
down/unconfigured, keep today's cosine top-K. This improves the relevance of
the document passages the answering model sees for PDF/text-document Q&A.

**Explicitly not images.** Uploaded images take a separate path
(`transform-file-parts.ts` base64-encodes them straight to the multimodal
model — no chunking, no retrieval), so a text reranker never touches them.
Scanned/image-only PDFs likewise fall to the image path. Phase 2 helps only
text-extractable documents.

## Out of scope

- **Images / scanned PDFs** — architecturally unrelated (direct multimodal,
  no retrieval to rerank). Improving those is a separate lever (stronger
  vision model / OCR).
- **Qwen3-Reranker-0.6B** — a later A/B once bge-m3 is proven.
- **Classifier context** — using retrieval/reranking to feed the classifier
  relevant history belongs to the parked Couchbase memory feature, not here.
- **Replacing the embedding models** — MiniLM/mxbai stay for embedding
  (upload-RAG candidate retrieval, any future memory). The cross-encoder is
  a *reranking* layer on top, not a replacement.

## Error handling & testing

- Every reranker call is timeout-bounded and falls back to the existing
  bi-encoder path on any failure. Total service failure ⇒ behavior identical
  to today.
- **Unit:** `cross-encoder.ts` client against a mocked service (scores →
  ordering; throws → caught); `rerankByCrossEncoder` ordering with a stubbed
  client; fallback selection when the client throws.
- **Service:** a standalone `/rerank` smoke test (real model, a few pairs,
  asserting the on-topic passage outranks off-topic).
- **Live (staging before prod):** A/B a few real queries — cross-encoder vs
  bi-encoder ordering — and measure P4000 latency; confirm graceful fallback
  by pointing at a stopped service.

## Rollout

1. Stand up the reranker service on the P4000; verify `/rerank` + GPU use +
   latency in isolation.
2. Phase 1 (web reranking) behind `isCrossEncoderConfigured()` → staging →
   A/B + latency → production (existing merge-to-dev + rebuild flow).
3. Phase 2 (upload-RAG) → staging → production.

Each phase ships independently; the feature is inert until `RERANKER_URL`
and `RERANKER_API_TOKEN` are set, so partial rollout is safe.
