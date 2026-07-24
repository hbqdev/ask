import { Model } from '@/lib/types/models'

// Self-hosted default: the model cookie-less sessions land on, overridable
// via DEFAULT_CHAT_MODEL in .env (an Ollama model id, e.g. kimi-k2.6:cloud).
// Read at module load — a container restart applies a change, the same
// contract as every other model knob (model-manager apply-with-restart).
// Shape mirrors what buildLocalCookieModel produces for an ollama pick
// (name = model id, think enabled) so a defaulted session behaves
// identically to a chosen one.
const FALLBACK_ID = 'kimi-k2.6:cloud'

function ollamaModel(id: string): Model {
  return {
    id,
    name: id,
    provider: 'Ollama',
    providerId: 'ollama',
    providerOptions: {
      ollama: {
        think: true
      }
    }
  }
}

export const DEFAULT_MODEL: Model = ollamaModel(
  process.env.DEFAULT_CHAT_MODEL?.trim() || FALLBACK_ID
)
