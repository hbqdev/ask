import fluxPro from './models/flux-1.1-pro.json'
import fluxSchnell from './models/flux-schnell.json'
import nanoBanana from './models/nano-banana.json'
import seedream from './models/seedream-4.json'

export type ImageModelDef = {
  modelPath: string
  capabilities: ('generate' | 'edit')[]
  promptField: string
  imageField?: string
  imageFieldShape?: 'string' | 'array'
  aspectRatioField?: string
  aspectRatioValues?: string[]
  defaults: Record<string, unknown>
  costNote: string
}

const MODELS = [nanoBanana, fluxPro, fluxSchnell, seedream] as ImageModelDef[]

const ROLE_DEFAULTS: Record<'generate' | 'edit', string> = {
  generate: 'black-forest-labs/flux-1.1-pro',
  edit: 'google/nano-banana'
}
const ROLE_ENV: Record<'generate' | 'edit', string> = {
  generate: 'REPLICATE_IMAGE_MODEL',
  edit: 'REPLICATE_IMAGE_EDIT_MODEL'
}

export function listImageModels(): ImageModelDef[] {
  return MODELS
}

export function getImageModel(role: 'generate' | 'edit'): ImageModelDef {
  const wanted = process.env[ROLE_ENV[role]]
  const pick = (path: string) =>
    MODELS.find(m => m.modelPath === path && m.capabilities.includes(role))
  // An override that names an unknown or capability-mismatched model is
  // ignored (with a warn) rather than breaking the tool.
  if (wanted) {
    const m = pick(wanted)
    if (m) return m
    console.warn(
      `[imagegen] ${ROLE_ENV[role]}=${wanted} is not ${role}-capable; using default`
    )
  }
  return pick(ROLE_DEFAULTS[role])!
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
