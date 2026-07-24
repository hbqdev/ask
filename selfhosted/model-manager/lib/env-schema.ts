export type Category =
  | 'models'
  | 'search'
  | 'database'
  | 'auth'
  | 'memory'
  | 'storage'
  | 'infra'

export const CATEGORIES: Category[] = [
  'models',
  'search',
  'database',
  'auth',
  'memory',
  'storage',
  'infra'
]

export interface CategoryMeta {
  label: string
  description: string
  icon: string // lucide-react icon name, resolved in the UI
}

export const CATEGORY_META: Record<Category, CategoryMeta> = {
  models: {
    label: 'Models',
    description: 'Chat models, the classifier/expander, embeddings & reranker.',
    icon: 'Cpu'
  },
  search: {
    label: 'Search',
    description: 'SearXNG, crawlers, and web-search providers.',
    icon: 'Search'
  },
  database: {
    label: 'Database',
    description: 'Postgres connection strings & credentials.',
    icon: 'Database'
  },
  auth: {
    label: 'Auth',
    description: 'Login via Supabase, and anonymous access.',
    icon: 'ShieldCheck'
  },
  memory: {
    label: 'Memory',
    description: 'Long-term memory and conversation-recall tuning.',
    icon: 'Brain'
  },
  storage: {
    label: 'Storage',
    description: 'File uploads and object storage (Cloudflare R2 / S3).',
    icon: 'HardDrive'
  },
  infra: {
    label: 'Infra',
    description: 'Ports, base URLs, Redis, and deployment flags.',
    icon: 'Server'
  }
}

export type FieldType =
  | 'url'
  | 'model'
  | 'model-list'
  | 'secret'
  | 'bool'
  | 'int'
  | 'enum'
  | 'string'

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
const nonNegInt = (v: string): string | null =>
  /^\d+$/.test(v.trim()) ? null : 'Must be a non-negative integer'
const num = (v: string): string | null =>
  /^-?\d+(\.\d+)?$/.test(v.trim()) ? null : 'Must be a number'
const bool = (v: string): string | null =>
  /^(true|false)$/.test(v.trim()) ? null : 'Must be true or false'
const nonEmpty = (v: string): string | null =>
  v.trim().length ? null : 'Required'

export const REGISTRY: EnvVarSpec[] = [
  // ---------- Models: Chat ----------
  {
    key: 'OLLAMA_BASE_URL',
    category: 'models',
    group: 'Chat',
    label: 'Chat host',
    type: 'url',
    validate: url,
    testable: 'ollama',
    help: 'Main Ollama LLM host.'
  },
  {
    key: 'NEXT_PUBLIC_OLLAMA_BASE_URL',
    category: 'models',
    group: 'Chat',
    label: 'Chat host (client)',
    type: 'url',
    validate: url,
    help: 'Client-exposed copy; usually mirrors OLLAMA_BASE_URL.'
  },
  {
    key: 'OLLAMA_MODELS',
    category: 'models',
    group: 'Chat',
    label: 'Chat model list',
    type: 'model-list',
    help: 'Cloud models not shown by /api/tags. Add / remove / reorder.'
  },
  {
    key: 'OLLAMA_EMBED_MODEL',
    category: 'models',
    group: 'Chat',
    label: 'Ollama embed model',
    type: 'model',
    help: 'Optional Ollama-side embedding model.'
  },
  // ---------- Models: Cloud providers ----------
  {
    key: 'OPENAI_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI API key',
    type: 'secret'
  },
  {
    key: 'ANTHROPIC_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'Anthropic API key',
    type: 'secret'
  },
  {
    key: 'GOOGLE_GENERATIVE_AI_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'Google GenAI API key',
    type: 'secret'
  },
  {
    key: 'AI_GATEWAY_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'AI Gateway key',
    type: 'secret'
  },
  {
    key: 'OPENAI_COMPATIBLE_API_KEY',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI-compatible key',
    type: 'secret'
  },
  {
    key: 'OPENAI_COMPATIBLE_API_BASE_URL',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI-compatible base URL',
    type: 'url',
    validate: url
  },
  {
    key: 'OPENAI_COMPATIBLE_PROVIDER_NAME',
    default: 'OpenAI Compatible',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI-compatible label',
    type: 'string'
  },
  {
    key: 'OPENAI_COMPATIBLE_MODELS',
    category: 'models',
    group: 'Cloud providers',
    label: 'OpenAI-compatible models',
    type: 'model-list'
  },
  // ---------- Models: Serenity ----------
  {
    key: 'CLASSIFIER_OLLAMA_BASE_URL',
    category: 'models',
    group: 'Serenity',
    label: 'Serenity host',
    type: 'url',
    validate: url,
    testable: 'ollama',
    help: 'Classifier/expander/extractor Ollama host (falls back to Chat host).'
  },
  {
    key: 'CLASSIFIER_MODEL_ID',
    category: 'models',
    group: 'Serenity',
    label: 'Classifier model',
    type: 'model',
    default: 'granite4.1:8b'
  },
  {
    key: 'EXPANDER_MODEL_ID',
    category: 'models',
    group: 'Serenity',
    label: 'Query-expander model',
    type: 'model',
    default: 'granite4.1:8b'
  },
  {
    key: 'MEMORY_EXTRACTOR_MODEL_ID',
    category: 'models',
    group: 'Serenity',
    label: 'Memory-extractor model',
    type: 'model',
    default: 'granite4.1:8b'
  },
  // ---------- Models: Embeddings ----------
  {
    key: 'EMBEDDING_MODEL',
    category: 'models',
    group: 'Embeddings',
    label: 'Embedding model',
    type: 'enum',
    enumValues: [
      'Xenova/all-MiniLM-L6-v2',
      'mixedbread-ai/mxbai-embed-large-v1',
      'Xenova/nomic-embed-text-v1',
      'Qwen/Qwen3-Embedding-0.6B'
    ],
    help: 'Qwen3 (best) requires the GPU embedding service and a re-embed of stored vectors. Changing dimension affects the memory/recall schema.'
  },
  {
    key: 'EMBEDDING_SERVICE_URL',
    category: 'models',
    group: 'Embeddings',
    label: 'Embedding service URL (GPU, on nightfuryS)',
    type: 'url',
    validate: url,
    target: 'ask',
    help: 'Remote GPU embedder on the P4000. When unset, Ask embeds in-process on CPU (also the automatic fallback if the service is down).'
  },
  {
    key: 'EMBEDDING_SERVICE_TOKEN',
    category: 'models',
    group: 'Embeddings',
    label: 'Embedding service token',
    type: 'secret',
    target: 'ask'
  },
  {
    key: 'MODEL_CACHE_DIR',
    category: 'models',
    group: 'Embeddings',
    label: 'Model cache dir',
    type: 'string'
  },
  // ---------- Models: Reranker ----------
  {
    key: 'RERANKER_URL',
    category: 'models',
    group: 'Reranker',
    label: 'Reranker URL (Ask → reranker)',
    type: 'url',
    validate: url,
    testable: 'reranker',
    target: 'ask'
  },
  {
    key: 'RERANKER_API_TOKEN',
    category: 'models',
    group: 'Reranker',
    label: 'Reranker API token',
    type: 'secret',
    target: 'ask'
  },
  {
    key: 'RERANKER_MODEL',
    category: 'models',
    group: 'Reranker',
    label: 'Reranker model (on nightfuryX)',
    type: 'model',
    default: 'Qwen/Qwen3-Reranker-8B',
    target: 'reranker',
    help: 'Applied over SSH to the 2080 Ti box. 8B (current) is max quality; 4B is ~1.7x faster if search latency matters. Both weight sets are cached on the box.'
  },
  // ---------- Models: Ingestion ----------
  {
    key: 'INGEST_API_TOKEN',
    category: 'models',
    group: 'Ingestion',
    label: 'Ingestion worker token',
    type: 'secret',
    target: 'ask',
    help: 'Bearer token the uploads-ingestion worker uses against /api/ingest/*. Unset disables worker ingestion (uploads queue as pending; text documents still fast-path locally).'
  },
  // ---------- Models: Image generation (Replicate) ----------
  // NOTE: the model options below duplicate the capability arrays in the app's
  // lib/imagegen/models/*.json — model-manager cannot import from the app, so
  // these lists must be kept in sync by hand. Since the rotation feature
  // (2026-07-23) these vars are PIN OVERRIDES: unset = task-pool rotation;
  // set = that model handles every request for its role.
  {
    key: 'REPLICATE_API_TOKEN',
    category: 'models',
    group: 'Image generation',
    label: 'Replicate API token',
    type: 'secret',
    help: 'Enables the image-generation tool. When unset the tool is absent from the researcher entirely.'
  },
  {
    key: 'REPLICATE_IMAGE_MODEL',
    category: 'models',
    group: 'Image generation',
    label: 'Image generate model (pin)',
    type: 'enum',
    enumValues: [
      'google/nano-banana',
      'google/nano-banana-2',
      'google/nano-banana-2-lite',
      'google/nano-banana-pro',
      'google/imagen-4',
      'google/imagen-4-fast',
      'google/imagen-4-ultra',
      'black-forest-labs/flux-2-pro',
      'black-forest-labs/flux-2-max',
      'black-forest-labs/flux-2-flex',
      'black-forest-labs/flux-2-klein-4b',
      'black-forest-labs/flux-2-klein-9b',
      'black-forest-labs/flux-1.1-pro',
      'black-forest-labs/flux-schnell',
      'bytedance/seedream-4',
      'bytedance/seedream-4.5',
      'bytedance/seedream-5-lite',
      'openai/gpt-image-2',
      'wan-video/wan-2.7-image-pro',
      'wan-video/wan-2.7-image',
      'prunaai/p-image',
      'prunaai/z-image-turbo',
      'prunaai/z-image',
      'prunaai/ernie-image-turbo',
      'recraft-ai/recraft-v4.1',
      'recraft-ai/recraft-v4.1-pro',
      'recraft-ai/recraft-v4.1-utility',
      'recraft-ai/recraft-v4.1-svg',
      'bria/image-3.2',
      'bria/fibo'
    ],
    help: 'PIN override. Unset (recommended) = automatic task-pool rotation. Set = this model handles ALL text-to-image requests. nano-banana-pro is the intended premium pin.'
  },
  {
    key: 'REPLICATE_IMAGE_EDIT_MODEL',
    category: 'models',
    group: 'Image generation',
    label: 'Image edit model (pin)',
    type: 'enum',
    enumValues: [
      'google/nano-banana',
      'google/nano-banana-2',
      'google/nano-banana-2-lite',
      'google/nano-banana-pro',
      'black-forest-labs/flux-2-pro',
      'black-forest-labs/flux-2-max',
      'black-forest-labs/flux-2-flex',
      'black-forest-labs/flux-2-klein-4b',
      'black-forest-labs/flux-2-klein-9b',
      'bytedance/seedream-4',
      'bytedance/seedream-4.5',
      'bytedance/seedream-5-lite',
      'openai/gpt-image-2',
      'wan-video/wan-2.7-image-pro',
      'wan-video/wan-2.7-image',
      'prunaai/p-image-edit',
      'bria/fibo-edit'
    ],
    help: 'PIN override for edit requests (base image supplied). Unset (recommended) = rotation. Edit-capable models only.'
  },
  {
    key: 'REPLICATE_MONTHLY_BUDGET',
    category: 'models',
    group: 'Image generation',
    label: 'Monthly generation budget',
    type: 'int',
    validate: nonNegInt,
    help: 'Caps image generations per UTC month (soft Redis counter). Unset or 0 = unlimited.'
  },
  {
    key: 'REPLICATE_TIMEOUT_MS',
    category: 'models',
    group: 'Image generation',
    label: 'Replicate timeout (ms)',
    type: 'int',
    validate: int,
    default: '120000',
    help: 'Per-request timeout for Replicate prediction polling.'
  },

  // ---------- Search ----------
  {
    key: 'SEARCH_API',
    category: 'search',
    label: 'Search backend',
    type: 'enum',
    enumValues: ['searxng', 'tavily', 'exa', 'brave']
  },
  {
    key: 'SEARXNG_API_URL',
    category: 'search',
    group: 'SearXNG',
    label: 'SearXNG URL',
    type: 'url',
    validate: url
  },
  {
    key: 'SEARXNG_FALLBACK_API_URL',
    category: 'search',
    group: 'SearXNG',
    label: 'SearXNG fallback URL',
    type: 'url',
    validate: url
  },
  {
    key: 'NEXT_PUBLIC_SEARXNG_URL',
    category: 'search',
    group: 'SearXNG',
    label: 'SearXNG URL (client)',
    type: 'url',
    validate: url
  },
  {
    key: 'SEARXNG_SECRET',
    category: 'search',
    group: 'SearXNG',
    label: 'SearXNG secret',
    type: 'secret'
  },
  {
    key: 'SEARXNG_ENGINES',
    default: 'google,bing,duckduckgo,wikipedia',
    category: 'search',
    group: 'SearXNG',
    label: 'Engines',
    type: 'string'
  },
  {
    key: 'SEARXNG_MAX_RESULTS',
    default: '50',
    category: 'search',
    group: 'SearXNG',
    label: 'Max results',
    type: 'int',
    validate: int
  },
  {
    key: 'SEARXNG_DEFAULT_DEPTH',
    default: 'basic',
    category: 'search',
    group: 'SearXNG',
    label: 'Default depth',
    type: 'string'
  },
  {
    key: 'SEARXNG_TIME_RANGE',
    default: 'None',
    category: 'search',
    group: 'SearXNG',
    label: 'Time range',
    type: 'string'
  },
  {
    key: 'SEARXNG_SAFESEARCH',
    default: '0',
    category: 'search',
    group: 'SearXNG',
    label: 'Safesearch',
    type: 'int',
    validate: int
  },
  {
    key: 'SEARXNG_CRAWL_MULTIPLIER',
    default: '4',
    category: 'search',
    group: 'SearXNG',
    label: 'Crawl multiplier',
    type: 'int',
    validate: int
  },
  {
    key: 'CRAWL4AI_URL',
    category: 'search',
    group: 'Crawl',
    label: 'Crawl4AI URL',
    type: 'url',
    validate: url
  },
  {
    key: 'CRAWL4AI_API_TOKEN',
    category: 'search',
    group: 'Crawl',
    label: 'Crawl4AI token',
    type: 'secret'
  },
  {
    key: 'FLARESOLVERR_URL',
    category: 'search',
    group: 'Crawl',
    label: 'FlareSolverr URL',
    type: 'url',
    validate: url
  },
  {
    key: 'FIRECRAWL_API_KEY',
    category: 'search',
    group: 'Crawl',
    label: 'Firecrawl key',
    type: 'secret'
  },
  {
    key: 'DEGOOG_API_URL',
    category: 'search',
    group: 'Degoog',
    label: 'Degoog URL',
    type: 'url',
    validate: url
  },
  {
    key: 'DEGOOG_API_KEY',
    category: 'search',
    group: 'Degoog',
    label: 'Degoog key',
    type: 'secret'
  },
  {
    key: 'TAVILY_API_KEY',
    category: 'search',
    group: 'Providers',
    label: 'Tavily key',
    type: 'secret'
  },
  {
    key: 'EXA_API_KEY',
    category: 'search',
    group: 'Providers',
    label: 'Exa key',
    type: 'secret'
  },
  {
    key: 'BRAVE_SEARCH_API_KEY',
    category: 'search',
    group: 'Providers',
    label: 'Brave key',
    type: 'secret'
  },
  {
    key: 'JINA_API_KEY',
    category: 'search',
    group: 'Providers',
    label: 'Jina key',
    type: 'secret'
  },
  {
    key: 'OLLAMA_SEARCH_API_KEY',
    category: 'search',
    group: 'Ollama search',
    label: 'Ollama search key',
    type: 'secret'
  },
  {
    key: 'OLLAMA_SEARCH_ENABLED',
    category: 'search',
    group: 'Ollama search',
    label: 'Ollama search enabled',
    type: 'bool',
    validate: bool
  },
  {
    key: 'OLLAMA_SEARCH_MAX_RESULTS',
    category: 'search',
    group: 'Ollama search',
    label: 'Ollama search max results',
    type: 'int',
    validate: int
  },
  {
    key: 'OLLAMA_SEARCH_TIMEOUT_MS',
    category: 'search',
    group: 'Ollama search',
    label: 'Ollama search timeout (ms)',
    type: 'int',
    validate: int
  },

  // ---------- Database ----------
  {
    key: 'DATABASE_URL',
    category: 'database',
    label: 'Database URL',
    type: 'secret',
    validate: nonEmpty
  },
  {
    key: 'DATABASE_RESTRICTED_URL',
    category: 'database',
    label: 'Restricted DB URL',
    type: 'secret'
  },
  {
    key: 'DATABASE_SSL_DISABLED',
    category: 'database',
    label: 'Disable DB SSL',
    type: 'bool',
    validate: bool
  },
  {
    key: 'POSTGRES_USER',
    category: 'database',
    label: 'Postgres user',
    type: 'string'
  },
  {
    key: 'POSTGRES_PASSWORD',
    category: 'database',
    label: 'Postgres password',
    type: 'secret'
  },
  {
    key: 'POSTGRES_DB',
    category: 'database',
    label: 'Postgres db',
    type: 'string'
  },

  // ---------- Auth ----------
  {
    key: 'ENABLE_AUTH',
    category: 'auth',
    label: 'Enable auth',
    type: 'bool',
    validate: bool
  },
  {
    key: 'ANONYMOUS_USER_ID',
    default: 'anonymous-user',
    category: 'auth',
    label: 'Anonymous user id',
    type: 'string'
  },
  {
    key: 'NEXT_PUBLIC_SUPABASE_URL',
    category: 'auth',
    label: 'Supabase URL',
    type: 'url',
    validate: url
  },
  {
    key: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    category: 'auth',
    label: 'Supabase publishable key',
    type: 'string'
  },
  {
    key: 'SUPABASE_SECRET_KEY',
    category: 'auth',
    label: 'Supabase secret key',
    type: 'secret'
  },

  // ---------- Memory / recall ----------
  {
    key: 'MEMORY_ENABLED',
    category: 'memory',
    label: 'Memory enabled',
    type: 'bool',
    validate: bool
  },
  {
    key: 'MEMORY_SIM_THRESHOLD',
    category: 'memory',
    label: 'Memory sim threshold',
    type: 'string',
    validate: num
  },
  {
    key: 'MEMORY_GRADUATE_SIGHTINGS',
    category: 'memory',
    label: 'Graduate sightings',
    type: 'int',
    validate: int
  },
  {
    key: 'MEMORY_MAX_PER_USER',
    category: 'memory',
    label: 'Max per user',
    type: 'int',
    validate: int
  },
  {
    key: 'MEMORY_INJECT_TOP_K',
    category: 'memory',
    label: 'Inject top-K',
    type: 'int',
    validate: int
  },
  {
    key: 'MEMORY_CRON_SECRET',
    category: 'memory',
    label: 'Memory cron secret',
    type: 'secret'
  },
  {
    key: 'RECALL_ENABLED',
    category: 'memory',
    label: 'Recall enabled',
    type: 'bool',
    validate: bool
  },
  {
    key: 'RECALL_INJECT_TOP_K',
    category: 'memory',
    label: 'Recall inject top-K',
    type: 'int',
    validate: int
  },
  {
    key: 'RECALL_INJECT_MIN_SCORE',
    category: 'memory',
    label: 'Recall inject min score',
    type: 'string',
    validate: num
  },
  {
    key: 'RECALL_SEARCH_MIN_SCORE',
    category: 'memory',
    label: 'Recall search min score',
    type: 'string',
    validate: num
  },
  {
    key: 'RECALL_TOOL_TOP_K',
    category: 'memory',
    label: 'Recall tool top-K',
    type: 'int',
    validate: int
  },
  {
    key: 'RECALL_CHUNK_TOKENS',
    category: 'memory',
    label: 'Recall chunk tokens',
    type: 'int',
    validate: int
  },
  {
    key: 'RECALL_CHUNK_OVERLAP',
    category: 'memory',
    label: 'Recall chunk overlap',
    type: 'int',
    validate: int
  },
  {
    key: 'RECALL_RERANK_POOL',
    category: 'memory',
    label: 'Recall rerank pool',
    type: 'int',
    validate: int
  },

  // ---------- Infra ----------
  {
    key: 'HOST_PORT',
    category: 'infra',
    label: 'Ask host port',
    type: 'int',
    validate: int
  },
  {
    key: 'BASE_URL',
    category: 'infra',
    label: 'Base URL',
    type: 'url',
    validate: url
  },
  {
    key: 'NEXT_PUBLIC_BASE_URL',
    category: 'infra',
    label: 'Base URL (client)',
    type: 'url',
    validate: url
  },
  {
    key: 'LOCAL_REDIS_URL',
    default: 'redis://localhost:6379',
    category: 'infra',
    label: 'Local Redis URL',
    type: 'string'
  },
  {
    key: 'UPSTASH_REDIS_REST_URL',
    category: 'infra',
    label: 'Upstash Redis URL',
    type: 'url',
    validate: url
  },
  {
    key: 'UPSTASH_REDIS_REST_TOKEN',
    category: 'infra',
    label: 'Upstash Redis token',
    type: 'secret'
  },
  {
    key: 'MORPHIC_CLOUD_DEPLOYMENT',
    category: 'infra',
    label: 'Cloud deployment',
    type: 'bool',
    validate: bool,
    help: 'Set true only on Morphic Cloud. Self-hosted stays false.'
  },

  // ---------- Storage: uploads (file attachments / RAG) ----------
  {
    key: 'UPLOADS_DIR',
    category: 'storage',
    group: 'Local uploads',
    label: 'Uploads directory',
    type: 'string',
    default: '/app/uploads',
    help: 'Container path where uploaded files are stored (the default local storage). The ask container mounts the "morphic-uploads" Docker volume here. Only bypassed when R2/S3 is configured.'
  },
  {
    key: 'UPLOAD_TTL_DAYS',
    category: 'storage',
    group: 'Local uploads',
    label: 'Upload TTL (days)',
    type: 'int',
    validate: nonNegInt,
    default: '14',
    help: 'Delete uploaded files this many days after their chat goes idle. 0 (or unset) disables expiry.'
  },
  {
    key: 'R2_ACCOUNT_ID',
    category: 'storage',
    group: 'Cloudflare R2',
    label: 'R2 account ID',
    type: 'string',
    help: 'Cloudflare account ID that owns the R2 bucket. Enables R2 object storage for uploads.'
  },
  {
    key: 'R2_BUCKET_NAME',
    default: 'user-uploads',
    category: 'storage',
    group: 'Cloudflare R2',
    label: 'R2 bucket name',
    type: 'string',
    help: 'Name of the R2 bucket used to store uploaded files.'
  },
  {
    key: 'R2_ACCESS_KEY_ID',
    category: 'storage',
    group: 'Cloudflare R2',
    label: 'R2 access key ID',
    type: 'secret',
    help: 'R2 API token access key ID.'
  },
  {
    key: 'R2_SECRET_ACCESS_KEY',
    category: 'storage',
    group: 'Cloudflare R2',
    label: 'R2 secret access key',
    type: 'secret',
    help: 'R2 API token secret. Treat as a credential.'
  },
  {
    key: 'R2_PUBLIC_URL',
    category: 'storage',
    group: 'Cloudflare R2',
    label: 'R2 public URL',
    type: 'url',
    validate: url,
    help: 'Public base URL that serves objects from the bucket (e.g. a custom domain or r2.dev URL).'
  },
  {
    key: 'R2_SIGNED_URL_EXPIRES_SECONDS',
    category: 'storage',
    group: 'Cloudflare R2',
    label: 'Signed URL expiry (seconds)',
    type: 'int',
    validate: int,
    help: 'How long a presigned download URL stays valid.'
  },
  {
    key: 'S3_ENDPOINT',
    category: 'storage',
    group: 'S3-compatible',
    label: 'S3 endpoint',
    type: 'url',
    validate: url,
    help: 'Endpoint for an S3-compatible store (MinIO, Backblaze, etc.) instead of Cloudflare R2.'
  }
]

const byKey = new Map(REGISTRY.map(s => [s.key, s]))
export function specByKey(key: string): EnvVarSpec | undefined {
  return byKey.get(key)
}
