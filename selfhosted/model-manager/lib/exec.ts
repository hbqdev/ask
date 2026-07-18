import { spawn } from 'child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface Runner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number; input?: string }
  ): Promise<RunResult>
}

export const realRunner: Runner = {
  run(cmd, args, opts = {}) {
    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd })
      let stdout = ''
      let stderr = ''
      let timer: NodeJS.Timeout | undefined
      if (opts.timeoutMs) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs)
      }
      child.stdout.on('data', d => (stdout += d.toString()))
      child.stderr.on('data', d => (stderr += d.toString()))
      child.on('error', reject)
      child.on('close', code => {
        if (timer) clearTimeout(timer)
        resolve({ code: code ?? -1, stdout, stderr })
      })
      if (opts.input !== undefined) child.stdin.end(opts.input)
      else child.stdin.end()
    })
  }
}
