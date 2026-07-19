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

  return {
    askEnvPath: env.ASK_ENV_PATH || '/ask/.env',
    askComposeFile: env.ASK_COMPOSE_FILE || '/ask/docker-compose.yaml',
    askService: env.ASK_SERVICE || 'ask',
    backupKeep: Number.parseInt(env.MODEL_MANAGER_BACKUP_KEEP || '20', 10),
    reranker
  }
}
