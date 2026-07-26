// Base URL for helpers that need a LOCAL Ollama model.
//
// These used to piggyback on CLASSIFIER_OLLAMA_BASE_URL, which was fine while
// the classifier ran granite4.1:8b on Serenity. Moving the classifier to
// glm-5.2:cloud repointed that variable at the main host, which has NO local
// models — so the memory extractor and the fallback expander started asking a
// host with zero local models for granite4.1:8b. Both fail quietly (try/catch
// and a [] return), so memory extraction silently stopped working.
//
// Resolved independently now, so a classifier change can never move them again.
export function localLlmBaseUrl(): string | undefined {
  return (
    process.env.LOCAL_LLM_BASE_URL ||
    // Back-compat: only useful when the classifier is itself a local model.
    (process.env.CLASSIFIER_MODEL_ID?.endsWith(':cloud')
      ? undefined
      : process.env.CLASSIFIER_OLLAMA_BASE_URL) ||
    process.env.OLLAMA_BASE_URL
  )
}

/** Warming only makes sense for a local model — a cloud one has no GPU to wake. */
export function isCloudModel(modelId?: string): boolean {
  return Boolean(modelId?.endsWith(':cloud'))
}
