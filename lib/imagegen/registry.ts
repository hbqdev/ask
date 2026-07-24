import fluxPro from './models/flux-1.1-pro.json'
import flux2Flex from './models/flux-2-flex.json'
import flux2Klein4b from './models/flux-2-klein-4b.json'
import flux2Klein9b from './models/flux-2-klein-9b.json'
import flux2Max from './models/flux-2-max.json'
import flux2Pro from './models/flux-2-pro.json'
import fluxSchnell from './models/flux-schnell.json'
import gptImage2 from './models/gpt-image-2.json'
import imagen4 from './models/imagen-4.json'
import imagen4Fast from './models/imagen-4-fast.json'
import imagen4Ultra from './models/imagen-4-ultra.json'
import nanoBanana from './models/nano-banana.json'
import nanoBanana2 from './models/nano-banana-2.json'
import nanoBanana2Lite from './models/nano-banana-2-lite.json'
import nanoBananaPro from './models/nano-banana-pro.json'
import seedream45 from './models/seedream-4.5.json'
import seedream from './models/seedream-4.json'
import seedream5Lite from './models/seedream-5-lite.json'
import wan27Image from './models/wan-2.7-image.json'
import wan27ImagePro from './models/wan-2.7-image-pro.json'

export type ImageTask =
  | 'photoreal'
  | 'illustration'
  | 'design-text'
  | 'logo-svg'
  | 'draft-fast'
  | 'general'

export type ImageTier = 'draft' | 'standard' | 'flagship' | 'premium'

export const IMAGE_TASKS = [
  'photoreal',
  'illustration',
  'design-text',
  'logo-svg',
  'draft-fast',
  'general'
] as const satisfies readonly ImageTask[]

export type ImageModelDef = {
  modelPath: string
  capabilities: ('generate' | 'edit')[]
  tier: ImageTier
  categories: ImageTask[]
  promptField: string
  imageField?: string
  imageFieldShape?: 'string' | 'array'
  aspectRatioField?: string
  aspectRatioValues?: string[]
  defaults: Record<string, unknown>
  costNote: string
}

const MODELS = [
  nanoBanana,
  fluxPro,
  fluxSchnell,
  seedream,
  nanoBanana2,
  nanoBanana2Lite,
  nanoBananaPro,
  imagen4,
  imagen4Fast,
  imagen4Ultra,
  flux2Pro,
  flux2Max,
  flux2Flex,
  flux2Klein4b,
  flux2Klein9b,
  seedream45,
  seedream5Lite,
  wan27ImagePro,
  wan27Image,
  gptImage2
] as ImageModelDef[]

const ROLE_ENV: Record<'generate' | 'edit', string> = {
  generate: 'REPLICATE_IMAGE_MODEL',
  edit: 'REPLICATE_IMAGE_EDIT_MODEL'
}

export function listImageModels(): ImageModelDef[] {
  return MODELS
}

/**
 * The task a request should route on: an svg/vector prompt always routes to
 * logo-svg (deterministic guardrail), otherwise the researcher-declared task,
 * otherwise general.
 */
export function effectiveImageTask(
  prompt: string,
  task?: ImageTask
): ImageTask {
  if (/\b(svg|vector)\b/i.test(prompt)) return 'logo-svg'
  return task ?? 'general'
}

/**
 * Env pin: when REPLICATE_IMAGE_MODEL / REPLICATE_IMAGE_EDIT_MODEL names a
 * registered model with the required capability, that model is used and
 * rotation is disabled for the role. Unknown/mismatched pins warn and return
 * null so the caller falls through to rotation.
 */
export function pickPinnedModel(
  role: 'generate' | 'edit',
  models: ImageModelDef[] = MODELS
): ImageModelDef | null {
  const wanted = process.env[ROLE_ENV[role]]
  if (!wanted) return null
  const m = models.find(
    m => m.modelPath === wanted && m.capabilities.includes(role)
  )
  if (m) return m
  console.warn(
    `[imagegen] ${ROLE_ENV[role]}=${wanted} is not ${role}-capable; using rotation`
  )
  return null
}

export function getPremiumModel(
  role: 'generate' | 'edit',
  models: ImageModelDef[] = MODELS
): ImageModelDef | null {
  return (
    models.find(m => m.tier === 'premium' && m.capabilities.includes(role)) ??
    null
  )
}

/**
 * Resolve the rotation pool for a request. Guardrails, in order: svg keyword
 * rewrite (via effectiveImageTask), role capability, draft-tier gating (draft
 * models only via task draft-fast), empty-pool fallback to the role's general
 * pool, and aspect-ratio subset preference.
 */
export function resolveImagePool(
  args: {
    role: 'generate' | 'edit'
    task?: ImageTask
    aspectRatio?: string
    prompt: string
  },
  models: ImageModelDef[] = MODELS
): { poolKey: string; models: ImageModelDef[] } {
  const { role, aspectRatio, prompt } = args
  let task = effectiveImageTask(prompt, args.task)

  const roleCapable = models.filter(
    m => m.tier !== 'premium' && m.capabilities.includes(role)
  )
  let pool = roleCapable.filter(
    m =>
      m.categories.includes(task) &&
      (task === 'draft-fast' ? true : m.tier !== 'draft')
  )
  if (pool.length === 0) {
    // Task yields to correctness: fall back to the role's general pool (for
    // edits, any edit-capable non-draft model qualifies).
    task = 'general'
    pool = roleCapable.filter(
      m =>
        m.tier !== 'draft' &&
        (m.categories.includes('general') || role === 'edit')
    )
  }
  if (aspectRatio) {
    const supporting = pool.filter(m =>
      m.aspectRatioValues?.includes(aspectRatio)
    )
    if (supporting.length > 0) pool = supporting
  }
  return { poolKey: `${role}:${task}`, models: pool }
}

export function buildModelInput(
  model: ImageModelDef,
  args: { prompt: string; baseImage?: string; aspectRatio?: string }
): Record<string, unknown> {
  const input: Record<string, unknown> = { ...model.defaults }
  input[model.promptField] = args.prompt
  if (args.baseImage && model.imageField) {
    input[model.imageField] =
      model.imageFieldShape === 'array' ? [args.baseImage] : args.baseImage
  }
  if (
    args.aspectRatio &&
    model.aspectRatioField &&
    model.aspectRatioValues?.includes(args.aspectRatio)
  ) {
    input[model.aspectRatioField] = args.aspectRatio
  }
  return input
}
