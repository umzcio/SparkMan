import type { GatewayPoint, ModelTokenTotals, TimeRange, UsagePoint, UsageReport } from '../../src/api/types.ts'
import { RANGE_MS, SERIES_POINTS } from '../fleet/db.ts'
import type { GatewayDb, RequestRow } from './store.ts'

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

export function usageReport(db: GatewayDb, range: TimeRange, now: number): UsageReport {
  const { start, step, times } = buckets(range, now)
  const rows = db.requestsBetween(start, start + SERIES_POINTS * step).filter(served)
  const keys = db.listKeys(now)
  const keyName = new Map(keys.map((k) => [k.id, k.name]))
  const points: UsagePoint[] = bucketed(rows, start, step).map((b, i) => {
    const byModel: Record<string, number> = {}
    const byKey: Record<string, number> = {}
    for (const r of b) {
      byModel[r.model] = (byModel[r.model] ?? 0) + 1
      if (r.keyId) byKey[r.keyId] = (byKey[r.keyId] ?? 0) + 1
    }
    return { t: times[i], requests: b.length, byModel, byKey }
  })
  const totals = new Map<string, ModelTokenTotals>()
  const perKey = new Map<string, { tokens: number; requests: number }>()
  let tokensIn = 0
  let tokensCached = 0
  let tokensOut = 0
  for (const r of rows) {
    tokensIn += r.promptTokens
    tokensCached += r.cachedTokens
    tokensOut += r.completionTokens
    const t = totals.get(r.model) ?? { model: r.model, requests: 0, prefill: 0, cached: 0, generated: 0 }
    t.requests++
    t.prefill += Math.max(0, r.promptTokens - r.cachedTokens)
    t.cached += r.cachedTokens
    t.generated += r.completionTokens
    totals.set(r.model, t)
    if (r.keyId) {
      const k = perKey.get(r.keyId) ?? { tokens: 0, requests: 0 }
      k.tokens += r.promptTokens + r.completionTokens
      k.requests++
      perKey.set(r.keyId, k)
    }
  }
  const modelTotals = [...totals.values()].sort((a, b) => b.requests - a.requests)
  const cloudCostUsd = ((tokensIn - tokensCached) * CLOUD_PRICE_PER_M.input + tokensCached * CLOUD_PRICE_PER_M.cached + tokensOut * CLOUD_PRICE_PER_M.output) / 1e6
  return {
    points,
    tokensIn,
    tokensCached,
    tokensOut,
    requests: rows.length,
    cloudCostUsd,
    topKeys: [...perKey.entries()].map(([keyId, v]) => ({ keyId, name: keyName.get(keyId) ?? keyId, ...v })).sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    models: modelTotals.map((m) => m.model),
    modelTotals,
    keys: keys.map((k) => ({ id: k.id, name: k.name })),
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
