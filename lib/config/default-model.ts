import { Model } from '@/lib/types/models'

export const DEFAULT_MODEL: Model = {
  id: 'gpt-5-mini',
  name: 'GPT-5 mini',
  provider: 'OpenAI',
  providerId: 'openai',
  providerOptions: {
    openai: {
      reasoningEffort: 'low',
      reasoningSummary: 'auto'
    }
  }
}
