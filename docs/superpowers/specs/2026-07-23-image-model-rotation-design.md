# Image Model Rotation — Design

**Date:** 2026-07-23
**Status:** Approved direction; pending operator spec review

## Goal

Replace the fixed per-role image model defaults with automatic rotation across a
curated pool, hide model identity from users entirely, and give the premium
model two dynamic entry points (explicit quality requests and retry
escalation). Users who dislike a result and retry silently get a different
engine.

## Current state

- `generateImage` tool exposes `prompt` / `baseImageUrl` / `aspectRatio`.
- Model choice is server-side: role = `edit` iff a base image resolved, else
  `generate`; each role has one hardcoded default (`flux-1.1-pro` generate,
  `nano-banana` edit), overridable deployment-wide via
  `REPLICATE_IMAGE_MODEL` / `REPLICATE_IMAGE_EDIT_MODEL`.
- The model path is returned to the LLM (`modelId`) and rendered in the image
  card caption.
- Registry: 4 JSON defs (`nano-banana`, `flux-1.1-pro`, `flux-schnell`,
  `seedream-4`), each declaring provider field names; `buildModelInput` maps
  generic args onto them.

## Model roster

Researched live from Replicate 2026-07-23 (metadata API + catalog pages).
Exact aspect-ratio enums and per-image costs are pinned from the live schema
during implementation; costs below are approximate.

| Model                                       | Capabilities       | Pools           | Image field      | ~Cost       |
| ------------------------------------------- | ------------------ | --------------- | ---------------- | ----------- |
| `google/nano-banana` (existing)             | gen+edit           | gen, edit       | `image_input[]`  | $0.039      |
| `google/nano-banana-2` (new)                | gen+edit           | gen, edit       | `image_input[]`  | ~$0.05–0.08 |
| `bytedance/seedream-4` (existing)           | gen+edit           | gen, edit       | `image_input[]`  | $0.03       |
| `bytedance/seedream-4.5` (new)              | gen+edit           | gen, edit       | `image_input[]`  | ~$0.04      |
| `bytedance/seedream-5-lite` (new)           | gen+edit           | gen, edit       | `image_input[]`  | ~$0.03      |
| `black-forest-labs/flux-2-pro` (new)        | gen+edit           | gen, edit       | `input_images[]` | ~$0.05–0.06 |
| `black-forest-labs/flux-1.1-pro` (existing) | gen only (demoted) | gen             | n/a              | $0.04       |
| `google/nano-banana-pro` (new)              | gen+edit           | none (premium)  | `image_input[]`  | ~$0.13–0.15 |
| `black-forest-labs/flux-schnell` (existing) | gen only           | none (pin-only) | n/a              | $0.003      |

- `flux-1.1-pro` is demoted from edit: its image conditioning is
  image-prompting, not instruction editing — the weakest editor of the set.
- `flux-schnell` leaves the default path entirely (draft quality would make
  rotation results inconsistent) but stays registered for env pinning.
- `openai/gpt-image-1.5` was evaluated and excluded (requires a separate
  OpenAI API key). `xai/grok-imagine-image` excluded (sub-1K outputs).

Registry model defs gain a `pools: ('generate' | 'edit')[]` field (which
rotations the model participates in) alongside the existing `capabilities`
(what it is allowed to do when pinned or escalated).

## Selection algorithm

Per call, in precedence order:

1. **Env pin** — `REPLICATE_IMAGE_MODEL` / `REPLICATE_IMAGE_EDIT_MODEL`, if
   set and capability-valid (existing warn-and-fall-through behavior kept).
   Pinning disables rotation for that role.
2. **Explicit premium** — tool arg `quality: 'premium'` → `nano-banana-pro`.
3. **Retry escalation** — if this call is a retry (see below) and it is the
   4th consecutive retry in the chat → `nano-banana-pro`, and the retry
   counter resets. Retries 1–3 fall through to rotation.
4. **Round-robin** — Redis `INCR imagegen:rr:<role>` modulo pool size, pool
   ordered by registry order. In-memory counter fallback when Redis is
   unavailable. A global counter guarantees consecutive calls (any user)
   never repeat a model, which is what makes plain retries silently land on a
   different engine.

### Retry tracking

- Tool arg `isRetry: boolean` — set by the researcher when it regenerates
  because the user was dissatisfied with the previous image in this chat.
  The LLM judges "this is a retry" from conversation intent; the server owns
  the escalation threshold.
- Counter: Redis `imagegen:retry:<chatId>`, INCR when `isRetry`, DEL when a
  non-retry generation happens in the chat, TTL 24h. One counter per chat
  (not per role).
- Escalated and explicit-premium calls still count as attempts; an explicit
  `quality: 'premium'` call wins at step 2 regardless of the counter.
- Redis down → escalation silently degrades to rotation (safe: engines still
  vary between attempts).

## Hiding model identity

- The tool's success payload drops `modelId` — the chat LLM never learns the
  engine, so it cannot leak it.
- The image card caption drops the `· model` suffix. Existing chats with
  `modelId` in stored parts simply stop rendering it.
- Tool description gains: the engine is selected automatically and rotates;
  never state or guess which model produced an image; if the user is
  unhappy, generate again with `isRetry: true`.
- Ops traceability: one server log line per generation at persist time —
  chat id, stored filename, model path — so a bad output can be attributed.

## Tool schema changes

```
prompt        string            (unchanged)
baseImageUrl  string, optional  (unchanged)
aspectRatio   enum, optional    (unchanged values)
quality       enum 'standard' | 'premium', optional, default 'standard'
isRetry       boolean, optional, default false
```

## Config surface

- `REPLICATE_IMAGE_MODEL` / `REPLICATE_IMAGE_EDIT_MODEL` semantics change
  from "the model" to "pin override (disables rotation)". Model-manager
  tooltips updated accordingly; `nano-banana-pro` documented as the intended
  premium pin. Model-manager container rebuilt at deploy.
- No new env vars. Rotation pools are code (registry JSONs), not config.

## Budget

Unchanged, count-based (`replicate:budget:YYYY-MM`). Pool average stays
~$0.04/image; premium calls ~3–4x that. Escalation frequency is bounded (at
most 1 premium per 4 retries), so count-based budgeting remains a reasonable
cost proxy.

## Implementation wrinkles

- `flux-2-pro` has no `match_input_image` aspect value (default `1:1`): edit
  calls through it must omit/derive the ratio rather than force `1:1` — per-
  model edit defaults live in its JSON.
- `seedream-4.5` / `seedream-5-lite` use `size` (not `resolution`); defaults
  pinned in JSON to keep per-image cost predictable.
- `nano-banana-2` / `-pro` price by resolution tier; JSON defaults pin 1K/2K
  respectively.
- Output formats differ (flux-2-pro defaults webp); the existing
  extension-based media-type handling in the tool and persist path already
  covers png/jpg/webp/gif.
- Exact aspect-ratio enums and cost notes for the five new models are read
  from the Replicate metadata API (free, read-only) during implementation.

## Testing

- Registry: rotation advance + wraparound; pool filtering by `pools`; env
  pin honored; capability-mismatched pin warns and falls through; Redis-
  absent in-memory fallback.
- Retry: counter increments on `isRetry`, resets on non-retry and after
  escalation; 4th consecutive retry escalates; explicit premium bypasses.
- `buildModelInput`: `input_images` vs `image_input` array shapes; `size` vs
  `resolution` defaults; aspect-ratio mapping incl. edit-path behavior for
  flux-2-pro.
- Tool: success payload has no `modelId`; persist-time log line emitted.
- Component: caption renders without model suffix (new and legacy parts).
- Staging E2E: several spins to observe rotation and one premium-quality
  request (paid calls on the operator-directed token).

## Out of scope

- Per-user model preferences; cost-weighted or quality-weighted rotation;
  automatic bad-output detection (user dissatisfaction is signaled through
  conversation, interpreted by the researcher); dollar-denominated budgets.
