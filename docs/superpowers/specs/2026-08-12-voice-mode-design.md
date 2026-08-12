# Voice Mode — "Talk to Ask" (turn-based two-way voice)

- **Date:** 2026-08-12
- **Status:** Design approved; ready for implementation planning
- **Branch / env:** Lab-first — built on `flow-design` (`ask-flow` worktree), runs on the lab (`:3742`) with lab-scoped voice services. Ported to staging (`admin-feature`) then prod (`dev`) only after it's proven on the lab AND explicitly approved.

## 1. Goal

Let a user **talk to Ask and hear it answer**, fully self-hosted. Push-to-talk to ask a question (local Whisper STT) → Ask runs its normal research turn → a short, conversational **spoken gist** of the answer is synthesized by a local TTS model and streamed back as audio, while the **full cited research report renders on screen unchanged**.

The north star is **two-way, turn-based** voice. It leans into the fact that we own the GPU fleet: **no audio ever leaves the fleet, no cloud STT/TTS, no per-use API cost.**

## 2. Non-goals (YAGNI)

- **No full hands-free / full-duplex loop** (no wake word, VAD, barge-in, echo cancellation) — that's a later upgrade path (would move to a WebSocket session).
- **No voice cloning / custom voice training** — use Kokoro's built-in voices.
- **No cloud STT/TTS** — local only, by design.
- **Vision is out of scope** — image-in-chat already works (`lib/config/model-vision.ts`, `transform-file-parts.ts`); this project is voice only.
- **No change to the research/answer pipeline** — voice is a layer bolted on top; the text experience is untouched.

## 3. Locked experience decisions

- **Two-way, turn-based** (push-to-talk in, spoken answer out; no always-listening).
- **Concise spoken gist + full written report.** What Ask *says* is a 2–3 sentence conversational summary (no citation markers, no tables, no URLs); what it *shows* is the full cited report. First-audio can therefore come quickly and independently of the on-screen report length.
- **TTS: Kokoro-82M** (Apache-2.0, high quality, low latency, streams, multiple voices). *Piper* is the documented fallback if CPU-only/ultra-light is ever needed.
- **STT: `faster-whisper`** with `distil-large-v3` (≈2× faster than large-v3, near-parity accuracy), GPU.
- **Ship in slices; start with Slice 1 (read-aloud).**

## 4. Architecture — bolt-on voice layer

Voice is an isolated capability layered on the existing pipeline. Two self-hosted services + two thin app endpoints + a client layer + one server-side gist step. The research/answer path is never blocked by a voice failure.

```
[mic hold]→MediaRecorder→ POST /api/voice/transcribe ─→ Whisper(distil-large-v3) ─→ {text}
      ↓ (text dropped into composer, submitted)
   POST /api/chat {voice:true} ─→ (unchanged research turn) ─→ full report streams to screen
      ↓ onFinish (voice turn only)
   granite4.1:8b condense ─→ data-spoken-gist part (text) ─→ shown as caption
      ↓
   POST /api/voice/speak {gist} ─→ Kokoro-82M ─→ streamed audio ─→ client plays
```

### 4.1 Components (each isolated, well-bounded, independently testable)

| Component | What it does | Interface | Depends on |
|---|---|---|---|
| **STT service** (`ask-whisper-lab`) | Transcribe audio → text | `POST /transcribe` (audio) → `{text}` | GPU, faster-whisper |
| **TTS service** (`ask-tts-lab`) | Synthesize text → streamed audio | `POST /speak` (`{text, voice?}`) → `audio/*` stream | GPU, Kokoro |
| **`/api/voice/transcribe`** | Auth, size-cap, forward to STT | `POST` audio → `{text}` | STT service, `getCurrentUserId` |
| **`/api/voice/speak`** | Auth, forward to TTS, **stream** audio to client | `POST {text}` → streamed audio | TTS service, `getCurrentUserId` |
| **Gist generator** (`lib/voice/spoken-gist.ts`) | Condense a cleaned answer → 2–3 spoken sentences (no citations/tables/URLs) | `condenseForSpeech(answerText): Promise<string>` | `granite4.1:8b` (local) |
| **Stream part `data-spoken-gist`** | Carry the gist text to the client on voice turns | AI-SDK data part | `create-chat-stream-response` onFinish |
| **Client voice layer** (`components/voice/*`) | Mic capture, submit, gist caption, streamed playback, controls | React (composer + message) | `MediaRecorder`, `<audio>`/Web Audio |

### 4.2 Config / flags

- `VOICE_ENABLED` (default off; lab overlay sets `true`) — gates the endpoints AND hides the client controls. Text users see zero change.
- `WHISPER_SERVICE_URL`, `TTS_SERVICE_URL` — container-to-container URLs (unset ⇒ voice fails open / disabled), mirroring `RERANKER_URL` / `EMBEDDING_SERVICE_URL`.
- `VOICE_TTS_MODEL` / `VOICE_TTS_VOICE`, `VOICE_STT_MODEL` — model/voice selection with sane defaults.
- Only voice turns pay the gist cost: the chat request carries `voice: true` (from voice-mode state), and the gist step runs only then.

## 5. Fail-open behavior (Ask's signature)

Every voice path is additive and degrades silently; the written answer is authoritative and always delivered.

| Failure | Behavior |
|---|---|
| STT down/timeout | Mic UI: "couldn't transcribe — type instead." No turn is blocked. |
| Gist (granite) down | Fall back to the answer's first ~2 sentences (citation-stripped), or skip audio. Report unaffected. |
| TTS down/timeout | Show the gist as a caption, no audio. Report unaffected. |
| `VOICE_ENABLED` off / URLs unset | Controls hidden; endpoints 404/disabled. Text path identical to today. |
| Oversized/short audio | Reject at the endpoint with a friendly message; no forward. |

## 6. Privacy / self-hosted posture

Audio is transcribed and synthesized entirely on the fleet. Endpoints are auth-gated (`getCurrentUserId`). Raw audio is ephemeral (not persisted); only the transcript persists, as the normal user message. No third-party STT/TTS.

## 7. Deployment (lab-first)

- New lab containers `ask-whisper-lab`, `ask-tts-lab` come up alongside the lab stack; `docker-compose.lab.yaml` sets `VOICE_ENABLED=true` + the service URLs.
- Prove on the lab (`:3742`): time-to-first-audio, gist quality, STT accuracy, failure modes.
- Port to staging then prod via the normal flow (cherry-pick `flow-design` → `admin-feature` → merge `dev`), with the services promoted to shared/prod-scoped, **only after explicit approval**. Prod stays `VOICE_ENABLED=false` until then.

## 8. Testing

- **Unit:** `condenseForSpeech` (strips `[n]` citation markers, tables, URLs; caps length; conversational tone), endpoint handlers (auth required, size caps, service-error mapping) with mocked STT/TTS.
- **Integration:** a voice turn with mocked STT/TTS — transcript → `/api/chat {voice:true}` → asserts a `data-spoken-gist` part is emitted and the report is unchanged.
- **Lab manual:** real mic → Whisper → Kokoro; measure time-to-first-audio and gist quality; exercise each fail-open path by killing a service.
- **Service healthchecks** on both new containers (liveness), matching the `ask` healthcheck pattern.

## 9. Slices (ship order)

- **Slice 1 — Read-aloud (FIRST).** TTS service + `/api/voice/speak` + `spoken-gist` generation + `data-spoken-gist` part + a "speak" control on answers + voice-mode auto-play with a caption. *You type; Ask speaks.* Delivers the output half and is immediately useful; no mic needed yet.
- **Slice 2 — Dictate.** STT service + `/api/voice/transcribe` + push-to-talk mic in the composer → full two-way.
- **Slice 3 — Polish.** Streaming/progressive playback for low time-to-first-audio, mobile touch UX, stop/replay, voice selection.

## 10. Open questions / risks

- **Time-to-first-audio target** — measure on the lab; if the after-the-answer gist feels slow, optionally start condensing from the report's first paragraph as it streams (an optimization, not MVP).
- **Kokoro streaming granularity** — confirm sentence-level streaming from the service so playback can start before the whole gist is synthesized.
- **Gist quality on `granite4.1:8b`** — validate the condense prompt; if weak, consider the classifier's cloud model as a fallback condenser.
- **Concurrency/GPU load** — Whisper + Kokoro add fleet load; keep them lab-scoped until measured.
