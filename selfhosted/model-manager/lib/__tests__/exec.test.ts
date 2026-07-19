import { describe, expect, it } from 'vitest'
import { realRunner } from '../exec'

describe('realRunner', () => {
  it('captures stdout and exit code', async () => {
    const r = await realRunner.run('node', ['-e', "process.stdout.write('hi')"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('hi')
  })
  it('passes input on stdin', async () => {
    const r = await realRunner.run(
      'node',
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { input: 'piped' }
    )
    expect(r.stdout).toBe('piped')
  })
  it('reports non-zero exit', async () => {
    const r = await realRunner.run('node', ['-e', 'process.exit(3)'])
    expect(r.code).toBe(3)
  })
  it('marks stderr when a command times out', async () => {
    const r = await realRunner.run(
      'node',
      ['-e', 'setTimeout(() => {}, 10000)'],
      {
        timeoutMs: 300
      }
    )
    expect(r.stderr).toContain('timed out')
  })
})
