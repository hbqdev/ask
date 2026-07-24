import { Model } from '@/lib/types/models'

// Self-hosted default: the model cookie-less sessions land on. Shape mirrors
// what buildLocalCookieModel produces for an ollama pick (name = model id,
// think enabled) so a defaulted session behaves identically to a chosen one.
export const DEFAULT_MODEL: Model = {
  id: 'kimi-k2.6:cloud',
  name: 'kimi-k2.6:cloud',
  provider: 'Ollama',
  providerId: 'ollama',
  providerOptions: {
    ollama: {
      think: true
    }
  }
}
