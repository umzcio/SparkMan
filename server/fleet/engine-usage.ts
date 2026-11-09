/**
 * Traffic as the engines count it, so Usage includes requests that went straight to an engine and never through
 * the gateway (a script calling a head's port, a benchmark harness). Each engine sample's counter deltas are
 * added up per 30 s slot and deployment; usageReport() subtracts what the gateway logged for the same deployment.
 */
import type { DatabaseSync } from 'node:sqlite'

export interface EngineCounts {
  /** all prompt tokens, cached ones included */
  prompt: number
  cached: number
  generated: number
  /** finished requests */
  requests: number
}

/** Prometheus names per field, by engine (all counters; summed over label sets). */
const NAMES: Record<keyof EngineCounts, string[]> = {
  prompt: ['vllm:prompt_tokens_total', 'sglang:prompt_tokens_total', 'tensorfold:prompt_tokens_total', 'llamacpp:prompt_tokens_total'],
  cached: ['vllm:prefix_cache_hits_total', 'sglang:cached_tokens_total', 'tensorfold_health:cached_tokens_total'],
  generated: ['vllm:generation_tokens_total', 'sglang:generation_tokens_total', 'tensorfold:generation_tokens_total', 'llamacpp:tokens_predicted_total'],
  requests: ['vllm:request_success_total', 'sglang:num_requests_total', 'tensorfold:request_latency_seconds_count'],
}
const FIELD = new Map(Object.entries(NAMES).flatMap(([f, names]) => names.map((n) => [n, f as keyof EngineCounts])))
const LINE = /^([a-z_:]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$/

/** An engine's lifetime counts from a /metrics body, or null when it exposes none of them. */
export function engineCounts(text: string): EngineCounts | null {
  const c: EngineCounts = { prompt: 0, cached: 0, generated: 0, requests: 0 }
  let seen = false
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    const f = m && FIELD.get(m[1])
    if (!f) continue
    const v = Number(m[2])
    if (!Number.isFinite(v)) continue
    c[f] += v
    seen = true
  }
  return seen ? c : null
}

export interface EngineUsageRow extends EngineCounts {
  /** start of the 30 s slot */
  t: number
  deploymentId: string
  model: string
}

/** the 1 h chart's step, and a divisor of the longer ranges' steps */
export const SLOT_MS = 30_000
/** as long as the gateway keeps its requests */
const KEEP_MS = 30 * 86_400_000
const FIELDS = ['prompt', 'cached', 'generated', 'requests'] as const

export class EngineUsage {
  private db: DatabaseSync
  private last = new Map<string, EngineCounts>()
  private trimmed = 0

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`CREATE TABLE IF NOT EXISTS engine_usage (
      slot INTEGER NOT NULL, deployment_id TEXT NOT NULL, model TEXT NOT NULL,
      prompt INTEGER NOT NULL, cached INTEGER NOT NULL, generated INTEGER NOT NULL, requests INTEGER NOT NULL,
      PRIMARY KEY (slot, deployment_id)
    )`)
  }

  /**
   * A reading of a deployment's lifetime counts. The first reading only sets the baseline (an engine's history
   * before SparkMan was watching isn't attributed to now); a counter that went backwards means the engine
   * restarted, and its new value is what it served since.
   */
  record(deploymentId: string, model: string, t: number, counts: EngineCounts | null): void {
    if (!counts) {
      this.last.delete(deploymentId)
      return
    }
    const prev = this.last.get(deploymentId)
    this.last.set(deploymentId, counts)
    if (!prev) return
    const restarted = FIELDS.some((f) => counts[f] < prev[f])
    const d = Object.fromEntries(FIELDS.map((f) => [f, Math.round(restarted ? counts[f] : counts[f] - prev[f])])) as unknown as EngineCounts
    if (!FIELDS.some((f) => d[f] > 0)) return
    this.db
      .prepare(`INSERT INTO engine_usage (slot, deployment_id, model, prompt, cached, generated, requests) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (slot, deployment_id) DO UPDATE SET model = excluded.model, prompt = prompt + excluded.prompt,
          cached = cached + excluded.cached, generated = generated + excluded.generated, requests = requests + excluded.requests`)
      .run(Math.floor(t / SLOT_MS) * SLOT_MS, deploymentId, model, d.prompt, Math.min(d.cached, d.prompt), d.generated, d.requests)
    if (t - this.trimmed > 3_600_000) {
      this.trimmed = t
      this.db.prepare('DELETE FROM engine_usage WHERE slot < ?').run(t - KEEP_MS)
    }
  }

  /** Forget deployments that are gone (their next reading starts a new baseline). */
  keep(ids: Set<string>): void {
    for (const id of this.last.keys()) if (!ids.has(id)) this.last.delete(id)
  }

  rows(from: number, to: number): EngineUsageRow[] {
    return (this.db
      .prepare('SELECT slot, deployment_id, model, prompt, cached, generated, requests FROM engine_usage WHERE slot >= ? AND slot < ? ORDER BY slot')
      .all(from, to) as Record<string, unknown>[]).map((r) => ({
      t: Number(r.slot), deploymentId: String(r.deployment_id), model: String(r.model),
      prompt: Number(r.prompt), cached: Number(r.cached), generated: Number(r.generated), requests: Number(r.requests),
    }))
  }
}
