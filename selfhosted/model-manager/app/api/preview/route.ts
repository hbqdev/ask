import { buildPlan } from '@/lib/plan-builder'
import { renderDiff } from '@/lib/diff'
import { getToolConfig } from '@/lib/config'
import { readAskEnv } from '@/lib/env-io'

export async function POST(req: Request) {
  const { edits } = (await req.json()) as { edits: Record<string, string> }
  const cfg = getToolConfig()
  const current = await readAskEnv(cfg.askEnvPath)
  const { changes, plan } = buildPlan(current, edits)
  return Response.json({ diff: renderDiff(changes), targets: plan.touchedTargets })
}
