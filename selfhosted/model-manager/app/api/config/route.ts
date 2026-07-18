import { toValueMap, parseEnv } from '@/lib/env-file'
import { REGISTRY } from '@/lib/env-schema'
import { getToolConfig } from '@/lib/config'
import { readAskEnv } from '@/lib/env-io'

export async function GET() {
  const cfg = getToolConfig()
  const map = toValueMap(parseEnv(await readAskEnv(cfg.askEnvPath)))
  const values: Record<string, string> = {}
  const secretSet: Record<string, boolean> = {}
  for (const s of REGISTRY) {
    const v = map[s.key]
    if (s.type === 'secret') {
      secretSet[s.key] = !!v // presence only, never the value
      values[s.key] = ''
    } else {
      values[s.key] = v ?? ''
    }
  }
  return Response.json({
    values,
    secretSet,
    rerankerManaged: !!cfg.reranker
  })
}
