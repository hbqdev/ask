import type { Change } from './diff'
import { computeChanges } from './diff'
import { parseEnv, serializeEnv, setValue, toValueMap } from './env-file'
import { specByKey } from './env-schema'
import type { ApplyPlan } from './apply'

// RERANKER_MODEL lives in the reranker's own .env on nightfuryS. Everything
// else is an Ask .env var. The reranker's remote .env only needs the model
// line (its token line is managed on the box); we send a single-key file.
export function buildPlan(
  currentText: string,
  edits: Record<string, string>
): { plan: ApplyPlan; changes: Change[]; rerankerCurrentText?: string } {
  const currentDoc = parseEnv(currentText)
  const current = toValueMap(currentDoc)

  const next = { ...current }
  let askDoc = currentDoc
  const targets = new Set<'ask' | 'reranker'>()
  let rerankerModel: string | undefined

  for (const [key, value] of Object.entries(edits)) {
    if (current[key] === value) continue
    next[key] = value
    const target = specByKey(key)?.target ?? 'ask'
    if (target === 'reranker') {
      targets.add('reranker')
      if (key === 'RERANKER_MODEL') rerankerModel = value
    } else {
      targets.add('ask')
      askDoc = setValue(askDoc, key, value)
    }
  }

  const changes = computeChanges(current, next)
  const plan: ApplyPlan = {
    askEnvText: serializeEnv(askDoc),
    touchedTargets: [...targets],
    rerankerEnvText:
      rerankerModel !== undefined ? `RERANKER_MODEL=${rerankerModel}\n` : undefined
  }
  return { plan, changes }
}
