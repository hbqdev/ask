import fluxPro from './models/flux-1.1-pro.json'
import fluxSchnell from './models/flux-schnell.json'
import nanoBanana from './models/nano-banana.json'
import seedream from './models/seedream-4.json'

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

const MODELS = [nanoBanana, fluxPro, fluxSchnell, seedream] as ImageModelDef[]

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
