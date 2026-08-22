# Hands-free voice conversation loop — design

**Date:** 2026-08-22
**Status:** Design (pending review → plan)
**Depends on:** Voice Slice 1 (read-aloud gist) + Slice 2 (dictate) — both live on prod/staging.

## 1. Goal

A **hands-free conversation mode**: enter it, speak a question, hear a cited answer
read aloud, ask a follow-up — all without touching the keyboard or screen. It closes
the gap Slice 2 deliberately left open (dictation drops a transcript into the composer
for *manual* send) into a continuous loop:

> **listen → transcribe → auto-submit → stream answer → speak gist → listen again**

A private, self-hosted voice assistant that does *real sourced research* (cites its
sources), not chit-chat. This is "Voice Slice 3".

## 2. Decisions (locked in brainstorming)

- **Turn capture:** auto-listen with **Voice-Activity-Detection (Silero VAD) silence
  endpointing** — the mic reopens on its own after each answer; the user just talks and
  VAD detects when they stop (~1.2 s silence) and submits. Fully hands-free.
- **Turn model:** **sequential** (no barge-in in v1). The mic stays closed while the
  gist (~6 s) is spoken, then reopens. Barge-in (mic-live-during-TTS + echo cancellation)
  is a documented v2.
- **Context/persistence:** each turn is a normal message on a **real `chatId`** — the
  conversation carries context across turns and is **saved to history** like any chat.
- **Spoken reply:** a **short condensed reply** (2–3 sentences), concise for the ear.
  NOTE (verified 2026-08-22): the on-screen Listen button now reads the **full cleaned
  answer** aloud — `emitSpokenGist` streams the whole answer as `data-spokenGist` (no model
  call). A full-answer read every turn is far too long for a conversation loop, so the loop
  must instead speak the **condensed** version via the existing `condenseForSpeech`
  (granite4.1:8b → 2–3 sentences, `lib/voice/spoken-gist.ts`) — already built, just not
  currently wired to the stream. Confirm this wiring at plan time.
- **Surface:** a **dedicated voice-first view** — a full-screen conversation screen with
  a Wild-Breath orb reacting to state, the live transcript, the answer text + source
  chips, and a single **End** control.
- **Approach:** **client-orchestrated loop composing the existing endpoints** (A), NOT a
  new realtime streaming pipeline (B). Almost no new backend.

## 3. Reuses (no change or minimal change)

- `POST /api/voice/transcribe` (Whisper STT, gated + authed) — one call per captured turn.
- `POST /api/voice/speak` (Kokoro TTS) + `hooks/use-speech-playback.ts` — speak the gist.
- The **spoken-text pipeline** — two builders exist: `emitSpokenGist` (streams the *full
  cleaned answer* as `data-spokenGist`; what the on-screen Listen button speaks today) and
  `condenseForSpeech` (granite4.1:8b → 2–3 sentence gist, `spoken-gist.ts`, currently
  unwired). The loop speaks the **condensed** version to keep turns short — a small,
  contained wiring change, not new infrastructure.
- The **chat stream** (`useChat` / `create-chat-stream-response.ts`) — each turn is a
  normal submit on the shared `chatId`; answer, citations, and source cards render
  unchanged.
- `hooks/use-voice-dictation.ts` — exposes the live `MediaStream` (feeds both the VAD and
  the orb's level meter) + `start/stop/cancel`. May be lightly generalized (see §7).
- Wild-Breath renderer (`components/ui/wild-breath-field.tsx`) — the orb.
- Gating: `VOICE_ENABLED` (server) + `NEXT_PUBLIC_VOICE_ENABLED` (client); the whole mode
  is hidden when off. `microphone=(self)` in `next.config.mjs` (already correct — do not
  regress; see [[permissions-policy-blocked-geo-mic]]).

## 4. The loop — client state machine

A single client machine drives everything. States and transitions:

```
        ┌─────────── enter ───────────┐
        ▼                             │
      IDLE ──(mic granted)──► LISTENING ──(VAD endpoint: speech then ~1.2s silence)──►
        ▲                                                                    │
        │                                                                    ▼
   (End / error)                                                       TRANSCRIBING
        │                                                                    │
        │                                            (empty/garbage → re-LISTEN)
        │                                                                    ▼
      SPEAKING ◄──(gist ready → Kokoro play)── THINKING (submit → stream answer) ◄──┘
        │
     (playback ends)──► LISTENING   (loop)
```

- **IDLE** — entering the view; request mic permission. On grant → LISTENING. On deny →
  a clear "microphone needed" state with a retry + Exit.
- **LISTENING** — VAD armed; orb reacts to input level. VAD fires `onSpeechEnd(audio)`
  after detected speech followed by the silence threshold → hand the captured segment to
  TRANSCRIBING. A **min-speech-duration** guard (e.g. ≥300 ms of speech) ignores coughs/
  clicks so they never submit.
- **TRANSCRIBING** — `POST /api/voice/transcribe`. If the transcript is empty/whitespace or
  the call fails → **return to LISTENING** (never submit garbage); optionally a soft chime
  or a brief spoken "I didn't catch that" after N misses.
- **THINKING** — submit the transcript as a user message on the shared `chatId` via the
  existing stream. The answer + source chips render live in the view. The `data-spokenGist`
  part arrives near the end.
- **SPEAKING** — play the gist via `/api/voice/speak` + `use-speech-playback`. Orb pulses to
  the audio. On playback end (or if no gist / TTS fails) → LISTENING.
- **End** (button, or a later "stop" hotword) → tear down VAD + mic + any playback → leave
  the view. The chat thread remains in history.

Only ONE of {mic capture, TTS playback} is ever active (sequential) — no echo/feedback.

## 5. VAD + endpointing

- **Library:** `@ricky0123/vad-web` (Silero VAD running in-browser via onnxruntime-web).
  Robust speech/non-speech classification; far fewer false triggers than energy/RMS
  thresholding. Self-contained WASM/ONNX — no server round-trip, nothing leaves the device
  until a real turn is captured.
- **Params (tunable):** positive-speech threshold, `redemptionFrames`/silence window ≈
  1.2 s, `minSpeechFrames` ≈ 300 ms, a small `preSpeechPadFrames` so word onsets aren't
  clipped.
- **Bundle:** the ONNX model + WASM must be served locally (CSP/offline) — vendor them into
  `public/` (no CDN), like the app already self-hosts model assets. Verify onnxruntime-web
  doesn't collide with the server-side `onnxruntime-node` already in `serverExternalPackages`
  (different package/runtime; should be independent — confirm in the plan).
- The VAD consumes the same `MediaStream` the orb's level meter reads.

## 6. UX — the conversation view

- **Entry:** a distinct control from the tap/hold dictate mic — proposed: a "Converse"
  affordance (e.g. a long-press on the mic, or a small headset/waveform button beside it)
  that opens the view. Decide the exact entry in the plan; keep dictate (Slice 2) unchanged.
- **View:** full-screen, cosmic. Center = the **Wild-Breath orb** as the status indicator:
  - IDLE: slow pulse. LISTENING: reacts to mic level (breathe with your voice).
  - THINKING: faster spin/shimmer. SPEAKING: pulse synced to the TTS audio.
- Below the orb: the **live transcript** of the current turn (from partials if available,
  else the finalized transcript), then the streaming **answer text + source chips** (reusing
  the citation components). A caption line shows the spoken gist.
- Controls: **End** (always visible); a **mute/pause** toggle (stop auto-listening without
  leaving); optional captions on/off.
- Reduced-motion: the orb settles to a static state; the loop still works.
- Accessibility: `aria-live` for state changes and the answer, but throttled so it isn't
  spammed every turn.

## 7. Components / files (new + touched)

New:
- `components/voice/voice-conversation.tsx` — the dedicated view (orb + transcript + answer +
  controls), rendered as a route or full-screen overlay (decide in plan).
- `hooks/use-voice-conversation.ts` — the state machine orchestrating VAD → transcribe →
  submit → gist/speak → re-listen; owns the lifecycle + error handling.
- `lib/voice/vad.ts` — thin wrapper over `@ricky0123/vad-web` (init, arm/disarm, params,
  asset paths).
- Vendored VAD assets under `public/vad/` (ONNX + WASM).

Touched (small):
- `hooks/use-voice-dictation.ts` — possibly factor the mic/stream acquisition so both dictate
  and the conversation loop share it (or leave dictate alone and acquire independently).
- The composer entry point (a "Converse" control) — `components/chat-panel.tsx` /
  `components/voice/mic-button.tsx`.
- Routing/overlay wiring for the view.
- `package.json` — add `@ricky0123/vad-web` + `onnxruntime-web`.

No new backend endpoints. No DB schema changes (turns persist through the normal chat path).

## 8. Error handling & edge cases

- Mic permission denied / no secure context → explicit state + Exit (getUserMedia needs
  HTTPS; works on prod, not the plain-http LAN lab — same constraint as Slice 2).
- Empty/failed transcription → re-listen, never submit (fail-safe).
- LLM/stream error → brief spoken "something went wrong", then re-listen (or Exit after
  repeated failures).
- TTS failure → skip speaking, go straight to LISTENING (fail-open, as Slice 1).
- Rapid double-speech / VAD re-fire while TRANSCRIBING/THINKING → ignore (machine gates
  input to LISTENING only).
- Tab backgrounded / view unmounted → full teardown (mic, VAD, playback, stream) — no hot
  mic left open.

## 9. Testing

- **Unit:** the state machine (`use-voice-conversation`) with VAD, transcribe, submit, and
  playback all mocked — assert every transition, the garbage-transcript re-listen, teardown,
  and error paths. This is where the correctness lives.
- **Component:** the view renders each state; reduced-motion; End tears down.
- **Manual E2E:** on **prod HTTPS, signed in** (getUserMedia needs a secure context) — a real
  multi-turn spoken conversation with follow-up context + cited answers. (The LAN-http lab
  can't drive the mic; server paths are already E2E-verified from Slice 2.)

## 10. Slicing

- **v1 (this):** the full hands-free loop — VAD auto-listen, sequential turns, dedicated
  view with the reactive orb, same-thread context + persistence, spoken gist, robust error
  handling.
- **v2 (deferred, documented):** barge-in (mic-live-during-TTS + echo cancellation), a "stop"
  hotword to end by voice, TTS voice selection, streaming/progressive gist playback, mobile
  touch polish.

## 11. Build strategy — RESOLVED

The lab was reconciled onto prod on 2026-08-22 (merge `dd7e0ca1`, see
[[lab-reconciled-to-prod]]): **`flow-design` now contains all of `dev`**, including the current
tap-vs-hold voice stack. So build **lab-first on `flow-design`** as normal (lab :3742), then port
to staging/prod with `git cherry-pick -x`. Caveat unchanged: the true live-mic test needs prod
HTTPS (getUserMedia has no secure context on the plain-http LAN lab), so schedule a prod mic
verification after the port — the server paths (transcribe / chat stream / speak) are exercisable
earlier.

## 12. Non-goals (v1)

No wake-word/always-listening, no barge-in, no realtime streaming pipeline, no new STT/TTS
services (reuse `ask-whisper` + `ask-tts`), no multi-lingual UI, no per-turn TTS voice picker.
