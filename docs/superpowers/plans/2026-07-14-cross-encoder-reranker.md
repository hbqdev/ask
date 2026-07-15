# Cross-Encoder Reranker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Ask's bi-encoder cosine ranking of retrieved content with a `bge-reranker-v2-m3` cross-encoder served on the P4000 box, improving which passages the answering model reads for both web search (Phase 1) and uploaded text documents (Phase 2).

**Architecture:** A standalone FastAPI + FlagEmbedding service runs the reranker on the P4000 (192.168.50.160), reached by Ask over the LAN at `RERANKER_URL` with bearer-token auth. A thin Ask client (`lib/utils/cross-encoder.ts`) calls it. New `rerankByCrossEncoder` slots into the existing rerank stage with a layered fallback (cross-encoder → bi-encoder → keyword) so an outage never errors a search. The feature is inert until `RERANKER_URL` + `RERANKER_API_TOKEN` are set.

**Tech Stack:** Python 3.11, FastAPI, uvicorn, FlagEmbedding (PyTorch, CUDA on Pascal via nvidia-container-toolkit); TypeScript, Next.js, Vitest (`bun run test`).

## Global Constraints

- **Model:** `BAAI/bge-reranker-v2-m3` (Apache-2.0, true cross-encoder). Served via FlagEmbedding/PyTorch — NOT TEI or vLLM (neither supports Pascal compute 6.1).
- **Service host:** P4000 box `192.168.50.160` (NightFuryS), Quadro P4000 8GB, driver 582.70, Debian 12 / WSL2. Reached over LAN — this is a *different machine* from the Ask host, so NO shared Docker network (that is same-host only); this supersedes the spec's `shared-infra` note.
- **Score convention:** the service returns sigmoid-normalized scores in `[0,1]` (`FlagReranker.compute_score(pairs, normalize=True)`), so downstream thresholds are on the same `[0,1]` scale as today's cosine.
- **Fallback is mandatory:** every reranker call is timeout-bounded and falls back to the existing bi-encoder path on any failure. Total service failure ⇒ behavior identical to today.
- **Ask test command:** `bun run test` (Vitest), NOT `bun test`. Run from `/home/nightfury/selfhosted/ask`.
- **Deploy flow:** build/verify on staging `ask-admin-feature` (port 3739) via `docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml build ask && ... up -d ask`; production is `docker compose up -d --build` after merging `admin-feature`→`dev`. Work on branch `admin-feature`.
- **No secrets in git:** `.env` is gitignored; the reranker token/URL go in `.env` (Ask) and `selfhosted/reranker/.env` (service), never committed.

---

## File Structure

**New — reranker service (deployed to the P4000, lives in the Ask repo for versioning):**
- `selfhosted/reranker/app.py` — FastAPI service: `/health`, `/rerank`.
- `selfhosted/reranker/requirements.txt` — Python deps.
- `selfhosted/reranker/Dockerfile` — CUDA-enabled image.
- `selfhosted/reranker/docker-compose.yaml` — GPU container, LAN port, token.
- `selfhosted/reranker/.env.example` — documents `RERANKER_API_TOKEN`.
- `selfhosted/reranker/smoke_test.py` — standalone `/rerank` correctness check.

**New — Ask client + reranker function:**
- `lib/utils/cross-encoder.ts` — `isCrossEncoderConfigured()`, `crossEncoderScore()`.
- `lib/utils/__tests__/cross-encoder.test.ts` — client unit tests.
- `lib/embeddings/rerank.ts` — add `rerankByCrossEncoder()` (modify).
- `lib/embeddings/__tests__/rerank-cross-encoder.test.ts` — reranker unit tests.

**Modified — integration:**
- `app/api/advanced-search/route.ts` — Phase 1 cascade at the rerank block (lines ~333-371).
- `lib/embeddings/upload-rag.ts` — Phase 2 in `queryFileChunks` (~88-118).
- `lib/embeddings/__tests__/upload-rag-rerank.test.ts` — Phase 2 unit test.

---

## Task 1: Reranker service on the P4000

**Files:**
- Create: `selfhosted/reranker/app.py`
- Create: `selfhosted/reranker/requirements.txt`
- Create: `selfhosted/reranker/Dockerfile`
- Create: `selfhosted/reranker/docker-compose.yaml`
- Create: `selfhosted/reranker/.env.example`
- Create: `selfhosted/reranker/smoke_test.py`

**Interfaces:**
- Produces: HTTP `POST /rerank {query: string, passages: string[]} -> {scores: number[]}` (scores in `[0,1]`, index-aligned to `passages`); `GET /health -> {status, model, ready}`. Bearer-token auth on `/rerank`.

- [ ] **Step 1: Write the service**

Create `selfhosted/reranker/app.py`:

```python
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

MODEL = os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
TOKEN = os.environ.get("RERANKER_API_TOKEN", "")

_state = {"reranker": None}


@asynccontextmanager
async def lifespan(app: FastAPI):
    from FlagEmbedding import FlagReranker

    # use_fp16 halves VRAM and speeds inference; harmless on CPU fallback.
    _state["reranker"] = FlagReranker(MODEL, use_fp16=True)
    yield
    _state["reranker"] = None


app = FastAPI(lifespan=lifespan)


class RerankRequest(BaseModel):
    query: str
    passages: list[str]


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL, "ready": _state["reranker"] is not None}


@app.post("/rerank")
def rerank(req: RerankRequest, authorization: str = Header(default="")):
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    reranker = _state["reranker"]
    if reranker is None:
        raise HTTPException(status_code=503, detail="model not ready")
    if not req.passages:
        return {"scores": []}
    pairs = [[req.query, p] for p in req.passages]
    # normalize=True -> sigmoid -> scores in [0,1].
    scores = reranker.compute_score(pairs, normalize=True)
    if not isinstance(scores, list):
        scores = [scores]
    return {"scores": [float(s) for s in scores]}
```

- [ ] **Step 2: Write deps and container files**

Create `selfhosted/reranker/requirements.txt`:

```
fastapi==0.115.6
uvicorn[standard]==0.34.0
FlagEmbedding==1.3.4
```

Create `selfhosted/reranker/Dockerfile` (PyTorch CUDA base includes a torch build with Pascal sm_61 support):

```dockerfile
FROM pytorch/pytorch:2.5.1-cuda12.1-cudnn9-runtime

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

EXPOSE 8787
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8787"]
```

Create `selfhosted/reranker/docker-compose.yaml`:

```yaml
# Cross-encoder reranker (bge-reranker-v2-m3) for Ask. Runs on the P4000
# box (192.168.50.160); Ask reaches it over the LAN at
# http://192.168.50.160:8787 with a bearer token (published to the LAN, so
# unlike the same-host loopback services it is token-protected). GPU access
# requires nvidia-container-toolkit on this host.
name: reranker
services:
  reranker:
    build: .
    container_name: reranker
    env_file: .env
    environment:
      RERANKER_MODEL: BAAI/bge-reranker-v2-m3
    ports:
      - "8787:8787"
    volumes:
      # Cache the downloaded model weights across container recreation.
      - hf-cache:/root/.cache/huggingface
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/health')"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 120s
    restart: unless-stopped

volumes:
  hf-cache:
    name: reranker-hf-cache
```

Create `selfhosted/reranker/.env.example`:

```
# Generate with: openssl rand -hex 32
RERANKER_API_TOKEN=
```

- [ ] **Step 3: Write the smoke test**

Create `selfhosted/reranker/smoke_test.py`:

```python
import os
import sys
import urllib.request
import json

BASE = os.environ.get("BASE", "http://127.0.0.1:8787")
TOKEN = os.environ.get("RERANKER_API_TOKEN", "")


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


resp = post("/rerank", {
    "query": "How does photosynthesis work?",
    "passages": [
        "Photosynthesis converts sunlight, water and CO2 into glucose and oxygen in plant chloroplasts.",
        "The stock market fell three percent on Tuesday amid inflation fears.",
    ],
})
scores = resp["scores"]
print("scores:", scores)
assert len(scores) == 2, "expected 2 scores"
assert scores[0] > scores[1], "on-topic passage must outrank off-topic"
print("SMOKE TEST PASSED")
```

- [ ] **Step 4: Install nvidia-container-toolkit on the P4000, deploy, verify GPU**

Run (from the Ask host, over SSH):

```bash
SSH="ssh nightfury@192.168.50.160"
# Install nvidia-container-toolkit (not currently installed on this box).
$SSH 'curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg && curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed "s#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g" | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list && sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit && sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker'
# Verify a container can see the GPU.
$SSH 'docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L'
```

Expected: `GPU 0: Quadro P4000 (UUID: ...)`.

If GPU-in-Docker cannot be made to work, remove the `deploy.resources` block from the compose file — FlagReranker runs on CPU (20 cores on this box), slower but functional; the rest of the plan is unchanged.

- [ ] **Step 5: Copy the service to the P4000 and start it**

```bash
ssh nightfury@192.168.50.160 'mkdir -p ~/selfhosted/reranker'
scp selfhosted/reranker/{app.py,requirements.txt,Dockerfile,docker-compose.yaml,smoke_test.py} nightfury@192.168.50.160:~/selfhosted/reranker/
# Create the token on the box (not committed).
ssh nightfury@192.168.50.160 'cd ~/selfhosted/reranker && echo "RERANKER_API_TOKEN=$(openssl rand -hex 32)" > .env'
ssh nightfury@192.168.50.160 'cd ~/selfhosted/reranker && docker compose up -d --build'
```

Expected: build succeeds, container starts. First start downloads the model (~2GB) — allow a few minutes (the healthcheck `start_period` is 120s).

- [ ] **Step 6: Run the smoke test against the running service**

```bash
ssh nightfury@192.168.50.160 'cd ~/selfhosted/reranker && sleep 90 && RERANKER_API_TOKEN=$(grep RERANKER_API_TOKEN .env | cut -d= -f2) python3 smoke_test.py'
```

Expected: `scores: [<high>, <low>]` then `SMOKE TEST PASSED`. Also confirm GPU use:

```bash
ssh nightfury@192.168.50.160 '/usr/lib/wsl/lib/nvidia-smi --query-gpu=memory.used --format=csv,noheader'
```

Expected: a few hundred MB to ~2GB used (model resident on GPU).

- [ ] **Step 7: Commit**

```bash
cd /home/nightfury/selfhosted/ask
git add selfhosted/reranker
git commit -m "Add cross-encoder reranker service (bge-reranker-v2-m3) for the P4000"
```

---

## Task 2: Ask client — `lib/utils/cross-encoder.ts`

**Files:**
- Create: `lib/utils/cross-encoder.ts`
- Test: `lib/utils/__tests__/cross-encoder.test.ts`

**Interfaces:**
- Consumes: HTTP `/rerank` from Task 1.
- Produces:
  - `isCrossEncoderConfigured(): boolean`
  - `crossEncoderScore(query: string, passages: string[], opts?: { timeoutMs?: number }): Promise<number[]>` — resolves to scores index-aligned to `passages` (empty array for empty input); throws on transport/auth/timeout/HTTP error.

- [ ] **Step 1: Write the failing test**

Create `lib/utils/__tests__/cross-encoder.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { crossEncoderScore, isCrossEncoderConfigured } from '../cross-encoder'

describe('cross-encoder client', () => {
  const origUrl = process.env.RERANKER_URL
  const origToken = process.env.RERANKER_API_TOKEN

  beforeEach(() => {
    process.env.RERANKER_URL = 'http://reranker.test:8787'
    process.env.RERANKER_API_TOKEN = 'tok'
  })
  afterEach(() => {
    process.env.RERANKER_URL = origUrl
    process.env.RERANKER_API_TOKEN = origToken
    vi.restoreAllMocks()
  })

  it('isCrossEncoderConfigured requires both env vars', () => {
    expect(isCrossEncoderConfigured()).toBe(true)
    delete process.env.RERANKER_API_TOKEN
    expect(isCrossEncoderConfigured()).toBe(false)
  })

  it('returns [] for empty passages without calling the service', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const scores = await crossEncoderScore('q', [])
    expect(scores).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts pairs and returns the scores array', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ scores: [0.9, 0.1] }), { status: 200 })
    )
    const scores = await crossEncoderScore('q', ['a', 'b'])
    expect(scores).toEqual([0.9, 0.1])
  })

  it('throws on non-ok HTTP so callers can fall back', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 401 })
    )
    await expect(crossEncoderScore('q', ['a'])).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/utils/__tests__/cross-encoder.test.ts`
Expected: FAIL — `../cross-encoder` has no such exports.

- [ ] **Step 3: Write the client**

Create `lib/utils/cross-encoder.ts`:

```typescript
/**
 * Client for the self-hosted cross-encoder reranker service
 * (selfhosted/reranker, running on the P4000 at RERANKER_URL). The service
 * scores each (query, passage) pair jointly — a stronger relevance signal
 * than comparing separately-embedded vectors. Reached over the LAN with a
 * bearer token (the service is LAN-published, unlike the same-host
 * loopback services). Feature is inert unless both env vars are set.
 */

const DEFAULT_TIMEOUT_MS = 8_000

export function isCrossEncoderConfigured(): boolean {
  return Boolean(process.env.RERANKER_URL && process.env.RERANKER_API_TOKEN)
}

/**
 * Score each passage against the query. Returns scores in [0,1],
 * index-aligned to `passages`. Throws on any transport/auth/HTTP failure so
 * callers can fall back to the bi-encoder path.
 */
export async function crossEncoderScore(
  query: string,
  passages: string[],
  opts?: { timeoutMs?: number }
): Promise<number[]> {
  if (passages.length === 0) return []
  const baseUrl = process.env.RERANKER_URL
  const token = process.env.RERANKER_API_TOKEN
  if (!baseUrl || !token) {
    throw new Error('RERANKER_URL / RERANKER_API_TOKEN are not configured')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  )
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ query, passages }),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new Error(`Reranker HTTP ${response.status}`)
    }
    const json = (await response.json()) as { scores?: number[] }
    if (!Array.isArray(json.scores) || json.scores.length !== passages.length) {
      throw new Error('Reranker returned a malformed scores array')
    }
    return json.scores
  } finally {
    clearTimeout(timeoutId)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/utils/__tests__/cross-encoder.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/utils/cross-encoder.ts lib/utils/__tests__/cross-encoder.test.ts
git commit -m "Add cross-encoder reranker client"
```

---

## Task 3: `rerankByCrossEncoder` in `lib/embeddings/rerank.ts`

**Files:**
- Modify: `lib/embeddings/rerank.ts`
- Test: `lib/embeddings/__tests__/rerank-cross-encoder.test.ts`

**Interfaces:**
- Consumes: `crossEncoderScore(query, passages)` from Task 2; existing `splitText`, `PASSAGE_MAX_TOKENS`, `PASSAGE_OVERLAP_TOKENS`, `MAX_PASSAGES_PER_DOC`, `RerankableDoc`, `RerankedDoc<T>`, `embedTexts`, `cosineSimilarity`, `RERANK_MODEL` from this file.
- Produces: `rerankByCrossEncoder<T extends RerankableDoc>(docs: T[], query: string, topK: number): Promise<RerankedDoc<T>[]>` — same shape as `rerankByEmbedding`; `score` is the doc's best-passage cross-encoder score in `[0,1]`; throws if the service call throws (caller falls back).
- Refactors: extracts a private `rerankByPassageScorer<T>(docs, query, topK, scoreFn)` that holds the passage-split / best-passage / sort-and-slice logic once; `scoreFn: (query: string, passages: string[]) => Promise<number[]>` returns one score per passage in input order. Both `rerankByEmbedding` (existing behavior preserved — its tests in `lib/embeddings/__tests__/rerank.test.ts` must still pass) and `rerankByCrossEncoder` become thin wrappers over it. This removes the duplication the two functions would otherwise share.

- [ ] **Step 1: Write the failing test**

Create `lib/embeddings/__tests__/rerank-cross-encoder.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => true),
  // Score = 1 for passages mentioning "quantum", else 0. Aligns to input order.
  crossEncoderScore: vi.fn(async (_q: string, passages: string[]) =>
    passages.map(p => (/quantum/i.test(p) ? 1 : 0))
  )
}))

import { rerankByCrossEncoder } from '../rerank'

describe('rerankByCrossEncoder', () => {
  it('orders on-topic docs above off-topic and applies topK', async () => {
    const docs = [
      { content: 'A page about cooking pasta and sauces.', id: 'off' },
      { content: 'An article on quantum computing and qubits.', id: 'on' },
      { content: 'Gardening tips for spring.', id: 'off2' }
    ]
    const out = await rerankByCrossEncoder(docs, 'quantum computers', 2)
    expect(out).toHaveLength(2)
    expect(out[0].doc.id).toBe('on')
    expect(out[0].score).toBeGreaterThan(out[1].score)
    expect(out[0].topPassages.length).toBeGreaterThan(0)
  })

  it('returns [] for empty input', async () => {
    await expect(rerankByCrossEncoder([], 'q', 5)).resolves.toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/embeddings/__tests__/rerank-cross-encoder.test.ts`
Expected: FAIL — `rerankByCrossEncoder` is not exported.

- [ ] **Step 3: Extract the shared helper, refactor `rerankByEmbedding`, add `rerankByCrossEncoder`**

In `lib/embeddings/rerank.ts`, add the import at the top (after the existing imports):

```typescript
import { crossEncoderScore } from '../utils/cross-encoder'
```

**3a.** Add this private helper (place it directly above the existing `rerankByEmbedding`). It holds the passage-split / best-passage / sort-and-slice logic once; the only thing that varies between rerankers is `scoreFn`:

```typescript
/**
 * Shared reranking core: split each doc into passages, score every passage
 * against the query via `scoreFn` (one score per passage, input order),
 * take each doc's best passage as its score, and return the top-K docs.
 * The passage strategy and RerankedDoc shape are identical across rerankers;
 * only how a (query, passage) pair is scored differs.
 */
async function rerankByPassageScorer<T extends RerankableDoc>(
  docs: T[],
  query: string,
  topK: number,
  scoreFn: (query: string, passages: string[]) => Promise<number[]>
): Promise<RerankedDoc<T>[]> {
  if (docs.length === 0) return []

  const passagesPerDoc = docs.map(doc =>
    splitText(doc.content, PASSAGE_MAX_TOKENS, PASSAGE_OVERLAP_TOKENS).slice(
      0,
      MAX_PASSAGES_PER_DOC
    )
  )

  const flatPassages = passagesPerDoc.flat()
  if (flatPassages.length === 0) return []
  const scores = await scoreFn(query, flatPassages)

  let cursor = 0
  const scored: RerankedDoc<T>[] = docs.map((doc, i) => {
    const passages = passagesPerDoc[i]
    const passageScores = passages.map((passage, j) => ({
      passage,
      score: scores[cursor + j] ?? 0
    }))
    cursor += passages.length

    passageScores.sort((a, b) => b.score - a.score)
    return {
      doc,
      score: passageScores[0]?.score ?? 0,
      topPassages: passageScores.slice(0, 3).map(p => p.passage)
    }
  })

  return scored.sort((a, b) => b.score - a.score).slice(0, topK)
}
```

**3b.** Replace the body of the existing `rerankByEmbedding` so it delegates to the helper, passing a bi-encoder `scoreFn` (embed query + all passages once, then cosine each passage against the query). Keep its exported signature and JSDoc intact — behavior is unchanged, so its tests in `lib/embeddings/__tests__/rerank.test.ts` still pass. The new body:

```typescript
export async function rerankByEmbedding<T extends RerankableDoc>(
  docs: T[],
  query: string,
  topK: number
): Promise<RerankedDoc<T>[]> {
  return rerankByPassageScorer(docs, query, topK, async (q, passages) => {
    const vectors = await embedTexts([q, ...passages], RERANK_MODEL)
    const queryVec = vectors[0]
    return vectors.slice(1).map(v => cosineSimilarity(queryVec, v))
  })
}
```

**3c.** Add `rerankByCrossEncoder` (append at the end of the file). `crossEncoderScore` already has the `(query, passages) => Promise<number[]>` shape the helper wants, so it drops straight in:

```typescript
/**
 * Cross-encoder reranking via the self-hosted reranker service
 * (lib/utils/cross-encoder.ts). Same passage strategy and return shape as
 * rerankByEmbedding, but each (query, passage) pair is scored jointly by a
 * cross-encoder — a stronger relevance signal than comparing
 * separately-embedded vectors. Scores are in [0,1]. Throws if the service
 * call fails, so advanced-search falls back to rerankByEmbedding (which
 * itself falls back to the keyword scorer).
 */
export async function rerankByCrossEncoder<T extends RerankableDoc>(
  docs: T[],
  query: string,
  topK: number
): Promise<RerankedDoc<T>[]> {
  return rerankByPassageScorer(docs, query, topK, crossEncoderScore)
}
```

- [ ] **Step 4: Run both the new and existing rerank tests**

Run: `bun run test lib/embeddings/__tests__/rerank-cross-encoder.test.ts lib/embeddings/__tests__/rerank.test.ts`
Expected: PASS — the new `rerankByCrossEncoder` suite (2 tests) AND the existing `rerankByEmbedding` suite (proving the refactor preserved behavior).

- [ ] **Step 5: Commit**

```bash
git add lib/embeddings/rerank.ts lib/embeddings/__tests__/rerank-cross-encoder.test.ts
git commit -m "Add rerankByCrossEncoder"
```

---

## Task 4: Phase 1 — wire cross-encoder into advanced search

**Files:**
- Modify: `app/api/advanced-search/route.ts` (rerank block, ~333-371)

**Interfaces:**
- Consumes: `rerankByCrossEncoder`, `rerankByEmbedding` from `lib/embeddings/rerank.ts`; `isCrossEncoderConfigured` from `lib/utils/cross-encoder.ts`; existing `calculateRelevanceScore`.
- Produces: no new exports — replaces the two-tier rerank block with a three-tier cascade.

- [ ] **Step 1: Add the import**

At the top of `app/api/advanced-search/route.ts`, alongside the existing `rerankByEmbedding` import:

```typescript
import { rerankByCrossEncoder, rerankByEmbedding } from '@/lib/embeddings/rerank'
import { isCrossEncoderConfigured } from '@/lib/utils/cross-encoder'
```

(Replace the existing single-name `rerankByEmbedding` import line with the two-name line above; add the `isCrossEncoderConfigured` import.)

- [ ] **Step 2: Replace the rerank block**

Replace the whole `try { const reranked = await rerankByEmbedding(...) ... } catch { ...keyword... }` block (currently ~lines 338-371) with:

```typescript
      // Relevance reranking, best-available first:
      //   cross-encoder service (jointly scores query+passage) →
      //   bi-encoder cosine (local MiniLM) → keyword scorer.
      // Each tier degrades to the next on failure, so a reranker outage is
      // invisible. All three produce scores in [0,1] except the keyword
      // scorer, which sorts on its own scale.
      const docsForRerank = generalResults.map(result => ({
        // Strip <mark> highlight tags before scoring — markup isn't content.
        // The original (highlights intact for the UI) rides along.
        content: result.content.replace(/<\/?mark>/g, ''),
        original: result
      }))

      const applyReranked = (
        reranked: { doc: { original: SearXNGResult }; score: number }[],
        minScore: number
      ) => {
        generalResults = reranked
          .filter(r => r.score >= minScore)
          .map(r => r.doc.original)
      }

      let reranked = false
      if (isCrossEncoderConfigured()) {
        try {
          const out = await rerankByCrossEncoder(docsForRerank, query, maxResults)
          // Cross-encoder [0,1]; 0.3 is a loose on-topic floor (the answering
          // model does the fine-grained judging, this only drops clear junk).
          applyReranked(out, 0.3)
          reranked = true
          console.log(
            `[advanced-search] cross-encoder reranked ${out.length}/${docsForRerank.length}`
          )
        } catch (error) {
          console.error(
            '[advanced-search] cross-encoder failed, falling back to bi-encoder:',
            error
          )
        }
      }

      if (!reranked) {
        try {
          const out = await rerankByEmbedding(docsForRerank, query, maxResults)
          applyReranked(out, 0.2)
          reranked = true
        } catch (error) {
          console.error(
            '[advanced-search] embedding rerank failed, using keyword scorer:',
            error
          )
          const MIN_RELEVANCE_SCORE = 10
          generalResults = generalResults
            .map(result => ({
              ...result,
              score: calculateRelevanceScore(result, query)
            }))
            .filter(result => result.score >= MIN_RELEVANCE_SCORE)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults)
        }
      }
```

- [ ] **Step 3: Typecheck and full test suite**

Run: `bun typecheck 2>&1 | grep -E "advanced-search|rerank|cross-encoder" || echo CLEAN`
Expected: `CLEAN` (pre-existing `lastViewedAt` test-fixture errors elsewhere are unrelated).

Run: `bun run test`
Expected: all tests pass (the new suites included).

- [ ] **Step 4: Format and commit**

```bash
bunx prettier --write app/api/advanced-search/route.ts
git add app/api/advanced-search/route.ts
git commit -m "Wire cross-encoder into advanced search (Phase 1) with layered fallback"
```

- [ ] **Step 5: Staging deploy + live verification**

Set staging env (both live containers read `.env`; add the two vars once):

```bash
cd /home/nightfury/selfhosted/ask
grep -q '^RERANKER_URL=' .env || printf '\nRERANKER_URL=http://192.168.50.160:8787\nRERANKER_API_TOKEN=%s\n' "$(ssh nightfury@192.168.50.160 'grep RERANKER_API_TOKEN ~/selfhosted/reranker/.env | cut -d= -f2')" >> .env
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml build ask
docker compose -f docker-compose.yaml -f docker-compose.admin-feature.yaml up -d ask
until curl -s -o /dev/null -w "%{http_code}" http://localhost:3739/ | grep -q 200; do sleep 2; done
```

Then drive an advanced query and confirm the cross-encoder ran and latency is acceptable:

```bash
docker exec ask-admin-feature node -e 'const t=Date.now();fetch("http://127.0.0.1:3000/api/advanced-search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"pascal gpu cuda compute capability ollama",maxResults:10,searchDepth:"advanced"})}).then(r=>r.json()).then(j=>console.log("results",(j.results||[]).length,"in",Date.now()-t,"ms"))'
docker logs ask-admin-feature --since 2m 2>&1 | grep cross-encoder
```

Expected: a `[advanced-search] cross-encoder reranked N/M` log line, results returned, total time within a few seconds of the pre-change baseline. Also confirm fallback: `ssh nightfury@192.168.50.160 'cd ~/selfhosted/reranker && docker compose stop'`, re-run the query, expect a "falling back to bi-encoder" log line and still-valid results; then restart the service.

---

## Task 5: Phase 2 — upload-RAG reranking

**Files:**
- Modify: `lib/embeddings/upload-rag.ts` (`queryFileChunks`, ~88-118)
- Test: `lib/embeddings/__tests__/upload-rag-rerank.test.ts`

**Interfaces:**
- Consumes: `crossEncoderScore`, `isCrossEncoderConfigured` from `lib/utils/cross-encoder.ts`.
- Produces: `queryFileChunks(filePath, query, topK=10)` unchanged signature/return (`{filename, chunks: string[]} | null`); internally retrieves a wider cosine candidate pool then cross-encoder-reranks it when configured.

- [ ] **Step 1: Write the failing test**

Create `lib/embeddings/__tests__/upload-rag-rerank.test.ts`:

```typescript
import { promises as fs } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../utils/cross-encoder', () => ({
  isCrossEncoderConfigured: vi.fn(() => true),
  crossEncoderScore: vi.fn(async (_q: string, passages: string[]) =>
    // Prefer the chunk containing "answer".
    passages.map(p => (/answer/i.test(p) ? 1 : 0))
  )
}))

// Make cosine retrieval deterministic: every chunk equally "close" so the
// candidate pool is just insertion order, and the cross-encoder decides.
vi.mock('../transformers-embedding', () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [1, 0])),
  cosineSimilarity: () => 1,
  getConfiguredModel: () => 'Xenova/all-MiniLM-L6-v2'
}))

import { queryFileChunks } from '../upload-rag'

describe('queryFileChunks with cross-encoder', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reranks the cosine candidate pool with the cross-encoder', async () => {
    const stored = {
      filename: 'doc.pdf',
      model: 'Xenova/all-MiniLM-L6-v2',
      chunks: [
        { content: 'irrelevant preamble one', embedding: [1, 0] },
        { content: 'the answer you want is here', embedding: [1, 0] },
        { content: 'irrelevant preamble two', embedding: [1, 0] }
      ]
    }
    vi.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify(stored) as never)

    const out = await queryFileChunks('/uploads/doc.pdf', 'what is the answer', 1)
    expect(out).not.toBeNull()
    expect(out!.chunks[0]).toContain('answer')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test lib/embeddings/__tests__/upload-rag-rerank.test.ts`
Expected: FAIL — current code returns cosine order (insertion order here), so `chunks[0]` is the preamble, not the answer.

- [ ] **Step 3: Modify `queryFileChunks`**

In `lib/embeddings/upload-rag.ts`, add the import near the top:

```typescript
import {
  crossEncoderScore,
  isCrossEncoderConfigured
} from '../utils/cross-encoder'
```

Replace the retrieval block (the `const ranked = stored.chunks...slice(0, topK)` and the `return { filename, chunks }` that follow) with:

```typescript
  const [queryEmbedding] = await embedTexts([query], stored.model)

  // First stage: bi-encoder cosine to pull a wider candidate pool.
  const CANDIDATE_POOL = Math.max(topK * 3, 30)
  const candidates = stored.chunks
    .map(chunk => ({
      content: chunk.content,
      score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATE_POOL)

  // Second stage: cross-encoder reranks the candidate pool when available.
  // Any failure falls back to the cosine ordering already computed.
  if (isCrossEncoderConfigured() && candidates.length > 1) {
    try {
      const scores = await crossEncoderScore(
        query,
        candidates.map(c => c.content)
      )
      const reranked = candidates
        .map((c, i) => ({ content: c.content, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
      return { filename: stored.filename, chunks: reranked.map(r => r.content) }
    } catch (error) {
      console.error(
        '[upload-rag] cross-encoder failed, using cosine order:',
        error
      )
    }
  }

  return {
    filename: stored.filename,
    chunks: candidates.slice(0, topK).map(c => c.content)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test lib/embeddings/__tests__/upload-rag-rerank.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `bun run test`
Expected: all pass.
Run: `bun typecheck 2>&1 | grep -E "upload-rag" || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 6: Commit**

```bash
bunx prettier --write lib/embeddings/upload-rag.ts
git add lib/embeddings/upload-rag.ts lib/embeddings/__tests__/upload-rag-rerank.test.ts
git commit -m "Cross-encoder reranking for upload-RAG (Phase 2)"
```

---

## Task 6: Production rollout

**Files:** none (deploy only).

- [ ] **Step 1: Confirm prod env has the reranker vars**

Production and staging share `.env`, so `RERANKER_URL` / `RERANKER_API_TOKEN` are already present from Task 4 Step 5. Confirm:

```bash
cd /home/nightfury/selfhosted/ask
grep -E '^RERANKER_(URL|API_TOKEN)=' .env
```

Expected: both lines present.

- [ ] **Step 2: Merge to dev and redeploy production**

```bash
git checkout dev && git merge admin-feature --ff-only && git push origin dev
docker compose up -d --build
until curl -s -o /dev/null -w "%{http_code}" http://localhost:3738/ | grep -q 200; do sleep 2; done
git checkout admin-feature
```

Expected: prod healthy (200).

- [ ] **Step 3: Verify cross-encoder is live in production**

```bash
docker exec ask node -e 'fetch("http://127.0.0.1:3000/api/advanced-search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"best self-hosted rss reader 2026",maxResults:8,searchDepth:"advanced"})}).then(r=>r.json()).then(j=>console.log("results",(j.results||[]).length))'
docker logs ask --since 2m 2>&1 | grep cross-encoder
```

Expected: results returned and a `[advanced-search] cross-encoder reranked` log line.

---

## Self-Review

**Spec coverage:**
- Reranker service (bge-reranker-v2-m3, FlagEmbedding, GPU, token, health) → Task 1. ✓
- Ask client with config gate + timeout + throw-on-failure → Task 2. ✓
- Phase 1 web reranking with layered fallback (cross → bi → keyword) → Tasks 3-4. ✓
- Phase 2 upload-RAG text reranking (wider pool → cross-encoder) → Task 5. ✓
- Inert until env set; staging→prod flow → Tasks 4-6. ✓
- Images/scanned PDFs untouched → not modified anywhere (only `queryFileChunks` text path changes). ✓
- Score-scale consistency ([0,1] via `normalize=True`) → Global Constraints + Task 1 Step 1 + thresholds in Task 4. ✓

**Networking correction vs spec:** the reranker is on a different host, so LAN IP:port + token replaces the spec's `shared-infra` network note — stated in Global Constraints and Task 1. ✓

**Placeholder scan:** every code step contains complete code; no TBD/TODO. ✓

**Type consistency:** `crossEncoderScore(query, passages, opts?) → Promise<number[]>` (Task 2) is called exactly that way in Tasks 3 and 5; `rerankByCrossEncoder(docs, query, topK) → RerankedDoc<T>[]` (Task 3) is consumed with `.doc.original` / `.score` in Task 4, matching `RerankedDoc`'s `{doc, score, topPassages}`. ✓
