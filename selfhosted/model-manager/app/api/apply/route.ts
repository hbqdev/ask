import { applyPlan, type ApplyEvent, type ApplyDeps } from '@/lib/apply'
import { buildPlan, validateEdits } from '@/lib/plan-builder'
import { getToolConfig } from '@/lib/config'
import { readAskEnv, writeAskEnvAtomic } from '@/lib/env-io'
import { realRunner } from '@/lib/exec'
import { writeBackup, pruneBackups } from '@/lib/backups'
import { withApplyLock } from '@/lib/lock'

export async function POST(req: Request) {
  const { edits } = (await req.json()) as { edits: Record<string, string> }
  const violations = validateEdits(edits)
  if (violations.length) {
    return Response.json({ violations }, { status: 400 })
  }
  const cfg = getToolConfig()
  const current = await readAskEnv(cfg.askEnvPath)
  const { plan } = buildPlan(current, edits)

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const emit = (e: ApplyEvent) =>
        controller.enqueue(enc.encode(JSON.stringify(e) + '\n'))
      const deps: ApplyDeps = {
        runner: realRunner,
        config: cfg,
        writeAskEnv: t => writeAskEnvAtomic(cfg.askEnvPath, t),
        backup: async () => {
          const p = await writeBackup(cfg.askEnvPath, new Date())
          await pruneBackups(cfg.askEnvPath, cfg.backupKeep)
          return p
        },
        sleep: ms => new Promise(r => setTimeout(r, ms))
      }
      try {
        await withApplyLock(async () => {
          const res = await applyPlan(plan, deps, emit)
          emit({
            step: 'done',
            status: res.ok ? 'ok' : 'fail',
            detail: res.backupPath
          })
        })
      } catch (e) {
        emit({
          step: 'done',
          status: 'fail',
          detail: e instanceof Error ? e.message : String(e)
        })
      } finally {
        controller.close()
      }
    }
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson' }
  })
}
