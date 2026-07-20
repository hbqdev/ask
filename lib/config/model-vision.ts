// Whether an answering model can accept image input directly.
//
// Attached images always get VLM-extracted text at ingestion. At answer
// time we choose per model: a vision-capable model receives the raw image
// (its own vision, preferred); every other model falls back to that
// extracted text. Getting this wrong in one direction is far worse than the
// other — sending an image to a text-only model makes the provider reject
// the entire turn, while a vision model that only gets text still answers.
// So detection is deliberately CONSERVATIVE: an explicit `vision` flag wins,
// and otherwise only well-known multimodal families match. Anything unknown
// is treated as text-only (the safe fallback).

const VISION_ID_PATTERNS: RegExp[] = [
  /gemini-[0-9]/, // Gemini 1.5+/2/3 — all multimodal
  /gpt-4o/,
  /gpt-4\.1/,
  /gpt-5/,
  /^o[134](\b|-)/, // OpenAI o1/o3/o4 reasoning models accept images
  /claude-3/,
  /claude-(sonnet|opus|haiku)-[0-9]/, // Claude 4+ naming
  /-vl\b/, // qwen-vl and similar
  /vision/,
  /llava/,
  /pixtral/,
  /minicpm-v/
]

export function modelSupportsVision(model: {
  id: string
  vision?: boolean
}): boolean {
  if (typeof model.vision === 'boolean') return model.vision
  const id = model.id.toLowerCase()
  return VISION_ID_PATTERNS.some(p => p.test(id))
}
