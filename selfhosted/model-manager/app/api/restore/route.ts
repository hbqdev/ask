import { restoreBackup } from '@/lib/backups'
import { rollback, type ApplyDeps } from '@/lib/apply'
import { getToolConfig } from '@/lib/config'
import { writeAskEnvAtomic, readAskEnv } from '@/lib/env-io'
import { realRunner } from '@/lib/exec'

export async function POST(req: Request) {
  const { backupPath } = (await req.json()) as { backupPath: string }
  const cfg = getToolConfig()
  const events: unknown[] = []
  const deps: ApplyDeps & {
    restoreAskEnv(p: string): Promise<void>
    readAskEnvText(): Promise<string>
  } = {
    runner: realRunner,
    config: cfg,
    writeAskEnv: t => writeAskEnvAtomic(cfg.askEnvPath, t),
    restoreAskEnv: async p => {
      await restoreBackup(cfg.askEnvPath, p)
    },
    readAskEnvText: async () => readAskEnv(cfg.askEnvPath),
    backup: async () => '',
    sleep: ms => new Promise(r => setTimeout(r, ms))
  }
  const res = await rollback(deps, backupPath, e => events.push(e))
  return Response.json({ ok: res.ok, events })
}
