import type { GatewayPoint, ModelTokenTotals, TimeRange, UsagePoint, UsageReport } from '../../src/api/types.ts'
import { RANGE_MS, SERIES_POINTS } from '../fleet/db.ts'
import { SLOT_MS, type EngineCounts, type EngineUsageRow } from '../fleet/engine-usage.ts'
import type { GatewayDb, RequestRow } from './store.ts'

/** Usage's "key" for traffic the engines served that the gateway never saw */
export const DIRECT_KEY = { id: 'direct', name: 'Direct to engine' }

/** What the same tokens would cost on a frontier API, per million: input, cached input, output. */
export const CLOUD_PRICE_PER_M = { input: 3, cached: 0.3, output: 15 }

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

function buckets(range: TimeRange, now: number): { start: number; step: number; times: number[] } {
  const step = RANGE_MS[range] / SERIES_POINTS
  const end = Math.floor(now / step) * step
  const start = end - (SERIES_POINTS - 1) * step
  return { start, step, times: Array.from({ length: SERIES_POINTS }, (_, i) => start + i * step) }
}

function bucketed(rows: RequestRow[], start: number, step: number): RequestRow[][] {
  const out: RequestRow[][] = Array.from({ length: SERIES_POINTS }, () => [])
  for (const r of rows) {
    const i = Math.floor((r.ts - start) / step)
    if (i >= 0 && i < SERIES_POINTS) out[i].push(r)
  }
  return out
}

/** Requests the gateway actually served (unknown-model 404s never reached an upstream). */
const served = (r: RequestRow) => r.deploymentId !== null

export function gatewaySeries(db: GatewayDb, range: TimeRange, now: number): GatewayPoint[] {
  const { start, step, times } = buckets(range, now)
  const rows = db.requestsBetween(start, start + SERIES_POINTS * step).filter(served)
  const sec = step / 1000
  return bucketed(rows, start, step).map((b, i) => {
    const lat = b.map((r) => r.latencyMs).sort((x, y) => x - y)
    const ttft = b.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs])).sort((x, y) => x - y)
    return {
      t: times[i],
      rps: b.length / sec,
      p50Ms: quantile(lat, 0.5),
      p95Ms: quantile(lat, 0.95),
      ttftMs: quantile(ttft, 0.5),
      errorRate: b.length ? b.filter((r) => r.status >= 500).length / b.length : 0,
      tokensPerSec: b.reduce((s, r) => s + r.completionTokens, 0) / sec,
    }
  })
}

/** Completion tokens per second of the requests that finished in the last minute (the overview's fallback tok/s). */
export function recentTokensPerSec(db: GatewayDb, now: number): number {
  return db.requestsEndedBetween(now - 60_000, now + 1).reduce((s, r) => s + r.completionTokens, 0) / 60
}

/**
 * The engines' own counts minus what the gateway logged for the same deployment: traffic that went straight to
 * an engine. The gateway logs a request when it ends, the engine's counter moves then too, and the counters are
 * read every 15 s, so a slot's gateway surplus (counted before the engine's sample caught up) is taken off the
 * next slot instead of being lost.
 */
export function directUsage(engine: EngineUsageRow[], gateway: RequestRow[]): EngineUsageRow[] {
  const FIELDS = ['prompt', 'cached', 'generated', 'requests'] as const
  const zero = (): EngineCounts => ({ prompt: 0, cached: 0, generated: 0, requests: 0 })
  const slots = new Map<string, Map<number, { e: EngineCounts; g: EngineCounts; model: string }>>()
  const at = (dep: string, t: number, model: string) => {
    const bySlot = slots.get(dep) ?? new Map()
    slots.set(dep, bySlot)
    const slot = Math.floor(t / SLOT_MS) * SLOT_MS
    const s = bySlot.get(slot) ?? { e: zero(), g: zero(), model }
    bySlot.set(slot, s)
    return s
  }
  for (const r of engine) {
    const s = at(r.deploymentId, r.t, r.model)
    s.model = r.model
    for (const f of FIELDS) s.e[f] += r[f]
  }
  for (const r of gateway) {
    if (!r.deploymentId) continue
    const s = at(r.deploymentId, r.ts + r.latencyMs, r.model)
    s.g.prompt += r.promptTokens
    s.g.cached += r.cachedTokens
    s.g.generated += r.completionTokens
    s.g.requests++
  }
  const out: EngineUsageRow[] = []
  for (const [deploymentId, bySlot] of slots) {
    let carry = zero()
    let prev = -Infinity
    for (const [t, { e, g, model }] of [...bySlot].sort(([a], [b]) => a - b)) {
      if (t !== prev + SLOT_MS) carry = zero()
      prev = t
      const d = zero()
      const next = zero()
      for (const f of FIELDS) {
        const v = e[f] - g[f] - carry[f]
        if (v > 0) d[f] = v
        // a surplus carries one slot only: an engine that never counts some of what the gateway logs must not
        // hide later direct traffic
        else next[f] = Math.max(0, g[f] - e[f])
      }
      carry = next
      d.cached = Math.min(d.cached, d.prompt)
      if (FIELDS.some((f) => d[f] > 0)) out.push({ t, deploymentId, model, ...d })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

export function usageReport(db: GatewayDb, range: TimeRange, now: number, engine?: (from: number, to: number) => EngineUsageRow[]): UsageReport {
  const { start, step, times } = buckets(range, now)
  const end = start + SERIES_POINTS * step
  const rows = db.requestsBetween(start, end).filter(served)
  const direct = engine ? directUsage(engine(start, end), db.requestsEndedBetween(start, end).filter(served)) : []
  const keys = db.listKeys(now)
  const keyName = new Map(keys.map((k) => [k.id, k.name]))
  const points: UsagePoint[] = Array.from({ length: SERIES_POINTS }, (_, i) => ({ t: times[i], requests: 0, byModel: {}, byKey: {} }))
  const totals = new Map<string, ModelTokenTotals>()
  const perKey = new Map<string, { tokens: number; requests: number }>()
  let tokensIn = 0
  let tokensCached = 0
  let tokensOut = 0
  let requests = 0
  const add = (t: number, model: string, keyId: string | null, prompt: number, cached: number, generated: number, n: number) => {
    const i = Math.floor((t - start) / step)
    if (i < 0 || i >= SERIES_POINTS) return
    const p = points[i]
    const tokens = prompt + generated
    p.requests += n
    p.byModel[model] = (p.byModel[model] ?? 0) + tokens
    if (keyId) p.byKey[keyId] = (p.byKey[keyId] ?? 0) + tokens
    tokensIn += prompt
    tokensCached += cached
    tokensOut += generated
    requests += n
    const m = totals.get(model) ?? { model, requests: 0, prefill: 0, cached: 0, generated: 0 }
    m.requests += n
    m.prefill += Math.max(0, prompt - cached)
    m.cached += cached
    m.generated += generated
    totals.set(model, m)
    if (keyId) {
      const k = perKey.get(keyId) ?? { tokens: 0, requests: 0 }
      k.tokens += tokens
      k.requests += n
      perKey.set(keyId, k)
    }
  }
  for (const r of rows) add(r.ts, r.model, r.keyId, r.promptTokens, r.cachedTokens, r.completionTokens, 1)
  for (const d of direct) add(d.t, d.model, DIRECT_KEY.id, d.prompt, d.cached, d.generated, d.requests)
  if (perKey.has(DIRECT_KEY.id)) keyName.set(DIRECT_KEY.id, DIRECT_KEY.name)
  const modelTotals = [...totals.values()].sort((a, b) => b.requests - a.requests)
  const cloudCostUsd = ((tokensIn - tokensCached) * CLOUD_PRICE_PER_M.input + tokensCached * CLOUD_PRICE_PER_M.cached + tokensOut * CLOUD_PRICE_PER_M.output) / 1e6
  return {
    points,
    tokensIn,
    tokensCached,
    tokensOut,
    requests,
    cloudCostUsd,
    topKeys: [...perKey.entries()].map(([keyId, v]) => ({ keyId, name: keyName.get(keyId) ?? keyId, ...v })).sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    models: modelTotals.map((m) => m.model),
    modelTotals,
    keys: [...keys.map((k) => ({ id: k.id, name: k.name })), ...(perKey.has(DIRECT_KEY.id) ? [DIRECT_KEY] : [])],
  }
}

/** Per deployment, over the last minute. */
export function deploymentRates(db: GatewayDb, now: number): Map<string, { tokensPerSec: number; requestsPerSec: number }> {
  const out = new Map<string, { tokensPerSec: number; requestsPerSec: number }>()
  for (const r of db.requestsEndedBetween(now - 60_000, now + 1)) {
    if (!r.deploymentId) continue
    const v = out.get(r.deploymentId) ?? { tokensPerSec: 0, requestsPerSec: 0 }
    v.tokensPerSec += r.completionTokens / 60
    v.requestsPerSec += 1 / 60
    out.set(r.deploymentId, v)
  }
  return out
}

/** Requests shorter than this say more about scheduling than about speed. */
const MIN_DECODE = { tokens: 16, ms: 250 }

/**
 * How fast each deployment generates for one request: its last 20 streamed gateway requests from the
 * past day, tokens after the first over the time between the first token and the last.
 */
export function decodeSpeeds(db: GatewayDb, now: number): Map<string, number> {
  const sums = new Map<string, { tokens: number; ms: number }>()
  for (const r of db.recentDecodes(now - 24 * 3600_000, 20)) {
    if (r.completionTokens < MIN_DECODE.tokens || r.decodeMs < MIN_DECODE.ms) continue
    const v = sums.get(r.deploymentId) ?? { tokens: 0, ms: 0 }
    v.tokens += r.completionTokens - 1
    v.ms += r.decodeMs
    sums.set(r.deploymentId, v)
  }
  return new Map([...sums].map(([id, v]) => [id, (v.tokens * 1000) / v.ms]))
}
