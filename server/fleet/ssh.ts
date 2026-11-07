import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface SshTarget {
  id: string
  ip: string
}

export interface SshResult {
  code: number
  stdout: string
  stderr: string
}

export interface SshRunner {
  /** Run one command (argv joined by the remote shell). Resolves with the exit code; rejects only on spawn errors. */
  run(target: SshTarget, command: string, opts?: { timeoutMs?: number; input?: string }): Promise<SshResult>
  /** Start a long-lived command; stdin receives `input` then closes. */
  stream(target: SshTarget, command: string, input?: string): ChildProcessWithoutNullStreams
  close(): void
}

/**
 * OpenSSH with one multiplexed master per box (ControlMaster/ControlPersist, as in sparkDash), so the
 * 2 s sampler and on-demand commands share a TCP connection. Key auth only, BatchMode — never prompts.
 */
export function createSshRunner(user: string, keyPath: string): SshRunner {
  const controlDir = mkdtempSync(path.join(os.tmpdir(), 'sparkman-ssh-'))
  const base = (t: SshTarget) => [
    '-i', keyPath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPersist=120',
    '-o', `ControlPath=${controlDir}/${t.id}`,
    `${user}@${t.ip}`,
  ]
  return {
    run(target, command, opts = {}) {
      return new Promise((resolve, reject) => {
        const child = execFile('ssh', [...base(target), command], { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err && typeof (err as NodeJS.ErrnoException).code === 'string') return reject(err)
          const code = err ? ((err as { code?: number }).code ?? (err.killed ? 124 : 1)) : 0
          resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr })
        })
        if (opts.input !== undefined) child.stdin?.end(opts.input)
        else child.stdin?.end()
      })
    },
    stream(target, command, input) {
      const child = spawn('ssh', [...base(target), command], { stdio: ['pipe', 'pipe', 'pipe'] })
      if (input !== undefined) child.stdin.end(input)
      return child
    },
    close() {
      rmSync(controlDir, { recursive: true, force: true })
    },
  }
}

/** Quote one argument for the remote POSIX shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
