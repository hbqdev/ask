import { tool } from 'ai'
import { promises as fs } from 'node:fs'
import { z } from 'zod'

import { checkImageBudget, recordImageGeneration } from '@/lib/imagegen/budget'
import { persistGeneratedImage } from '@/lib/imagegen/persist-image'
import {
  buildModelInput,
  effectiveImageTask,
  getPremiumModel,
  IMAGE_TASKS,
  type ImageModelDef,
  pickPinnedModel,
  resolveImagePool
} from '@/lib/imagegen/registry'
import {
  type ReplicateResult,
  runReplicatePrediction
} from '@/lib/imagegen/replicate-client'
import { trackRetry } from '@/lib/imagegen/retry-tracker'
import { nextRotationIndex } from '@/lib/imagegen/rotation'
import { resolveUploadUrl } from '@/lib/streaming/helpers/transform-file-parts'

/**
 * Whether the generateImage tool should be offered at all. The caller uses this
 * to decide whether to include the tool in the researcher's toolset; the tool
 * itself does not re-check (a missing token surfaces as an `auth` error from the
 * Replicate client, mapped to a user-facing message below).
 */
export function isImageGenEnabled(): boolean {
  return !!process.env.REPLICATE_API_TOKEN
}

// file extension → data-URI media type for own-upload base images. Anything
// unrecognized falls back to png (matches persist-image.ts's own fallback).
const MEDIA_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml'
}

function mediaTypeForPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? ''
  return MEDIA_TYPE_BY_EXT[ext] ?? 'image/png'
}

// Map a failed prediction to a short, user-appropriate message. Operational
// classes get a fixed line; anything else surfaces the client's own message.
function messageForFailure(
  result: Extract<ReplicateResult, { ok: false }>
): string {
  switch (result.errorClass) {
    case 'auth':
      return 'Image generation is misconfigured (API token rejected).'
    case 'billing':
      return 'The Replicate account is out of credit.'
    case 'content':
      return "The request was rejected by the model's content filter."
    case 'timeout':
      return 'Image generation timed out — try again.'
    default:
      return result.message
  }
}

// Models (notably kimi) paraphrase the enum hints — "high"/"hd" for quality,
// "photography"/"design"/"typography" for task, "square"/"landscape" for aspect
// ratio — which hard-fails Zod validation and forces a wasted first-call retry.
// Coerce the common variants to the real enum; anything unmappable degrades to
// undefined via `.catch` on the schema (every enum field is an optional hint
// with a sane fallback: rotation pool, effectiveImageTask→'general', standard
// tier, preserved aspect). The JSON schema advertised to the model still shows
// the clean enums, so nothing is loosened for well-behaved callers.
const lc = (v: unknown): unknown =>
  typeof v === 'string' ? v.trim().toLowerCase() : v

export function coerceQuality(v: unknown): unknown {
  const s = lc(v)
  if (typeof s !== 'string') return v
  if (['premium', 'high', 'hd', 'ultra', 'max', 'best', '4k', 'top', 'pro'].includes(s))
    return 'premium'
  if (['standard', 'normal', 'medium', 'default', 'low', 'basic'].includes(s))
    return 'standard'
  return s
}

export function coerceTask(v: unknown): unknown {
  const s = lc(v)
  if (typeof s !== 'string') return v
  if (['photoreal', 'photo', 'photograph', 'photography', 'realistic', 'real'].includes(s))
    return 'photoreal'
  if (['illustration', 'illustrated', 'art', 'artwork', 'drawing', 'cartoon', 'anime'].includes(s))
    return 'illustration'
  if (['design-text', 'design', 'typography', 'text', 'poster', 'graphic'].includes(s))
    return 'design-text'
  if (['logo-svg', 'logo', 'svg', 'vector', 'icon'].includes(s)) return 'logo-svg'
  if (['draft-fast', 'draft', 'fast', 'quick', 'rough'].includes(s))
    return 'draft-fast'
  return s // 'general' passes through; anything else → caught to undefined
}

export function coerceAspectRatio(v: unknown): unknown {
  const raw = lc(v)
  if (typeof raw !== 'string') return v
  const s = raw.replace(/\s+/g, '').replace(/[x×]/g, ':')
  const words: Record<string, string> = {
    square: '1:1',
    landscape: '16:9',
    wide: '16:9',
    widescreen: '16:9',
    horizontal: '16:9',
    portrait: '9:16',
    tall: '9:16',
    vertical: '9:16'
  }
  return words[s] ?? s
}

type ResolvedBaseImage = { baseImage: string } | { error: string }

// Resolve a caller-supplied base image URL to what the model should receive.
//
//  - Own uploads (served under /uploads/) are inlined as a data URI read from
//    the local store — we never round-trip them back through our own HTTP
//    surface. Guarded so a user can only reference THEIR OWN uploads.
//  - External https URLs pass through verbatim; Replicate fetches them, we do
//    not (no server-side request to an arbitrary URL — SSRF-safe).
//  - http:// or anything else is rejected without contacting the model.
async function resolveBaseImage(
  baseImageUrl: string,
  userId: string
): Promise<ResolvedBaseImage> {
  // Absolutize against a dummy origin so a relative `/uploads/…` path and an
  // absolute `https://host/uploads/…` URL both parse — resolveUploadUrl itself
  // requires an absolute URL.
  let pathname: string
  let absolute: string
  try {
    const parsed = new URL(baseImageUrl, 'http://localhost')
    pathname = parsed.pathname
    absolute = parsed.href
  } catch {
    return { error: 'That base image URL could not be understood.' }
  }

  // ── Own upload ─────────────────────────────────────────────────────────────
  if (pathname.startsWith('/uploads/')) {
    const resolved = resolveUploadUrl(absolute)
    if (!resolved) {
      return { error: 'That uploaded image could not be located.' }
    }
    const { localPath, objectKey } = resolved

    // User-scope guard mirrors transform-file-parts.ts:63-71 — object keys are
    // `<userId>/…`, so the first path segment is the owning user. `url` is
    // model/client-supplied, so without this a user could reference another
    // user's `/uploads/<victim>/…` file. Reject a foreign key up front — do NOT
    // read the file for a key that isn't the requester's.
    if (objectKey.split('/')[0] !== userId) {
      return { error: 'That image is not one of your uploads.' }
    }

    try {
      const buf = await fs.readFile(localPath)
      const mediaType = mediaTypeForPath(objectKey)
      return {
        baseImage: `data:${mediaType};base64,${buf.toString('base64')}`
      }
    } catch (e) {
      return {
        error: `Could not read the base image: ${(e as Error).message}`
      }
    }
  }

  // ── External https passthrough ─────────────────────────────────────────────
  if (baseImageUrl.startsWith('https://')) {
    return { baseImage: baseImageUrl }
  }

  // ── Everything else (http://, data:, etc.) ─────────────────────────────────
  return {
    error:
      'Unsupported base image URL. Use one of your uploaded images or an https:// URL.'
  }
}

/**
 * Scaffold a raw edit instruction into a "change only X, keep the rest" prompt.
 * Weaker editors otherwise redraw the whole scene from the instruction; this is
 * how ChatGPT-style edits stay faithful — transform the source, preserve the
 * subject's identity, composition, framing, and every unmentioned detail. Only
 * used for the model input; the tool still returns the user's original prompt.
 */
export function buildEditInstruction(instruction: string): string {
  return (
    'Edit the provided image. Keep everything else exactly as it is — the ' +
    'subject and its identity, composition, framing, pose, colours, and ' +
    'lighting, plus every detail not mentioned. Change ONLY the following: ' +
    instruction.trim()
  )
}

/**
 * The generateImage tool. Bound to the current user (for the upload-scope guard
 * and where generated images are stored) and, when present, the current chat
 * (so a generated image is filed as an artifact of that chat).
 *
 * Success: `{ imageUrl, prompt, aspectRatio? }` — model identity is deliberately
 * hidden from the LLM (the ops log line is the only attribution).
 * Failure: `{ error }` — never throws.
 */
export function createGenerateImageTool(userId: string, chatId?: string) {
  return tool({
    description:
      "Generate a new image from a text description, or edit/transform one of the user's uploaded images. Use this whenever the user asks to create, draw, make, design, or edit an image, picture, illustration, logo, or artwork. Write a vivid, specific, visual prompt. To edit an existing uploaded image, pass its exact URL from the attachment context as baseImageUrl. The image engine is selected automatically — never state or guess which model produced an image. Declare `task` as EXACTLY one of: photoreal, illustration, design-text, logo-svg, draft-fast, general. If the user was unhappy with the previous image and wants another go, set isRetry: true; if they explicitly ask for top quality, set quality: 'premium'.",
    inputSchema: z.object({
      prompt: z
        .string()
        .describe(
          'What to generate, or the edit instruction when a base image is provided. Be specific and visual.'
        ),
      baseImageUrl: z
        .string()
        .optional()
        .describe(
          "URL of the user's uploaded image to use as the base for editing/transformation. Use the exact URL from the attachment context."
        ),
      aspectRatio: z
        .preprocess(
          coerceAspectRatio,
          z.enum(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'])
        )
        .optional()
        .catch(undefined)
        .describe(
          'Image shape — exactly one of: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3. Omit to let the engine choose (and to preserve the source shape on edits).'
        ),
      task: z
        .preprocess(coerceTask, z.enum(IMAGE_TASKS))
        .optional()
        .catch(undefined)
        .describe(
          'What kind of image — EXACTLY one of: photoreal, illustration, design-text, logo-svg, draft-fast, general.'
        ),
      quality: z
        .preprocess(coerceQuality, z.enum(['standard', 'premium']))
        .optional()
        .catch(undefined)
        .describe(
          "Exactly 'standard' or 'premium'. Use 'premium' only when the user explicitly asks for top quality; otherwise omit."
        ),
      isRetry: z
        .preprocess(
          v => (v === 'true' ? true : v === 'false' ? false : v),
          z.boolean()
        )
        .optional()
        .catch(undefined)
        .describe(
          'True when regenerating because the user was dissatisfied with the previous image in this chat.'
        )
    }),
    execute: async ({
      prompt,
      baseImageUrl,
      aspectRatio,
      task,
      quality,
      isRetry
    }) => {
      try {
        // 1. Budget — deny before any external call when the month is spent.
        const budget = await checkImageBudget()
        if (!budget.allowed) {
          return {
            error: `Monthly image-generation budget reached (${budget.used}/${budget.budget}). Try again next month.`
          }
        }

        // 2. Resolve the base image (own upload → data URI; https → passthrough;
        //    anything else → error) before deciding the model role.
        let baseImage: string | undefined
        if (baseImageUrl) {
          const resolved = await resolveBaseImage(baseImageUrl, userId)
          if ('error' in resolved) return { error: resolved.error }
          baseImage = resolved.baseImage
        }

        // 3. Select the model: env pin → premium (explicit or 4th consecutive
        //    retry) → task pool round-robin. logo-svg never escalates to
        //    premium (no premium model emits SVG). The retry counter is
        //    tracked on every call so premium attempts count too.
        const role = baseImage ? ('edit' as const) : ('generate' as const)
        const effTask = effectiveImageTask(prompt, task)
        const retry = await trackRetry(
          chatId ?? `user:${userId}`,
          isRetry === true
        )

        let model: ImageModelDef | undefined
        let selection: string
        const pinned = pickPinnedModel(role)
        const premium = getPremiumModel(role)
        if (pinned) {
          model = pinned
          selection = 'pinned'
        } else if (
          (quality === 'premium' || retry.escalate) &&
          effTask !== 'logo-svg' &&
          premium
        ) {
          model = premium
          selection = 'premium'
        } else {
          const pool = resolveImagePool({ role, task, aspectRatio, prompt })
          if (pool.models.length === 0) {
            return { error: 'No image model available for this request.' }
          }
          const idx = await nextRotationIndex(pool.poolKey, pool.models.length)
          model = pool.models[idx]
          selection = pool.poolKey
        }
        // Edits get the "change only X, keep the rest" scaffold so the model
        // transforms the source instead of redrawing it; the returned `prompt`
        // below stays the user's original text.
        const modelPrompt =
          role === 'edit' ? buildEditInstruction(prompt) : prompt
        const input = buildModelInput(model, {
          prompt: modelPrompt,
          baseImage,
          aspectRatio
        })

        // 4. Run the prediction.
        const result = await runReplicatePrediction({
          modelPath: model.modelPath,
          input
        })
        if (!result.ok) return { error: messageForFailure(result) }

        // 5. Persist the rendered image into the user's uploads store.
        const persisted = await persistGeneratedImage({
          sourceUrl: result.outputUrl,
          userId,
          chatId,
          modelPath: model.modelPath
        })
        if ('error' in persisted) return { error: persisted.error }

        // 6. Record the spend only after a fully successful generation.
        await recordImageGeneration()

        // 7. Ops trace — model identity is hidden from the user/LLM, so this
        //    log line is the only attribution for a given output file.
        console.log('[imagegen] generated', {
          chatId: chatId ?? null,
          objectKey: persisted.objectKey,
          model: model.modelPath,
          selection
        })

        // 8. Success — modelId deliberately absent (hidden identity).
        return {
          imageUrl: persisted.publicUrl,
          prompt,
          ...(aspectRatio ? { aspectRatio } : {})
        }
      } catch (e) {
        return {
          error: `Image generation failed: ${e instanceof Error ? e.message : 'unknown error'}`
        }
      }
    }
  })
}
