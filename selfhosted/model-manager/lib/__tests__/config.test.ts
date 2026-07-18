import { describe, expect, it } from 'vitest'
import { getToolConfig } from '../config'

describe('getToolConfig', () => {
  it('applies defaults', () => {
    const c = getToolConfig({})
    expect(c.askEnvPath).toBe('/ask/.env')
    expect(c.askService).toBe('ask')
    expect(c.backupKeep).toBe(20)
    expect(c.reranker).toBeNull()
  })
  it('builds reranker config when ssh vars present', () => {
    const c = getToolConfig({
      RERANKER_SSH_TARGET: 'u@h',
      RERANKER_REMOTE_DIR: '/srv/reranker'
    })
    expect(c.reranker).toEqual({
      sshTarget: 'u@h',
      sshKey: '/keys/nightfurys',
      remoteDir: '/srv/reranker',
      envFile: '.env',
      service: 'reranker'
    })
  })
  it('parses backupKeep as int', () => {
    expect(getToolConfig({ MODEL_MANAGER_BACKUP_KEEP: '5' }).backupKeep).toBe(5)
  })
})
