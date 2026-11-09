import { spawn } from 'node:child_process'
import { chownSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { ScenarioStatus, ToolEvalCategory, ToolEvalScenarioResult } from '../../src/api/types.ts'
import type { ResolvedTarget } from './manager.ts'

/**
 * tool-eval-bench (github.com/SeraphimSerapis/tool-eval-bench) on the SparkMan host. Third-party code,
 * so it runs as an unprivileged account. Its JSON events (on stderr) give progress and each scenario's
 * category; the --json-file report gives the final per-scenario results.
 */
export interface ToolEvalOptions {
  bin: string
  /** unprivileged account to run it as (runuser) */
  user?: string
  workDir: string
}

interface Event {
  event?: string
  scenario_id?: string
  category?: string
  status?: string
  points?: number
  index?: number
  total?: number
  message?: string
}

const isCategory = (c: unknown): c is ToolEvalCategory => typeof c === 'string' && /^[A-O]$/.test(c)
const isStatus = (s: unknown): s is ScenarioStatus => s === 'pass' || s === 'partial' || s === 'fail'

export function runToolEval(
  opts: ToolEvalOptions, t: ResolvedTarget, suite: 'quick' | 'full', runId: string, signal: AbortSignal,
  onProgress: (p: number, stage: string, scenarios: ToolEvalScenarioResult[]) => void,
): Promise<ToolEvalScenarioResult[]> {
  const out = path.join(opts.workDir, runId)
  mkdirSync(out, { recursive: true })
  if (opts.user) {
    const uid = Number(process.env.SPARKMAN_TOOL_EVAL_UID ?? 1000)
    chownSync(opts.workDir, uid, uid)
    chownSync(out, uid, uid)
  }
  const args = [
    '--base-url', t.baseUrl, '--model', t.model, '--api-key', t.apiKey ?? 'none',
    ...(suite === 'quick' ? ['--short'] : []), '--no-live', '--no-warmup', '--output-dir', out, '--json-file', path.join(out, 'report.json'),
  ]
  const [cmd, argv] = opts.user ? ['runuser', ['-u', opts.user, '--', opts.bin, ...args]] : [opts.bin, args]
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { cwd: out, stdio: ['ignore', 'pipe', 'pipe'] })
    const results: ToolEvalScenarioResult[] = []
    const category = new Map<string, ToolEvalCategory>()
    let lastError = ''
    signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
    const onLine = (line: string) => {
      let e: Event
      try {
        e = JSON.parse(line) as Event
      } catch {
        return
      }
      if (typeof e !== 'object' || e === null) return
      if (e.event === 'scenario_start' && e.scenario_id && isCategory(e.category)) category.set(e.scenario_id, e.category)
      if (e.event === 'scenario_result' && e.scenario_id && isStatus(e.status)) {
        const cat = category.get(e.scenario_id)
        if (cat) results.push({ id: e.scenario_id, category: cat, status: e.status, points: e.status === 'pass' ? 2 : e.status === 'partial' ? 1 : 0 })
        const total = e.total ?? 0
        onProgress(total ? results.length / total : 0, `Scenario ${results.length} of ${total || '?'}`, [...results])
      }
      if (e.event === 'error') lastError = e.message ?? 'tool-eval-bench failed'
    }
    // events arrive on stderr (stdout carries the human report); read both
    createInterface({ input: child.stdout }).on('line', onLine)
    createInterface({ input: child.stderr }).on('line', onLine)
    child.on('error', reject)
    child.on('close', (code) => {
      if (signal.aborted) return resolve(results)
      const final = readReport(path.join(out, 'report.json'), category)
      if (final.length) return resolve(final)
      if (results.length) return resolve(results)
      reject(new Error(lastError || `tool-eval-bench exited ${code} without results`))
    })
  })
}

/** The report's scenario_results, with categories from the run's events. */
export function readReport(file: string, category: Map<string, ToolEvalCategory>): ToolEvalScenarioResult[] {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as { scores?: { scenario_results?: { scenario_id?: string; status?: string }[] } }
    return (r.scores?.scenario_results ?? []).flatMap((x) => {
      const cat = x.scenario_id ? category.get(x.scenario_id) : undefined
      if (!x.scenario_id || !cat || !isStatus(x.status)) return []
      return [{ id: x.scenario_id, category: cat, status: x.status, points: x.status === 'pass' ? 2 : x.status === 'partial' ? 1 : 0 }]
    })
  } catch {
    return []
  }
}
