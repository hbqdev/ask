import { createAnthropic } from '@ai-sdk/anthropic'
import { createGateway } from '@ai-sdk/gateway'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createProviderRegistry, LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'

import { createTimeoutFetch } from './fetch-with-timeout'

// Strip a trailing /v1 from the configured base URL, then re-append it,
// so both shapes work for OpenAI-compatible hosts:
//   OPENAI_COMPATIBLE_API_BASE_URL=https://api.deepseek.com
//   OPENAI_COMPATIBLE_API_BASE_URL=https://api.deepseek.com/v1
function normalizeOpenAICompatibleBaseURL(raw: string): string {
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1'
}

// A per-request hard timeout on the actual HTTP call to each model
// provider — see createTimeoutFetch's own comment for why this (rather
// than relying on the abortSignal passed into a ToolLoopAgent's .stream())
// is what actually guarantees a stuck request can't hang forever. Kept in
// sync with GENERATION_TIMEOUT_MS in app/api/chat/route.ts.
const providerFetch = createTimeoutFetch(300_000)

// Build providers object conditionally. Each provider is constructed via
// its create*() factory (rather than the default singleton export) so the
// shared timeout-enforcing fetch above can be injected.
const providers: Record<string, any> = {
  openai: createOpenAI({ fetch: providerFetch }),
  anthropic: createAnthropic({ fetch: providerFetch }),
  google: createGoogleGenerativeAI({ fetch: providerFetch }),
  'openai-compatible': createOpenAICompatible({
    // Keep the SDK provider key stable. OPENAI_COMPATIBLE_PROVIDER_NAME is
    // only a UI label used by the model selector.
    name: 'openai-compatible',
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
    baseURL: normalizeOpenAICompatibleBaseURL(
      process.env.OPENAI_COMPATIBLE_API_BASE_URL || ''
    ),
    fetch: providerFetch
  }),
  gateway: createGateway({
    apiKey: process.env.AI_GATEWAY_API_KEY,
    fetch: providerFetch
  })
}

// Only add Ollama if OLLAMA_BASE_URL is configured
const ollamaProvider = process.env.OLLAMA_BASE_URL
  ? createOllama({ baseURL: process.env.OLLAMA_BASE_URL, fetch: providerFetch })
  : null

if (ollamaProvider) {
  providers.ollama = ollamaProvider
}

export const registry = createProviderRegistry(providers)

export function getModel(
  model: string,
  abortSignal?: AbortSignal
): LanguageModel {
  // For Ollama models, bypass the registry to pass model-level settings
  // that ai-sdk-ollama requires (think, supportedUrls override).
  if (model.startsWith('ollama:') && ollamaProvider) {
    const modelId = model.slice('ollama:'.length)

    // ai-sdk-ollama drops the AI SDK's per-call abortSignal on the floor
    // (its doStream() never forwards options.abortSignal to the ollama
    // client's chat() call) — confirmed by reading its source. The shared
    // providerFetch above still enforces the 300s ceiling, but a client
    // disconnect wouldn't otherwise cut an Ollama request short like it
    // does for the other providers. Building a request-scoped client here
    // (cheap — no persistent connection state, undici pools by host
    // regardless of which client object issues the fetch) lets the actual
    // request's abortSignal reach the real HTTP call.
    const provider = abortSignal
      ? createOllama({
          baseURL: process.env.OLLAMA_BASE_URL,
          fetch: createTimeoutFetch(300_000, abortSignal)
        })
      : ollamaProvider

    const lm = provider(modelId, { think: true })

    // Ollama's Chat API only accepts base64 in the images field, not URLs.
    // Override supportedUrls to force AI SDK to download images and convert
    // them to base64 before sending to the model.
    Object.defineProperty(lm, 'supportedUrls', {
      value: {},
      configurable: true
    })

    return lm
  }

  return registry.languageModel(
    model as Parameters<typeof registry.languageModel>[0]
  )
}

export function isProviderEnabled(providerId: string): boolean {
  switch (providerId) {
    case 'openai':
      return !!process.env.OPENAI_API_KEY
    case 'anthropic':
      return !!process.env.ANTHROPIC_API_KEY
    case 'google':
      return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY
    case 'openai-compatible':
      return (
        !!process.env.OPENAI_COMPATIBLE_API_KEY &&
        !!process.env.OPENAI_COMPATIBLE_API_BASE_URL
      )
    case 'gateway':
      return !!process.env.AI_GATEWAY_API_KEY
    case 'ollama':
      return !!process.env.OLLAMA_BASE_URL
    default:
      return false
  }
}
