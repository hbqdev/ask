import { ConfigForm, ConfigData } from '@/components/config-form'
import { getToolConfig } from '@/lib/config'
import { readAskEnv } from '@/lib/env-io'
import { parseEnv, toValueMap } from '@/lib/env-file'
import { REGISTRY } from '@/lib/env-schema'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const cfg = getToolConfig()
  const map = toValueMap(parseEnv(await readAskEnv(cfg.askEnvPath)))
  const values: Record<string, string> = {}
  const secretSet: Record<string, boolean> = {}
  for (const s of REGISTRY) {
    if (s.type === 'secret') {
      secretSet[s.key] = !!map[s.key]
      values[s.key] = ''
    } else values[s.key] = map[s.key] ?? ''
  }
  const initial: ConfigData = {
    values,
    secretSet,
    rerankerManaged: !!cfg.reranker
  }
  return <ConfigForm initial={initial} />
}
