# Image Model Rotation & Task Routing — Design

**Date:** 2026-07-23 (rev 2 — roster expansion + task routing per operator)
**Status:** Approved direction; pending operator spec review

## Goal

Replace the fixed per-role image model defaults with task-aware selection over
a ~27-model 2026-fresh roster: the researcher declares what kind of image the
user wants, the server rotates within the matching pool (with guardrails), and
model identity is hidden from users entirely. The premium model has two dynamic
entry points (explicit quality requests, retry escalation). Users who dislike a
result and retry silently get a different engine.

## Current state

- `generateImage` tool exposes `prompt` / `baseImageUrl` / `aspectRatio`.
- Model choice is server-side: role = `edit` iff a base image resolved, else
  `generate`; one hardcoded default per role (`flux-1.1-pro` generate,
  `nano-banana` edit), overridable deployment-wide via
  `REPLICATE_IMAGE_MODEL` / `REPLICATE_IMAGE_EDIT_MODEL`.
- `modelId` is returned to the LLM and rendered in the image card caption.
- Registry: 4 JSON defs; `buildModelInput` maps generic args onto per-model
  field names.

## Roster (verified live 2026-07-23, Replicate metadata API)

**Inclusion rule (operator):** last model version 2026-01-01 or newer. Applied
retroactively: `seedream-4`, `flux-1.1-pro`, `flux-schnell` leave rotation
(stay registered, pin-only). The whole `flux-kontext` family is 2025 → excluded
(FLUX.2 family covers instruction editing). `flux-2-dev` 2025 → excluded.
`gemini-2.5-flash-image` excluded as a `nano-banana` duplicate.

Tiers: `draft` (speed-first), `standard`, `flagship`, `premium`.
Categories: `photoreal`, `illustration`, `design-text`, `logo-svg`,
`draft-fast`, `general` (edit capability is a schema fact, not a category).

| Model                           | Ver   | Caps     | Tier        | Categories              | Image field         | Prompt field    |
| ------------------------------- | ----- | -------- | ----------- | ----------------------- | ------------------- | --------------- |
| google/nano-banana              | 02-06 | gen+edit | standard    | general                 | `image_input[]`     | prompt          |
| google/nano-banana-2            | 07-21 | gen+edit | flagship    | general, photoreal      | `image_input[]`     | prompt          |
| google/nano-banana-2-lite       | 07-05 | gen+edit | draft       | draft-fast              | `image_input[]`     | prompt          |
| google/imagen-4                 | 02-12 | gen      | flagship    | photoreal               | —                   | prompt          |
| google/imagen-4-fast            | 04-17 | gen      | draft       | draft-fast              | —                   | prompt          |
| google/imagen-4-ultra           | 04-15 | gen      | flagship    | photoreal               | —                   | prompt          |
| bfl/flux-2-pro                  | 03-23 | gen+edit | flagship    | general, photoreal      | `input_images[]`    | prompt          |
| bfl/flux-2-max                  | 03-16 | gen+edit | flagship    | photoreal               | `input_images[]`    | prompt          |
| bfl/flux-2-flex                 | 05-04 | gen+edit | standard    | design-text             | `input_images[]`    | prompt          |
| bfl/flux-2-klein-4b             | 01-15 | gen+edit | draft       | draft-fast              | `images[]`          | prompt          |
| bfl/flux-2-klein-9b             | 01-21 | gen+edit | standard    | general                 | `images[]`          | prompt          |
| bytedance/seedream-4.5          | 06-01 | gen+edit | flagship    | general, photoreal      | `image_input[]`     | prompt          |
| bytedance/seedream-5-lite       | 02-24 | gen+edit | standard    | general, illustration   | `image_input[]`     | prompt          |
| openai/gpt-image-2              | 07-08 | gen+edit | flagship    | general, design-text    | `input_images[]`    | prompt          |
| wan-video/wan-2.7-image-pro     | 04-02 | gen+edit | flagship    | photoreal               | `images[]` + `size` | prompt          |
| wan-video/wan-2.7-image         | 04-02 | gen+edit | standard    | general                 | `images[]` + `size` | prompt          |
| prunaai/p-image                 | 06-19 | gen      | draft       | draft-fast              | —                   | prompt          |
| prunaai/p-image-edit            | 06-22 | edit     | draft       | draft-fast              | `images[]`          | prompt          |
| prunaai/z-image-turbo           | 05-11 | gen      | draft       | draft-fast              | — (no AR)           | prompt          |
| prunaai/z-image                 | 01-27 | gen      | standard    | illustration            | —                   | prompt          |
| prunaai/ernie-image-turbo       | 04-14 | gen      | standard    | illustration            | —                   | prompt          |
| recraft-ai/recraft-v4.1         | 05-11 | gen      | standard    | design-text             | —                   | prompt          |
| recraft-ai/recraft-v4.1-pro     | 05-11 | gen      | flagship    | design-text             | —                   | prompt          |
| recraft-ai/recraft-v4.1-utility | 05-11 | gen      | draft       | draft-fast, design-text | —                   | prompt          |
| recraft-ai/recraft-v4.1-svg     | 05-11 | gen      | standard    | logo-svg                | —                   | prompt          |
| bria/image-3.2                  | 02-05 | gen      | standard    | general, illustration   | —                   | prompt          |
| bria/fibo                       | 02-05 | gen      | standard    | photoreal               | `image`             | prompt          |
| bria/fibo-edit                  | 02-09 | edit     | standard    | general                 | `image`             | **instruction** |
| google/nano-banana-pro          | 07-21 | gen+edit | **premium** | (all)                   | `image_input[]`     | prompt          |

Registered pin-only (out of rotation): `seedream-4`, `flux-1.1-pro`,
`flux-schnell`. Category assignments above are the starting judgment call and
are expected to be tuned with use; they live in the model JSONs.

Notes: wan-video has only two image models (rest of catalog is video) — the
operator's "5 per vendor" target is met where the vendor catalog allows.
`recraft-v4.1-utility-pro` left out (near-duplicate of utility;
run-count 1.7K). Exact aspect-ratio enums, size defaults, and cost notes are
pinned from the metadata API during implementation.

## Selection algorithm (Design 3: task enum + server guardrails)

Tool schema:

```
prompt        string                                      (unchanged)
baseImageUrl  string, optional                            (unchanged)
aspectRatio   enum, optional                              (unchanged values)
task          enum photoreal | illustration | design-text |
              logo-svg | draft-fast | general, optional   (researcher-declared)
quality       enum standard | premium, optional
isRetry       boolean, optional
```

Per call, the server resolves a **candidate pool**, then round-robins:

1. **Env pin** — `REPLICATE_IMAGE_MODEL` / `REPLICATE_IMAGE_EDIT_MODEL` wins
   if set and capability-valid (existing warn-and-fall-through kept). Pinning
   disables rotation for that role.
2. **Premium** — `quality: 'premium'`, or 4th consecutive retry (below) →
   `nano-banana-pro`. Exception: `task: 'logo-svg'` skips premium (no premium
   model emits SVG) and falls through to the svg pool.
3. **Pool resolution + guardrails** —
   a. Base pool: models whose `categories` include `task`; no/`general` task →
   the default pool = `general`-tagged standard+flagship models (draft-tier
   models are ONLY reachable via `task: 'draft-fast'` — they never pollute
   default requests).
   b. Edit constraint: when `baseImageUrl` resolved, intersect with
   edit-capable; if the intersection is empty, use the full edit-capable
   standard+flagship set (task yields to correctness).
   c. Aspect-ratio filter: if `aspectRatio` given, prefer the subset
   supporting it; empty subset → keep pool, ratio is dropped per-model as
   today.
   d. SVG keyword guardrail: prompt matching /\b(svg|vector)\b/i routes to the
   `logo-svg` pool even without the task param (deterministic, tested).
4. **Round-robin** — Redis `INCR imagegen:rr:<poolKey>` mod pool size,
   pool ordered by registry order; `poolKey` = resolved pool id (e.g.
   `generate:photoreal`, `edit:default`). In-memory counter fallback when
   Redis is unavailable. Consecutive calls on the same pool never repeat a
   model, which is what makes plain retries land on a different engine.

### Retry tracking

- `isRetry: true` set by the researcher when regenerating because the user was
  dissatisfied with the previous image in this chat. LLM judges intent; server
  owns the threshold.
- Redis `imagegen:retry:<chatId>`: INCR on retry, DEL on non-retry generation,
  TTL 24h, one counter per chat. Retries 1–3 → rotation; 4th → premium, then
  reset. Explicit `quality: 'premium'` wins regardless of the counter.
- Redis down → escalation degrades to plain rotation.

## Hiding model identity

- Tool success payload drops `modelId`; the LLM cannot leak what it never
  learns. Image card caption drops the `· model` suffix (legacy parts with
  modelId simply stop rendering it).
- Tool description: engine is selected automatically and rotates; never state
  or guess which model produced an image; on user dissatisfaction, call again
  with `isRetry: true`; declare `task` from the user's intent.
- Ops traceability: one server log line per generation at persist time — chat
  id, stored filename, model path, resolved poolKey.

## Config surface

- Pin vars keep their names; semantics documented as "pin override (disables
  rotation)". Model-manager tooltips updated; container rebuilt at deploy.
- No new env vars; pools/categories/tiers are code (registry JSONs).

## Budget

Unchanged, count-based (`replicate:budget:YYYY-MM`). Per-image cost now spans
~$0.001 (z-image-turbo) to ~$0.15 (nano-banana-pro); default-pool average
~$0.04. Count-based budgeting stays a rough cost proxy; dollar-denominated
budgets noted as future work.

## Implementation wrinkles

- `bria/fibo-edit` prompts via `instruction` (registry `promptField` covers
  this). `wan-2.7-*` and seedreams size via `size`; flux-2 family via
  `resolution`; JSON `defaults` pin each to a ~1–2K tier for cost
  predictability.
- `z-image-turbo` has no aspect-ratio field → excluded by the AR filter
  whenever a ratio is requested.
- `gpt-image-2`: `openai_api_key` is optional per schema — leave unset (bills
  through Replicate); its `quality` input pinned in defaults. Latency is the
  highest in the roster (~30–90s); acceptable in rotation per operator.
- Output formats vary (webp/jpg/png/svg); existing extension-based media-type
  handling covers raster; **SVG persistence** needs `image/svg+xml` added to
  the media-type map and the uploads route content-type handling verified.
- One-spin staging verification for gpt-image-2 (no-key billing) and one svg
  generation (persist + render path) during E2E.
- Registry JSONs for 25 new models are generated from the metadata API
  (schema-derived field names + AR enums), then hand-tuned for categories.

## Testing

- Pool resolution: category filtering, draft-tier gating, edit intersection +
  fallback, AR subset preference, SVG keyword guardrail, logo-svg premium
  skip.
- Rotation: advance/wraparound per poolKey; distinct poolKeys independent;
  Redis-absent in-memory fallback.
- Retry: increments/resets/escalation at 4; explicit premium bypass.
- `buildModelInput`: field-name matrix across the five image-field shapes
  (`image_input[]`, `input_images[]`, `images[]`, `image`, none) and
  `instruction` prompt field; `size` vs `resolution` defaults.
- Tool: `modelId` absent from success payload; persist log line emitted.
- Component: caption without model suffix (new + legacy parts).
- Staging E2E: rotation observation across ≥3 spins, one premium request, one
  gpt-image-2 spin, one svg spin (paid calls on the operator-directed token).

## Phase 2 (explicitly out of v1)

Mask/canvas/promptless operations — `bria/genfill`, `bria/expand-image`,
`bria/eraser`, `bria/remove-background`, `bria/increase-resolution`,
`flux-fill-pro`, recraft upscalers/vectorize — likely a separate tool with its
own contract. Also out: per-user model preferences, cost-weighted rotation,
automatic bad-output detection, dollar budgets.
