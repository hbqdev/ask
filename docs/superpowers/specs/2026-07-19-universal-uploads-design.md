# Universal Uploads — Design

Date: 2026-07-19
Status: approved (design approved in session; spec pending user review)

## Overview

Extend Ask's file upload from the current three types (JPEG, PNG, PDF; 10MB)
to all common document and media types, ingested asynchronously on the
NightFuryX workstation (Threadripper 3970X CPU + dedicated GTX 1070 for the
vision model). Uploads keep their existing **per-chat attachment**
semantics: a file's content is consulted only when it is attached to the
message being sent. There is no cross-chat retrieval in this feature.

Approach chosen: **pull-based worker service** (`selfhosted/ingestor`) that
claims jobs from Ask over token-authenticated HTTP. Job state lives in
Postgres. Ask never pushes to the worker, so a sleeping/rebooting
workstation never breaks anything — jobs wait, the worker drains the queue
when it returns.

## Goals

- Accept and ingest: office/text documents, scans and images, audio, video.
- Uploads return instantly; ingestion is background with visible per-file
  status (processing / ready / failed).
- Answers degrade gracefully: a not-yet-ready attachment produces an honest
  "still processing" answer, never a hallucination or an error.
- CPU work (parsing, OCR rasterization, whisper, ffmpeg) on the
  Threadripper; GPU used only for VLM inference, on the dedicated 1070.
- Everyday text documents keep working even when the ingestion box is
  asleep (local fast path in the app container).
- Multi-user isolation preserved (files are per-user; the worker is a
  server-side service that never acts on behalf of a user session).

## Non-goals (explicitly out of scope)

- Cross-chat / knowledge-base retrieval over uploads (decided against).
- Changing where chunks live (`chunks.json` beside the stored file stays).
- Re-ingesting files uploaded before this feature.
- Live progress percentages; status granularity is per-stage, not per-byte.
- The `libraryFiles` table and notes flow — untouched.

## Hardware and model allocation (validated 2026-07-19)

| Resource                                                  | Role                                                                          | Validation                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| NightFuryX Threadripper 3970X (32c/64t, 117GB RAM in WSL) | all CPU ingestion stages                                                      | —                                                                                   |
| GTX 1070 8GB (`GPU-ef45ddca-…`)                           | `qwen3-vl:4b` via the box's ollama, pinned by UUID via `CUDA_VISIBLE_DEVICES` | invoice/chart extraction correct on Pascal; ~16–45s per image warm; ~5.4GB resident |
| RTX 2080 Ti (`GPU-1eed568b-…`)                            | production reranker ONLY (untouched by this feature)                          | compose pinned by UUID                                                              |
| Quadro P2200                                              | unused (per standing decision)                                                | —                                                                                   |

Ollama on NightFuryX runs with `OLLAMA_CONTEXT_LENGTH=8192` and is
LAN-reachable at `http://192.168.50.169:11434` (the worker uses
`localhost`). VLM calls are serialized (one at a time): the 1070 has 8GB
and one 4B model + context fills ~5.4GB.

## Data model

`files` table (existing) gains:

- `status` varchar enum: `pending | processing | ready | failed` —
  default `pending`. Files ingested by the fast path go straight to
  `ready`. Existing rows are backfilled to `ready` (they predate the
  feature and already work or were images).
- `ingestStage` varchar nullable — coarse human-readable stage set by the
  worker (`queued`, `parsing`, `ocr`, `transcribing`, `frames`,
  `embedding`), shown in the chip tooltip. `pending` rows read as queued.
- `attempts` integer default 0.
- `claimedAt` timestamp nullable — set on claim; used for stale-claim
  requeue.
- `ingestError` text nullable — terse human-readable reason on `failed`.
- `ingestedAt` timestamp nullable.

Extracted content: `chunks.json` written beside the stored file (same
format and location `queryFileChunks` reads today, including the recorded
embedding model). Audio/video chunk texts are prefixed with a timestamp
range (`[00:12:30–00:14:05] …`) so retrieved excerpts carry provenance.

## Upload flow (Ask side)

`/api/upload` changes:

- Size cap: **2GB** (`MAX_FILE_SIZE`). The request body is **streamed to
  disk** — the current read-into-memory implementation must be replaced;
  a 2GB buffer in the Next process is not acceptable.
- Allowlist by family (extension + declared media type):
  - documents: pdf, docx, xlsx, pptx, csv, txt, md, html, epub, and code
    text files (ts, js, py, go, rs, java, c, cpp, sh, json, yaml, toml)
  - images: jpeg, png, webp, gif
  - audio: mp3, m4a, wav, ogg, flac
  - video: mp4, mkv, webm, mov
- On success: create the `files` row `status='pending'`, then attempt the
  **fast path**; respond immediately either way.

**Fast path** (runs in the app container, keeps documents working when the
worker is down): for `application/pdf` and text-family files **≤ 20MB**,
extract text locally (pdftotext for PDFs — already in the image; direct
read for text/code/csv/md). If extraction yields meaningful text (> 200
chars), chunk + embed through the existing `upload-rag` path and set
`ready`. A PDF that yields no text layer (scan) stays `pending` for the
worker. The fast path is fire-and-forget after the response, like today's
chunking; it typically completes in seconds.

## Ingest job API (Ask side)

New routes under `/api/ingest/*`, authenticated with bearer
`INGEST_API_TOKEN` (new env var; fail closed when unset — routes return
503). Same token pattern as the reranker/embedder services.

- `POST /api/ingest/claim` — atomically claims the oldest eligible job:
  a single `UPDATE … SET status='processing', claimedAt=now(),
attempts=attempts+1 WHERE id = (SELECT … WHERE status='pending' OR
(status='processing' AND claimedAt < now() - interval '30 minutes')
ORDER BY createdAt LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING …`.
  Response: `{ fileId, filename, mediaType, size }` or `204 No Content`
  when the queue is empty. Jobs whose `attempts` exceed **3** are set
  `failed` (`ingestError='retries exhausted'`) instead of being claimable.
- `GET /api/ingest/file/[id]` — streams the stored file bytes.
- `POST /api/ingest/progress` — `{ fileId, stage }` updates `ingestStage`
  and refreshes `claimedAt` (acts as the heartbeat that prevents stale
  requeue of long jobs like video).
- `POST /api/ingest/complete` — `{ fileId, chunks: string[], error?:
string, retryable?: boolean }`. On success Ask embeds the chunks
  (existing `embedTexts`, document kind, configured model), writes
  `chunks.json`, sets `ready`/`ingestedAt`. On `error` with
  `retryable: true` (transient causes: ollama down, out of disk) the job
  returns to `pending` if attempts remain, else `failed`; a non-retryable
  `error` (corrupt file, unsupported codec, page cap exceeded) sets
  `failed` + `ingestError` immediately.
  Chunk count is capped server-side at 2,000 per file (a multi-hour video
  transcript fits comfortably; the cap bounds abuse).

The claim query's `FOR UPDATE SKIP LOCKED` makes concurrent claims safe if
a second worker ever exists; the 30-minute stale window with heartbeat
covers worker crashes and workstation sleep mid-job.

## Worker service (`selfhosted/ingestor`, on NightFuryX)

One Docker container, CPU-only (no GPU reservation — VLM goes through the
host's ollama). Python; same operational conventions as the reranker and
embedder services (env-file config, health endpoint, restart unless-stopped).

Poll loop: `claim` → download file → dispatch by media type → report
`progress` stages → `complete` with chunk texts. Poll interval 15s when
the queue was empty, immediate re-claim after a completed job.

Extraction per family:

- **Office/text**: pandoc for docx/epub/html/md; libreoffice-headless to
  convert xlsx/pptx (xlsx additionally flattened sheet-by-sheet to CSV-like
  text); csv/txt/code passed through. Output normalized to plain
  text/markdown, then chunked by the same token-based splitter contract
  Ask uses (the worker returns whole extracted text as ordered chunks of
  roughly the same granularity Ask's splitter produces; Ask re-chunks
  oversized entries defensively at embed time).
- **PDF (no text layer)**: pdftoppm rasterizes pages at 150 DPI → each
  page to the VLM ("transcribe this page verbatim; describe figures
  briefly") → pages concatenated in order. Page cap 200; beyond that,
  fail with a clear error.
- **Images**: single VLM call — transcribe any text, then describe the
  image (chart values, UI contents, scene). One chunk unless long.
- **Audio**: faster-whisper (CPU, int8, `large-v3` default,
  model configurable) → segments merged into ~2-minute timestamped chunks.
- **Video**: ffmpeg extracts the audio track → whisper as above; scene
  detection selects keyframes (cap **40** per file) → each keyframe to the
  VLM for a one-line caption with its timestamp → captions merged into the
  transcript timeline as their own timestamped chunks.

Concurrency: **2** CPU jobs in parallel (each internally multi-threaded —
whisper and libreoffice use many cores); **1** VLM call at a time globally
(async lock). A job's failure never kills the loop; it reports `complete`
with `error` and moves on.

## Answer-time behavior (`transform-file-parts`)

- Generalize the existing PDF branch: **any** file whose `chunks.json`
  exists gets RAG-excerpt injection (`queryFileChunks` already
  works once chunks exist). Excerpts inherit timestamps for audio/video.
- Look up the file row by URL/objectKey to make the injection
  **status-aware**:
  - `pending`/`processing` → inject `[Attached file: NAME — still being
processed (STAGE). Its content is not available yet; tell the user to
ask again shortly.]`
  - `failed` → inject `[Attached file: NAME — processing failed: REASON.]`
- Images: keep today's base64 pass-through **in addition to** injected
  excerpts once ready — vision-capable answering models still see pixels;
  all models get the extracted text.
- The current silent behaviors (missing file dropped, unsupported type
  dropped) become explicit one-line injections so the model can tell the
  user instead of ignoring the attachment.

## UI

- Attachment chip (uploads in the composer and rendered user messages)
  gains a status affordance: spinner + stage tooltip while
  pending/processing, normal appearance when ready, red state with the
  error in a tooltip when failed. While any attachment of the current chat
  is pending/processing, the client polls a lightweight
  `GET /api/files/status?ids=…` (session-authed, RLS-scoped) every 5s.
- The upload picker accepts the new types; upload shows byte progress for
  large files (XHR/fetch upload progress against the streaming route).

## Configuration

New Ask env (added to model-manager's registry, `Models → Ingestion`
group): `INGEST_API_TOKEN` (secret). Worker env (`selfhosted/ingestor/
.env`): `ASK_URL=http://192.168.50.231:3738`, `INGEST_API_TOKEN`,
`OLLAMA_URL=http://localhost:11434`, `VLM_MODEL=qwen3-vl:4b`,
`WHISPER_MODEL=large-v3`, `MAX_VIDEO_FRAMES=40`, `JOB_CONCURRENCY=2`.

## Failure handling summary

| Failure                       | Behavior                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Worker down / box asleep      | jobs sit `pending`; chips show queued; text docs unaffected (fast path)                                       |
| Worker dies mid-job           | heartbeat stops → 30-min stale requeue, max 3 attempts → `failed` with reason                                 |
| VLM unavailable (ollama down) | affected job reports `complete` with error → retried on next claim cycle (counts toward attempts)             |
| Embedder down at `complete`   | Ask returns 503 to `complete`; worker retries completion with backoff, job stays claimed (heartbeat keeps it) |
| Oversized/corrupt file        | extraction error → `failed` + reason in chip tooltip and answer injection                                     |
| Send before ready             | honest "still processing" answer; retry later works                                                           |

## Testing

- **Unit (Ask)**: claim atomicity under concurrency (two claims, one
  winner); stale-claim requeue; attempts→failed; status-aware injection
  strings for every status; allowlist and size-gate behavior; fast-path
  routing (text PDF → ready locally; scanned PDF → pending).
- **Unit (worker)**: dispatch per media type against small fixture files
  (tiny docx/xlsx/csv/mp3/mp4/png), VLM and whisper mocked; chunk
  timestamp formatting; caps (frames, pages) enforced.
- **Staging E2E**: one real file per family through upload → status
  progression → ready → question answered from content. The sleeping-node
  case: stop the worker, upload audio, verify queued chip + honest answer,
  start the worker, verify it drains to ready and a retry answers from the
  transcript. Verify a failed file surfaces its reason in chip and answer.
- Prod rollout follows the standard workflow (build/test locally, staging
  E2E, then push-to-production; the worker deploys manually on NightFuryX
  like the other fleet services).
