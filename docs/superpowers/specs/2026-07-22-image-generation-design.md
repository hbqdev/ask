# Image Generation via Replicate — Design

## Goal

Generate and edit images from the chat, ChatGPT-style: ask in natural
language mid-conversation, and — the priority use case — attach an image
and use it as the base for transformed outputs (restyle, remix, edit).
Provider: Replicate.

## Decisions (settled in brainstorm)

- Fresh curated 2026 model set; the old `selfhosted/image-gen` app's list
  is not ported. Video models are out of scope.
- The chat LLM auto-picks the model class (edit vs. generate); no model
  picker UI. Defaults are env-configurable.
- `REPLICATE_API_TOKEN` is operator-set in the gitignored `.env`. The
  feature is entirely absent when the token is unset.

## Architecture

### 1. Replicate client — `lib/imagegen/replicate-client.ts`

Server-only. Creates predictions via
`POST /v1/models/{owner}/{name}/predictions` with `Prefer: wait` (sync up
to ~60s); when the response is still processing, polls
`GET /v1/predictions/{id}` until terminal, bounded by
`REPLICATE_TIMEOUT_MS` (default 120000). Bearer auth. Distinguishes error
classes in its return type: auth failure, billing/credit failure, content
rejection, timeout, model error — the tool relays these differently to
the user.

### 2. Model registry — `lib/imagegen/models/*.json` + `registry.ts`

The old app's best idea, ported: each model is a checked-in JSON file
carrying `modelPath`, a `capabilities` array (`"generate"`, `"edit"`, or
both — dual models like nano-banana and seedream-4 list both), the
model's input schema (fetched from the live Replicate API during
implementation, not hand-written), our default parameter values, and a
cost-per-image note. `registry.ts` loads and validates the files and
resolves the active defaults from `REPLICATE_IMAGE_MODEL` /
`REPLICATE_IMAGE_EDIT_MODEL`, enforcing that each slot's model lists the
matching capability. Both slots may point at the same dual-capability
model (the one-model-does-everything setup).

v1 registry: `google/nano-banana` (edit default),
`black-forest-labs/flux-1.1-pro` (generate default),
`black-forest-labs/flux-schnell` (cheap/fast alternative),
`bytedance/seedream-4` (available, not default).

The registry translates the tool's simplified inputs (prompt, aspect
ratio, base image) into each model's real parameter names — the LLM never
sees model names or per-model schemas.

### 3. The tool — `lib/tools/generate-image.ts`

`generateImage` joins the researcher's tools object (same registration
as search/fetch/weather). Zod schema, deliberately minimal so small
local models call it correctly:

- `prompt: string` — description or edit instruction (required)
- `baseImageUrl?: string` — the user's uploaded image to transform
- `aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | '3:2' | '2:3'`

Model choice: `baseImageUrl` present → edit default; absent → generate
default. Base image resolution: our own upload URLs resolve through the
existing `resolveUploadUrl` machinery to a data URI; public `https` URLs
pass through untouched for Replicate to fetch (we never fetch foreign
URLs server-side — no SSRF surface). Anything else is rejected.

On success the tool downloads the output image, persists it (below), and
returns `{ imageUrl, modelId, prompt, aspectRatio }`. On failure it
returns `{ error }` with a user-appropriate message so the model can
explain rather than hallucinate an image.

### 4. Persistence

Replicate delivery URLs expire (~1 hour), so outputs are downloaded
immediately and stored in the existing uploads storage under a
`generated/` object-key prefix, with a files-table row so the existing
file-serving route serves them. Two required properties:

- **Excluded from the idle-upload TTL sweep** (`expireIdleUploads`) —
  generated images are chat content and must survive `UPLOAD_TTL_DAYS`.
- Shared-chat visibility follows the same behavior as uploaded
  attachments (parity, verified during implementation).

### 5. Rendering

`tool-generateImage` parts are NOT buffered into the research-process
accordion — `render-message` gives them the same standalone carve-out as
`dynamic-tool`, so images display prominently in the message flow.

New `components/generated-image-section.tsx`:

- running → skeleton card with the prompt as caption
- done → full-width image card, caption (model + prompt), click for full
  size
- error → compact error card

`endsInActiveResearch` already counts `tool-*` parts as live research,
so the footer glyph yields while generating; the skeleton card is the
visible activity cue. No changes to the indicator system.

### 6. Prompting and classifier

- Researcher system prompt: when the user asks for an image, call
  `generateImage`; when they attached an image and ask for a
  transformation, pass its URL as `baseImageUrl`; image requests don't
  need web search unless the request itself does.
- The attachments context must expose each attachment's URL in a form
  the model can echo back as `baseImageUrl` (verified during
  implementation; added if missing).
- Classifier: verify pure image requests classify as skip-search;
  adjust the classifier prompt if they don't.

### 7. Budget guard

Optional `REPLICATE_MONTHLY_BUDGET` — a per-month generation count in
Redis (`replicate:budget:YYYY-MM`), same pattern as the Tavily budget:
increment on success, skip generation with a clear tool error when the
budget is exhausted, fail closed on Redis errors. Unset or 0 = no limit.

### 8. Environment

- `REPLICATE_API_TOKEN` — required; tool unregistered when absent
- `REPLICATE_IMAGE_MODEL` — default `black-forest-labs/flux-1.1-pro`
- `REPLICATE_IMAGE_EDIT_MODEL` — default `google/nano-banana`
- `REPLICATE_MONTHLY_BUDGET` — optional cap, unset = unlimited
- `REPLICATE_TIMEOUT_MS` — default 120000

All five get model-manager env-registry entries. The two model slots
register as dropdowns enumerating the registry's model paths, filtered
by capability (edit slot lists only `edit`-capable models, generate slot
only `generate`-capable), so an invalid assignment cannot be saved.

## Out of scope (v1)

Video models, inpainting/masks, multiple outputs per call, a
model-picker UI, generation from the Discover/Library surfaces.

## Testing

- Unit: client (wait-mode, poll fallback, each error class — mocked
  fetch); registry loading/validation/env overrides; tool execute
  (mocked client + storage) including URL-resolution rejection cases;
  TTL-sweep exclusion; rendering states (skeleton/done/error);
  regression: research-indicator behavior unchanged.
- Staging E2E: exactly two real generations — one text-to-image via
  `flux-schnell` (~$0.003, doubles as the credit probe) and one edit via
  `nano-banana` (~$0.039) with an uploaded base image. These run on the
  operator's personal Replicate token, temporarily swapped into `.env`
  for the test window and restored afterwards.
- Prod ship only on explicit approval, per the established workflow.
