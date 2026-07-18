import { describe, expect, it, vi } from 'vitest'
import { applyPlan, type ApplyDeps } from '../apply'
import type { RunResult } from '../exec'
import type { ToolConfig } from '../config'

const config: ToolConfig = {
  askEnvPath: '/ask/.env',
  askComposeFile: '/ask/docker-compose.yaml',
  askService: 'ask',
  backupKeep: 20,
  reranker: {
    sshTarget: 'u@h',
    sshKey: '/keys/k',
    remoteDir: '/srv/reranker',
    envFile: '.env',
    service: 'reranker'
  }
}

function deps(runImpl: (cmd: string, args: string[]) => RunResult): {
  d: ApplyDeps
  writes: string[]
  calls: string[][]
} {
  const writes: string[] = []
  const calls: string[][] = []
  const d: ApplyDeps = {
    config,
    runner: {
      run: async (cmd, args) => {
        calls.push([cmd, ...args])
        return runImpl(cmd, args)
      }
    },
    writeAskEnv: async text => {
      writes.push(text)
    },
    sleep: async () => {},
    backup: async () => '/ask/.env.bak.T'
  }
  return { d, writes, calls }
}

const ok: RunResult = { code: 0, stdout: 'healthy', stderr: '' }

describe('applyPlan', () => {
  it('writes env and restarts only ask when only ask targets changed', async () => {
    const { d, writes, calls } = deps(() => ok)
    const events: string[] = []
    const res = await applyPlan(
      { askEnvText: 'A=1\n', touchedTargets: ['ask'] },
      d,
      e => events.push(`${e.step}:${e.status}`)
    )
    expect(res.ok).toBe(true)
    expect(writes).toEqual(['A=1\n'])
    // restarts ask, never ssh
    expect(calls.some(c => c[0] === 'docker')).toBe(true)
    expect(calls.some(c => c[0] === 'ssh')).toBe(false)
  })

  it('also restarts reranker over ssh when reranker target changed', async () => {
    const { d, calls } = deps(() => ok)
    const res = await applyPlan(
      {
        askEnvText: 'A=1\n',
        touchedTargets: ['ask', 'reranker'],
        rerankerEnvText: 'RERANKER_MODEL=x\n'
      },
      d,
      () => {}
    )
    expect(res.ok).toBe(true)
    expect(calls.some(c => c[0] === 'ssh')).toBe(true)
  })

  it('reports failure independently — ask ok, reranker ssh fails', async () => {
    const { d } = deps((cmd) => (cmd === 'ssh' ? { code: 255, stdout: '', stderr: 'no route' } : ok))
    const events: { step: string; status: string }[] = []
    const res = await applyPlan(
      { askEnvText: 'A=1\n', touchedTargets: ['ask', 'reranker'], rerankerEnvText: 'x' },
      d,
      e => events.push(e)
    )
    expect(res.ok).toBe(false)
    expect(events.some(e => e.step.startsWith('ask') && e.status === 'ok')).toBe(true)
    expect(events.some(e => e.step.startsWith('reranker') && e.status === 'fail')).toBe(true)
  })
})
