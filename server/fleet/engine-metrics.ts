/**
 * Each engine's running count of generated tokens, from its Prometheus /metrics. TensorFold's total only moves when a
 * request finishes, so its running requests' tokens so far (a gauge) are added: the sum climbs while a request streams.
 */
const COUNTERS = ['vllm:generation_tokens_total', 'sglang:generation_tokens_total', 'tensorfold:generation_tokens_total', 'tensorfold:generation_tokens_running', 'llamacpp:tokens_predicted_total']
const LINE = /^([a-z_:]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$/

/** Total generated tokens in a /metrics body (summed over label sets), or null when it has no known counter. */
export function generatedTokens(text: string): number | null {
  let total: number | null = null
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    if (!m || !COUNTERS.includes(m[1])) continue
    const v = Number(m[2])
    if (Number.isFinite(v)) total = (total ?? 0) + v
  }
  return total
}

/** The window a rate is taken over, and the shortest span worth reporting. */
const WINDOW_MS = 60_000
const MIN_SPAN_MS = 10_000

/** Tokens per second per deployment, from successive counter readings. */
export class TokenCounters {
  private samples = new Map<string, { t: number; v: number }[]>()

  /** A reading; null when the engine didn't answer or has no counter, which forgets the deployment. */
  record(id: string, t: number, v: number | null): void {
    if (v === null) {
      this.samples.delete(id)
      return
    }
    const list = this.samples.get(id) ?? []
    // the counter went backwards: the server restarted
    const last = list.at(-1)
    const kept = last && v < last.v ? [] : list.filter((s) => s.t >= t - WINDOW_MS - MIN_SPAN_MS)
    kept.push({ t, v })
    this.samples.set(id, kept)
  }

  /** Forget deployments that are gone. */
  keep(ids: Set<string>): void {
    for (const id of this.samples.keys()) if (!ids.has(id)) this.samples.delete(id)
  }

  rate(id: string): number | null {
    const list = this.samples.get(id)
    if (!list || list.length < 2) return null
    const last = list.at(-1)!
    const first = list.find((s) => s.t >= last.t - WINDOW_MS) ?? list[0]
    const from = first === last ? list.at(-2)! : first
    const span = last.t - from.t
    return span >= MIN_SPAN_MS ? ((last.v - from.v) * 1000) / span : null
  }
}
