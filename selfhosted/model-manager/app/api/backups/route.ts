import { listBackups } from '@/lib/backups'
import { getToolConfig } from '@/lib/config'

export async function GET() {
  const cfg = getToolConfig()
  return Response.json({ backups: await listBackups(cfg.askEnvPath) })
}
