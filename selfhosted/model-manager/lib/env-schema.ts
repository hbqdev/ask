export type Category =
  | 'models' | 'search' | 'database' | 'auth' | 'memory' | 'storage' | 'infra'

export const CATEGORIES: Category[] = [
  'models', 'search', 'database', 'auth', 'memory', 'storage', 'infra'
]

export type FieldType =
  | 'url' | 'model' | 'model-list' | 'secret' | 'bool' | 'int' | 'enum' | 'string'

export interface EnvVarSpec {
  key: string
  category: Category
  group?: string
  label: string
  type: FieldType
  help?: string
  default?: string
  required?: boolean
  enumValues?: string[]
  validate?: (v: string) => string | null
  target?: 'ask' | 'reranker' // default 'ask'
  testable?: 'ollama' | 'reranker' | 'http'
}

// --- shared validators ---
const url = (v: string): string | null =>
  /^https?:\/\/.+/.test(v.trim()) ? null : 'Must be an http(s) URL'
const int = (v: string): string | null =>
  /^-?\d+$/.test(v.trim()) ? null : 'Must be an integer'
const num = (v: string): string | null =>
  /^-?\d+(\.\d+)?$/.test(v.trim()) ? null : 'Must be a number'
const bool = (v: string): string | null =>
  /^(true|false)$/.test(v.trim()) ? null : 'Must be true or false'
const nonEmpty = (v: string): string | null =>
  v.trim().length ? null : 'Required'

export const REGISTRY: EnvVarSpec[] = [
  // ---------- Models: Chat ----------
  { key: 'OLLAMA_BASE_URL', category: 'models', group: 'Chat', label: 'Chat host', type: 'url', validate: url, testable: 'ollama', help: 'Main Ollama LLM host.' },
  { key: 'NEXT_PUBLIC_OLLAMA_BASE_URL', category: 'models', group: 'Chat', label: 'Chat host (client)', type: 'url', validate: url, help: 'Client-exposed copy; usually mirrors OLLAMA_BASE_URL.' },
  { key: 'OLLAMA_MODELS', category: 'models', group: 'Chat', label: 'Chat model list', type: 'model-list', help: 'Cloud models not shown by /api/tags. Add / remove / reorder.' },
  { key: 'OLLAMA_EMBED_MODEL', category: 'models', group: 'Chat', label: 'Ollama embed model', type: 'model', help: 'Optional Ollama-side embedding model.' },
  // ---------- Models: Cloud providers ----------
  { key: 'OPENAI_API_KEY', category: 'models', group: 'Cloud providers', label: 'OpenAI API key', type: 'secret' },
  { key: 'ANTHROPIC_API_KEY', category: 'models', group: 'Cloud providers', label: 'Anthropic API key', type: 'secret' },
  { key: 'GOOGLE_GENERATIVE_AI_API_KEY', category: 'models', group: 'Cloud providers', label: 'Google GenAI API key', type: 'secret' },
  { key: 'AI_GATEWAY_API_KEY', category: 'models', group: 'Cloud providers', label: 'AI Gateway key', type: 'secret' },
  { key: 'OPENAI_COMPATIBLE_API_KEY', category: 'models', group: 'Cloud providers', label: 'OpenAI-compatible key', type: 'secret' },
  { key: 'OPENAI_COMPATIBLE_API_BASE_URL', category: 'models', group: 'Cloud providers', label: 'OpenAI-compatible base URL', type: 'url', validate: url },
  { key: 'OPENAI_COMPATIBLE_PROVIDER_NAME', category: 'models', group: 'Cloud providers', label: 'OpenAI-compatible label', type: 'string' },
  { key: 'OPENAI_COMPATIBLE_MODELS', category: 'models', group: 'Cloud providers', label: 'OpenAI-compatible models', type: 'model-list' },
  // ---------- Models: Serenity ----------
  { key: 'CLASSIFIER_OLLAMA_BASE_URL', category: 'models', group: 'Serenity', label: 'Serenity host', type: 'url', validate: url, testable: 'ollama', help: 'Classifier/expander/extractor Ollama host (falls back to Chat host).' },
  { key: 'CLASSIFIER_MODEL_ID', category: 'models', group: 'Serenity', label: 'Classifier model', type: 'model', default: 'granite4.1:8b' },
  { key: 'EXPANDER_MODEL_ID', category: 'models', group: 'Serenity', label: 'Query-expander model', type: 'model', default: 'granite4.1:8b' },
  { key: 'MEMORY_EXTRACTOR_MODEL_ID', category: 'models', group: 'Serenity', label: 'Memory-extractor model', type: 'model', default: 'granite4.1:8b' },
  // ---------- Models: Embeddings ----------
  { key: 'EMBEDDING_MODEL', category: 'models', group: 'Embeddings', label: 'Embedding model', type: 'enum', enumValues: ['Xenova/all-MiniLM-L6-v2', 'mixedbread-ai/mxbai-embed-large-v1', 'Xenova/nomic-embed-text-v1'], help: 'Local ONNX embeddings. Changing dimension affects the memory/recall schema.' },
  { key: 'MODEL_CACHE_DIR', category: 'models', group: 'Embeddings', label: 'Model cache dir', type: 'string' },
  // ---------- Models: Reranker ----------
  { key: 'RERANKER_URL', category: 'models', group: 'Reranker', label: 'Reranker URL (Ask → reranker)', type: 'url', validate: url, testable: 'reranker', target: 'ask' },
  { key: 'RERANKER_API_TOKEN', category: 'models', group: 'Reranker', label: 'Reranker API token', type: 'secret', target: 'ask' },
  { key: 'RERANKER_MODEL', category: 'models', group: 'Reranker', label: 'Reranker model (on nightfuryS)', type: 'model', default: 'BAAI/bge-reranker-v2-m3', target: 'reranker', help: 'Applied over SSH; a change re-downloads weights (slow).' },

  // ---------- Search ----------
  { key: 'SEARCH_API', category: 'search', label: 'Search backend', type: 'enum', enumValues: ['searxng', 'tavily', 'exa', 'brave'] },
  { key: 'SEARXNG_API_URL', category: 'search', group: 'SearXNG', label: 'SearXNG URL', type: 'url', validate: url },
  { key: 'SEARXNG_FALLBACK_API_URL', category: 'search', group: 'SearXNG', label: 'SearXNG fallback URL', type: 'url', validate: url },
  { key: 'NEXT_PUBLIC_SEARXNG_URL', category: 'search', group: 'SearXNG', label: 'SearXNG URL (client)', type: 'url', validate: url },
  { key: 'SEARXNG_SECRET', category: 'search', group: 'SearXNG', label: 'SearXNG secret', type: 'secret' },
  { key: 'SEARXNG_ENGINES', category: 'search', group: 'SearXNG', label: 'Engines', type: 'string' },
  { key: 'SEARXNG_MAX_RESULTS', category: 'search', group: 'SearXNG', label: 'Max results', type: 'int', validate: int },
  { key: 'SEARXNG_DEFAULT_DEPTH', category: 'search', group: 'SearXNG', label: 'Default depth', type: 'string' },
  { key: 'SEARXNG_TIME_RANGE', category: 'search', group: 'SearXNG', label: 'Time range', type: 'string' },
  { key: 'SEARXNG_SAFESEARCH', category: 'search', group: 'SearXNG', label: 'Safesearch', type: 'int', validate: int },
  { key: 'SEARXNG_CRAWL_MULTIPLIER', category: 'search', group: 'SearXNG', label: 'Crawl multiplier', type: 'int', validate: int },
  { key: 'CRAWL4AI_URL', category: 'search', group: 'Crawl', label: 'Crawl4AI URL', type: 'url', validate: url },
  { key: 'CRAWL4AI_API_TOKEN', category: 'search', group: 'Crawl', label: 'Crawl4AI token', type: 'secret' },
  { key: 'FLARESOLVERR_URL', category: 'search', group: 'Crawl', label: 'FlareSolverr URL', type: 'url', validate: url },
  { key: 'FIRECRAWL_API_KEY', category: 'search', group: 'Crawl', label: 'Firecrawl key', type: 'secret' },
  { key: 'DEGOOG_API_URL', category: 'search', group: 'Degoog', label: 'Degoog URL', type: 'url', validate: url },
  { key: 'DEGOOG_API_KEY', category: 'search', group: 'Degoog', label: 'Degoog key', type: 'secret' },
  { key: 'TAVILY_API_KEY', category: 'search', group: 'Providers', label: 'Tavily key', type: 'secret' },
  { key: 'EXA_API_KEY', category: 'search', group: 'Providers', label: 'Exa key', type: 'secret' },
  { key: 'BRAVE_SEARCH_API_KEY', category: 'search', group: 'Providers', label: 'Brave key', type: 'secret' },
  { key: 'JINA_API_KEY', category: 'search', group: 'Providers', label: 'Jina key', type: 'secret' },
  { key: 'OLLAMA_SEARCH_API_KEY', category: 'search', group: 'Ollama search', label: 'Ollama search key', type: 'secret' },
  { key: 'OLLAMA_SEARCH_ENABLED', category: 'search', group: 'Ollama search', label: 'Ollama search enabled', type: 'bool', validate: bool },
  { key: 'OLLAMA_SEARCH_MAX_RESULTS', category: 'search', group: 'Ollama search', label: 'Ollama search max results', type: 'int', validate: int },
  { key: 'OLLAMA_SEARCH_TIMEOUT_MS', category: 'search', group: 'Ollama search', label: 'Ollama search timeout (ms)', type: 'int', validate: int },

  // ---------- Database ----------
  { key: 'DATABASE_URL', category: 'database', label: 'Database URL', type: 'secret', validate: nonEmpty },
  { key: 'DATABASE_RESTRICTED_URL', category: 'database', label: 'Restricted DB URL', type: 'secret' },
  { key: 'DATABASE_SSL_DISABLED', category: 'database', label: 'Disable DB SSL', type: 'bool', validate: bool },
  { key: 'POSTGRES_USER', category: 'database', label: 'Postgres user', type: 'string' },
  { key: 'POSTGRES_PASSWORD', category: 'database', label: 'Postgres password', type: 'secret' },
  { key: 'POSTGRES_DB', category: 'database', label: 'Postgres db', type: 'string' },

  // ---------- Auth ----------
  { key: 'ENABLE_AUTH', category: 'auth', label: 'Enable auth', type: 'bool', validate: bool },
  { key: 'ANONYMOUS_USER_ID', category: 'auth', label: 'Anonymous user id', type: 'string' },
  { key: 'NEXT_PUBLIC_SUPABASE_URL', category: 'auth', label: 'Supabase URL', type: 'url', validate: url },
  { key: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', category: 'auth', label: 'Supabase publishable key', type: 'string' },
  { key: 'SUPABASE_SECRET_KEY', category: 'auth', label: 'Supabase secret key', type: 'secret' },

  // ---------- Memory / recall ----------
  { key: 'MEMORY_ENABLED', category: 'memory', label: 'Memory enabled', type: 'bool', validate: bool },
  { key: 'MEMORY_SIM_THRESHOLD', category: 'memory', label: 'Memory sim threshold', type: 'string', validate: num },
  { key: 'MEMORY_GRADUATE_SIGHTINGS', category: 'memory', label: 'Graduate sightings', type: 'int', validate: int },
  { key: 'MEMORY_MAX_PER_USER', category: 'memory', label: 'Max per user', type: 'int', validate: int },
  { key: 'MEMORY_INJECT_TOP_K', category: 'memory', label: 'Inject top-K', type: 'int', validate: int },
  { key: 'MEMORY_CRON_SECRET', category: 'memory', label: 'Memory cron secret', type: 'secret' },
  { key: 'RECALL_ENABLED', category: 'memory', label: 'Recall enabled', type: 'bool', validate: bool },
  { key: 'RECALL_INJECT_TOP_K', category: 'memory', label: 'Recall inject top-K', type: 'int', validate: int },
  { key: 'RECALL_INJECT_MIN_SCORE', category: 'memory', label: 'Recall inject min score', type: 'string', validate: num },
  { key: 'RECALL_SEARCH_MIN_SCORE', category: 'memory', label: 'Recall search min score', type: 'string', validate: num },
  { key: 'RECALL_TOOL_TOP_K', category: 'memory', label: 'Recall tool top-K', type: 'int', validate: int },
  { key: 'RECALL_CHUNK_TOKENS', category: 'memory', label: 'Recall chunk tokens', type: 'int', validate: int },
  { key: 'RECALL_CHUNK_OVERLAP', category: 'memory', label: 'Recall chunk overlap', type: 'int', validate: int },
  { key: 'RECALL_RERANK_POOL', category: 'memory', label: 'Recall rerank pool', type: 'int', validate: int },

  // ---------- Infra ----------
  { key: 'HOST_PORT', category: 'infra', label: 'Ask host port', type: 'int', validate: int },
  { key: 'BASE_URL', category: 'infra', label: 'Base URL', type: 'url', validate: url },
  { key: 'NEXT_PUBLIC_BASE_URL', category: 'infra', label: 'Base URL (client)', type: 'url', validate: url },
  { key: 'LOCAL_REDIS_URL', category: 'infra', label: 'Local Redis URL', type: 'string' },
  { key: 'UPSTASH_REDIS_REST_URL', category: 'infra', label: 'Upstash Redis URL', type: 'url', validate: url },
  { key: 'UPSTASH_REDIS_REST_TOKEN', category: 'infra', label: 'Upstash Redis token', type: 'secret' },
  { key: 'MORPHIC_CLOUD_DEPLOYMENT', category: 'infra', label: 'Cloud deployment', type: 'bool', validate: bool }

  // NOTE: run the parity test; for any remaining key in the real .env
  // (e.g. R2/S3 storage vars → category 'storage', PostHog/Langfuse →
  // 'infra'), add an entry here of the correct type until the test passes.
]

const byKey = new Map(REGISTRY.map(s => [s.key, s]))
export function specByKey(key: string): EnvVarSpec | undefined {
  return byKey.get(key)
}
