export interface RerankerConfig {
  sshTarget: string
  sshKey: string
  remoteDir: string
  envFile: string
  service: string
}

export interface ToolConfig {
  askEnvPath: string
  askComposeFile: string
  // Full `-f` list docker compose is invoked with (base + overlays). apply()
  // uses THIS, not askComposeFile, so a config apply recreates the service the
  // exact way it is deployed — base + the VPN overlay — instead of base-only
  // (which drops the VPN networking). Defaults to [askComposeFile].
  askComposeFiles: string[]
  // `-p` project. The base compose is `name: ask-stack`, so an apply that omits
  // the project silently targets whatever that name resolves to (prod). Pin it
  // explicitly so the apply can never land on the wrong stack.
  askComposeProject: string | null
  askService: string
  backupKeep: number
  reranker: RerankerConfig | null
}

// Plain string-keyed env shape (rather than NodeJS.ProcessEnv) so tests can
// inject fixture objects directly. process.env still satisfies this via its
// index signature.
type EnvSource = Record<string, string | undefined>

export function getToolConfig(env: EnvSource = process.env): ToolConfig {
  const sshTarget = env.RERANKER_SSH_TARGET
  const remoteDir = env.RERANKER_REMOTE_DIR
  const reranker =
    sshTarget && remoteDir
      ? {
          sshTarget,
          sshKey: env.RERANKER_SSH_KEY || '/keys/nightfurys',
          remoteDir,
          envFile: env.RERANKER_ENV_FILE || '.env',
          service: env.RERANKER_SERVICE || 'reranker'
        }
      : null

  const askComposeFile = env.ASK_COMPOSE_FILE || '/ask/docker-compose.yaml'
  // ASK_COMPOSE_FILES is a whitespace-separated `-f` list (base first, then any
  // overlays, e.g. the VPN overlay). Falls back to the single askComposeFile so
  // deployments that don't set it keep the prior behaviour.
  const askComposeFiles = env.ASK_COMPOSE_FILES?.trim()
    ? env.ASK_COMPOSE_FILES.trim().split(/\s+/)
    : [askComposeFile]

  return {
    askEnvPath: env.ASK_ENV_PATH || '/ask/.env',
    askComposeFile,
    askComposeFiles,
    askComposeProject: env.ASK_COMPOSE_PROJECT || null,
    askService: env.ASK_SERVICE || 'ask',
    backupKeep: Number.parseInt(env.MODEL_MANAGER_BACKUP_KEEP || '20', 10),
    reranker
  }
}
