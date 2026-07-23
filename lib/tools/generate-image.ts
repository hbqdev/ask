import { tool } from 'ai'
import { promises as fs } from 'node:fs'
import { z } from 'zod'

import { checkImageBudget, recordImageGeneration } from '@/lib/imagegen/budget'
import { persistGeneratedImage } from '@/lib/imagegen/persist-image'
import { buildModelInput, getImageModel } from '@/lib/imagegen/registry'
import {
  type ReplicateResult,
  runReplicatePrediction
} from '@/lib/imagegen/replicate-client'
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
  gif: 'image/gif'
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
 * The generateImage tool. Bound to the current user (for the upload-scope guard
 * and where generated images are stored) and, when present, the current chat
 * (so a generated image is filed as an artifact of that chat).
 *
 * Success: `{ imageUrl, modelId, prompt, aspectRatio? }`.
 * Failure: `{ error }` — never throws.
 */
export function createGenerateImageTool(userId: string, chatId?: string) {
  return tool({
    description:
      "Generate a new image from a text description, or edit/transform one of the user's uploaded images. Use this whenever the user asks to create, draw, make, design, or edit an image, picture, illustration, logo, or artwork. Write a vivid, specific, visual prompt. To edit an existing uploaded image, pass its exact URL from the attachment context as baseImageUrl.",
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
        .enum(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'])
        .optional()
    }),
    execute: async ({ prompt, baseImageUrl, aspectRatio }) => {
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

        // 3. Pick the model role and build its provider-specific input.
        const model = getImageModel(baseImage ? 'edit' : 'generate')
        const input = buildModelInput(model, { prompt, baseImage, aspectRatio })

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

        // 7. Success.
        return {
          imageUrl: persisted.publicUrl,
          modelId: model.modelPath,
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
