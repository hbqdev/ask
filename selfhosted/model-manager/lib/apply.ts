import type { ToolConfig } from './config'
import { getValue, parseEnv, serializeEnv, setValue } from './env-file'
import { specByKey } from './env-schema'
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

type Redact = (s: string) => string

// Redact any secret-typed value we just wrote from subprocess output before it
// is emitted — a tool (e.g. docker compose) that echoes an offending .env line
// into stderr must not leak a secret through ApplyEvent.detail.
function buildRedactor(texts: (string | undefined)[]): Redact {
  const secrets: string[] = []
  for (const text of texts) {
    if (!text) continue
    for (const line of parseEnv(text).lines) {
      if (
        line.kind === 'pair' &&
        line.value &&
        specByKey(line.key)?.type === 'secret'
      ) {
        secrets.push(line.value)
      }
    }
  }
  secrets.sort((a, b) => b.length - a.length)
  return (s: string) => {
    let out = s
    for (const v of secrets) out = out.split(v).join('••••••')
    return out
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function restartAsk(
  deps: ApplyDeps,
  emit: (e: ApplyEvent) => void,
  redact: Redact
): Promise<boolean> {
  const { runner, config } = deps
  emit({ step: 'ask-restart', status: 'start' })
  try {
    // Recreate the service exactly the way it is deployed:
    //  -p <project>            pin the stack; base compose is `name: ask-stack`,
    //                          so omitting this silently lands on prod.
    //  -f base -f overlays…    include the VPN overlay, else the service comes
    //                          back base-only (no VPN networking).
    //  --force-recreate        env_file (.env) content changes don't alter the
    //                          resolved compose config, so a plain `up` would NOT
    //                          recreate the container and the new value (e.g.
    //                          OLLAMA_MODELS) would never take effect.
    //  --no-deps               only touch the app; leave postgres/redis/searxng.
    //  --wait --wait-timeout   block until the ask healthcheck reports healthy
    //                          (the base compose now defines one), so an apply
    //                          that boots but crash-loops / fails its healthcheck
    //                          is reported as a FAILURE here instead of "ok" the
    //                          instant `up` returns 0. On timeout compose exits
    //                          non-zero and the failure path below fires.
    const args = [
      'compose',
      ...(config.askComposeProject ? ['-p', config.askComposeProject] : []),
      ...config.askComposeFiles.flatMap(f => ['-f', f]),
      'up',
      '-d',
      '--force-recreate',
      '--no-deps',
      '--wait',
      '--wait-timeout',
      '120',
      config.askService
    ]
    const r = await runner.run('docker', args, { timeoutMs: 180_000 })
    if (r.code !== 0) {
      emit({
        step: 'ask-restart',
        status: 'fail',
        detail: redact(r.stderr).slice(-2000)
      })
      return false
    }
    emit({ step: 'ask-restart', status: 'ok' })
    return true
  } catch (e) {
    emit({ step: 'ask-restart', status: 'fail', detail: redact(errText(e)) })
    return false
  }
}

async function restartReranker(
  deps: ApplyDeps,
  rerankerEnvText: string,
  emit: (e: ApplyEvent) => void,
  redact: Redact
): Promise<boolean> {
  const { runner, config } = deps
  const rc = config.reranker
  if (!rc) {
    emit({ step: 'reranker-restart', status: 'start' })
    emit({
      step: 'reranker-restart',
      status: 'fail',
      detail: 'reranker SSH not configured'
    })
    return false
  }

  emit({ step: 'reranker-write', status: 'start' })
  try {
    // Read-modify-write the remote .env. Only RERANKER_MODEL changes here, but
    // that file ALSO holds RERANKER_API_TOKEN (+ batch size), consumed via
    // env_file — and the reranker fails CLOSED (503) without the token. A blind
    // `cat >` of just the model line truncated those keys away, taking the whole
    // reranker down to a 503 (Ask degrades to bi-encoder) on its next restart.
    // So fetch the current file, set ONLY RERANKER_MODEL, and write the merged
    // result back; if we can't read the current file, refuse rather than
    // overwrite blind.
    const read = await runner.run(
      'ssh',
      [
        '-i',
        rc.sshKey,
        '-o',
        'StrictHostKeyChecking=accept-new',
        rc.sshTarget,
        `cat ${rc.remoteDir}/${rc.envFile}`
      ],
      { timeoutMs: 30_000 }
    )
    if (read.code !== 0) {
      emit({
        step: 'reranker-write',
        status: 'fail',
        detail:
          'could not read remote .env (refusing to overwrite blind): ' +
          redact(read.stderr).slice(-1500)
      })
      return false
    }

    const model = getValue(parseEnv(rerankerEnvText), 'RERANKER_MODEL')
    const merged = model
      ? serializeEnv(setValue(parseEnv(read.stdout), 'RERANKER_MODEL', model))
      : read.stdout

    const write = await runner.run(
      'ssh',
      [
        '-i',
        rc.sshKey,
        '-o',
        'StrictHostKeyChecking=accept-new',
        rc.sshTarget,
        `cat > ${rc.remoteDir}/${rc.envFile}`
      ],
      { input: merged, timeoutMs: 30_000 }
    )
    if (write.code !== 0) {
      emit({
        step: 'reranker-write',
        status: 'fail',
        detail: redact(write.stderr).slice(-2000)
      })
      return false
    }
    emit({ step: 'reranker-write', status: 'ok' })
  } catch (e) {
    emit({ step: 'reranker-write', status: 'fail', detail: redact(errText(e)) })
    return false
  }

  emit({ step: 'reranker-restart', status: 'start' })
  try {
    const up = await runner.run(
      'ssh',
      [
        '-i',
        rc.sshKey,
        '-o',
        'StrictHostKeyChecking=accept-new',
        rc.sshTarget,
        `cd ${rc.remoteDir} && docker compose up -d --force-recreate ${rc.service}`
      ],
      { timeoutMs: 180_000 }
    )
    if (up.code !== 0) {
      emit({
        step: 'reranker-restart',
        status: 'fail',
        detail: redact(up.stderr).slice(-2000)
      })
      return false
    }
    emit({ step: 'reranker-restart', status: 'ok' })
    return true
  } catch (e) {
    emit({
      step: 'reranker-restart',
      status: 'fail',
      detail: redact(errText(e))
    })
    return false
  }
}

export async function applyPlan(
  plan: ApplyPlan,
  deps: ApplyDeps,
  emit: (e: ApplyEvent) => void
): Promise<{ ok: boolean; backupPath: string }> {
  const redact = buildRedactor([plan.askEnvText, plan.rerankerEnvText])

  emit({ step: 'backup', status: 'start' })
  let backupPath = ''
  try {
    backupPath = await deps.backup()
    emit({ step: 'backup', status: 'ok', detail: backupPath })
  } catch (e) {
    emit({ step: 'backup', status: 'fail', detail: redact(errText(e)) })
    return { ok: false, backupPath }
  }

  emit({ step: 'write', status: 'start' })
  try {
    await deps.writeAskEnv(plan.askEnvText)
    emit({ step: 'write', status: 'ok' })
  } catch (e) {
    emit({ step: 'write', status: 'fail', detail: redact(errText(e)) })
    return { ok: false, backupPath }
  }

  let ok = true
  if (plan.touchedTargets.includes('ask')) {
    if (!(await restartAsk(deps, emit, redact))) ok = false
  }
  if (plan.touchedTargets.includes('reranker')) {
    if (
      !(await restartReranker(deps, plan.rerankerEnvText ?? '', emit, redact))
    ) {
      ok = false
    }
  }
  return { ok, backupPath }
}

export async function rollback(
  deps: ApplyDeps & {
    restoreAskEnv(backupPath: string): Promise<void>
    readAskEnvText(): Promise<string>
  },
  backupPath: string,
  emit: (e: ApplyEvent) => void
): Promise<{ ok: boolean }> {
  emit({ step: 'rollback-restore', status: 'start' })
  try {
    await deps.restoreAskEnv(backupPath)
    emit({ step: 'rollback-restore', status: 'ok' })
  } catch (e) {
    emit({ step: 'rollback-restore', status: 'fail', detail: errText(e) })
    return { ok: false }
  }
  // Redact secrets from the just-restored env when reporting restart stderr.
  let redact: Redact = (s: string) => s
  try {
    redact = buildRedactor([await deps.readAskEnvText()])
  } catch {
    // If the restored file can't be read, fall back to identity — the restart
    // detail may be terse but nothing hangs.
  }
  const ok = await restartAsk(deps, emit, redact)
  return { ok }
}
