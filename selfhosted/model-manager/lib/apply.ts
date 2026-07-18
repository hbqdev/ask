import type { ToolConfig } from './config'
import type { Runner } from './exec'

export type ApplyEvent = {
  step: string
  status: 'start' | 'ok' | 'fail'
  detail?: string
}

export interface ApplyPlan {
  askEnvText: string
  touchedTargets: ('ask' | 'reranker')[]
  rerankerEnvText?: string
}

export interface ApplyDeps {
  runner: Runner
  config: ToolConfig
  writeAskEnv(text: string): Promise<void>
  backup(): Promise<string>
  sleep(ms: number): Promise<void>
}

async function restartAsk(deps: ApplyDeps, emit: (e: ApplyEvent) => void): Promise<boolean> {
  const { runner, config } = deps
  emit({ step: 'ask-restart', status: 'start' })
  const r = await runner.run('docker', [
    'compose', '-f', config.askComposeFile, 'up', '-d', config.askService
  ], { timeoutMs: 180_000 })
  if (r.code !== 0) {
    emit({ step: 'ask-restart', status: 'fail', detail: r.stderr.slice(-2000) })
    return false
  }
  emit({ step: 'ask-restart', status: 'ok' })
  return true
}

async function restartReranker(
  deps: ApplyDeps,
  rerankerEnvText: string,
  emit: (e: ApplyEvent) => void
): Promise<boolean> {
  const { runner, config } = deps
  const rc = config.reranker
  if (!rc) {
    emit({ step: 'reranker-restart', status: 'fail', detail: 'reranker SSH not configured' })
    return false
  }
  emit({ step: 'reranker-write', status: 'start' })
  const write = await runner.run(
    'ssh',
    ['-i', rc.sshKey, '-o', 'StrictHostKeyChecking=accept-new', rc.sshTarget,
     `cat > ${rc.remoteDir}/${rc.envFile}`],
    { input: rerankerEnvText, timeoutMs: 30_000 }
  )
  if (write.code !== 0) {
    emit({ step: 'reranker-write', status: 'fail', detail: write.stderr.slice(-2000) })
    return false
  }
  emit({ step: 'reranker-write', status: 'ok' })

  emit({ step: 'reranker-restart', status: 'start' })
  const up = await runner.run(
    'ssh',
    ['-i', rc.sshKey, '-o', 'StrictHostKeyChecking=accept-new', rc.sshTarget,
     `cd ${rc.remoteDir} && docker compose up -d ${rc.service}`],
    { timeoutMs: 180_000 }
  )
  if (up.code !== 0) {
    emit({ step: 'reranker-restart', status: 'fail', detail: up.stderr.slice(-2000) })
    return false
  }
  emit({ step: 'reranker-restart', status: 'ok' })
  return true
}

export async function applyPlan(
  plan: ApplyPlan,
  deps: ApplyDeps,
  emit: (e: ApplyEvent) => void
): Promise<{ ok: boolean; backupPath: string }> {
  emit({ step: 'backup', status: 'start' })
  const backupPath = await deps.backup()
  emit({ step: 'backup', status: 'ok', detail: backupPath })

  emit({ step: 'write', status: 'start' })
  await deps.writeAskEnv(plan.askEnvText)
  emit({ step: 'write', status: 'ok' })

  let ok = true
  if (plan.touchedTargets.includes('ask')) {
    if (!(await restartAsk(deps, emit))) ok = false
  }
  if (plan.touchedTargets.includes('reranker')) {
    if (!(await restartReranker(deps, plan.rerankerEnvText ?? '', emit))) ok = false
  }
  return { ok, backupPath }
}

export async function rollback(
  deps: ApplyDeps & { restoreAskEnv(backupPath: string): Promise<void> },
  backupPath: string,
  emit: (e: ApplyEvent) => void
): Promise<{ ok: boolean }> {
  emit({ step: 'rollback-restore', status: 'start' })
  await deps.restoreAskEnv(backupPath)
  emit({ step: 'rollback-restore', status: 'ok' })
  const ok = await restartAsk(deps, emit)
  return { ok }
}
