import { cookies } from 'next/headers'

import { rollback, type ApplyDeps } from '@/lib/apply'
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth'
import { pruneBackups, resolveOwnBackup, restoreBackup } from '@/lib/backups'
import { getToolConfig } from '@/lib/config'
import { writeAskEnvAtomic, readAskEnv } from '@/lib/env-io'
import { realRunner } from '@/lib/exec'
import { withApplyLock } from '@/lib/lock'

export async function POST(req: Request) {
  // Belt-and-suspenders like /api/apply: this rewrites prod .env and restarts.
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!verifySessionToken(token)) {
    return new Response('Unauthorized', { status: 401 })
  }
  const { backupPath } = (await req.json()) as { backupPath?: unknown }
  const cfg = getToolConfig()
  const own = await resolveOwnBackup(cfg.askEnvPath, backupPath)
  if (!own) {
    return Response.json(
      {
        ok: false,
        error: 'Unknown backup (only listed backups can be restored)'
      },
      { status: 400 }
    )
  }
  const events: unknown[] = []
  const deps: ApplyDeps & {
    restoreAskEnv(p: string): Promise<void>
    readAskEnvText(): Promise<string>
  } = {
    runner: realRunner,
    config: cfg,
    writeAskEnv: t => writeAskEnvAtomic(cfg.askEnvPath, t),
    restoreAskEnv: async p => {
      // Snapshots the current .env before overwriting it.
      const snapshot = await restoreBackup(cfg.askEnvPath, p)
      events.push({ step: 'backup', status: 'ok', detail: snapshot })
      await pruneBackups(cfg.askEnvPath, cfg.backupKeep)
    },
    readAskEnvText: async () => readAskEnv(cfg.askEnvPath),
    backup: async () => '',
    sleep: ms => new Promise(r => setTimeout(r, ms))
  }
  const res = await withApplyLock(() =>
    rollback(deps, own, e => events.push(e))
  )
  return Response.json({ ok: res.ok, events })
}
