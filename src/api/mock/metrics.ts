import type { GatewayPoint, MetricPoint, ModelTokenTotals, TimeRange, UsageReport } from '../types'
import { CACHE_HIT_BASE, CLOUD_PRICE_PER_M, DEFAULT_CACHE_HIT, INPUT_TOKEN_SHARE, type DeploymentSpec, type KeySpec, type NodeSpec } from './fixtures'
import { clamp, noise, smoothNoise } from './rng'

export const SERIES_POINTS = 120
export const RANGE_MS: Record<TimeRange, number> = {
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '6h': 6 * 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
}

export interface Outage {
  nodeId: string
  from: number
  to: number | null
}

export interface MetricWorld {
  seed: number
  outages: Outage[]
  gatewayErrorWindows: { from: number; to: number | null }[]
  /** front-fan airflow at a box (0–1 of max RPM) at time t; null when no fan covers it */
  airflow?: (nodeId: string, t: number) => number | null
}

/** °C a box gains (+) or loses (−) from its fan's airflow; ~0 at the auto curve's usual 55 %, bigger under load. */
export function airflowOffsetC(flow: number, gpuUtil: number): number {
  return (0.4 + (0.6 * gpuUtil) / 100) * 14 * (0.55 - flow)
}

const GB = 1024 ** 3
const MB = 1024 ** 2

export function seriesTimes(range: TimeRange, now: number): number[] {
  const step = RANGE_MS[range] / SERIES_POINTS
  const end = Math.floor(now / step) * step
  return Array.from({ length: SERIES_POINTS }, (_, i) => end - (SERIES_POINTS - 1 - i) * step)
}

export function isOffline(outages: Outage[], nodeId: string, t: number): boolean {
  return outages.some((o) => o.nodeId === nodeId && t >= o.from && (o.to === null || t < o.to))
}

const inWindow = (ws: { from: number; to: number | null }[], t: number) =>
  ws.some((w) => t >= w.from && (w.to === null || t < w.to))

/** Working-hours curve: ~0.25 overnight, ~1.0 mid-afternoon (local time). */
export function DIURNAL(t: number): number {
  const d = new Date(t)
  const hour = d.getHours() + d.getMinutes() / 60
  return 0.625 + 0.375 * Math.sin(((hour - 9) / 24) * 2 * Math.PI)
}

export function deploymentLoad(seed: number, dep: DeploymentSpec, t: number): number {
  const slow = smoothNoise(20 * 60_000, t, seed, dep.id, 'slow')
  const fast = smoothNoise(90_000, t, seed, dep.id, 'fast')
  const raw = dep.trafficWeight * DIURNAL(t) * (0.55 + 0.35 * slow + 0.25 * fast)
  return clamp(raw, 0, 1)
}

const NULL_POINT = (t: number): MetricPoint => ({
  t, gpuUtil: null, memUsedGB: null, gpuPowerW: null, gpuTempC: null, acpiTempC: null, cpuUser: null, cpuSystem: null,
  netRxBps: null, netTxBps: null, cx7RxBps: null, cx7TxBps: null, diskReadBps: null, diskWriteBps: null, diskUsedPct: null,
})

export function sampleNode(world: MetricWorld, node: NodeSpec, dep: DeploymentSpec | null, t: number): MetricPoint {
  if (isOffline(world.outages, node.id, t)) return NULL_POINT(t)
  const n = (k: string) => noise(world.seed, node.id, k, Math.floor(t / 5000))
  const load = dep ? deploymentLoad(world.seed, dep, t) : 0.02
  const grouped = dep?.replicas.some((r) => r.nodeIds.length > 1 && r.nodeIds.includes(node.id)) ?? false
  const gpuUtil = clamp(dep ? load * 100 * (0.88 + 0.12 * n('u')) : 1 + 3 * n('u'), 0, 100)
  const memUsedGB = clamp(7 + (dep?.memoryGBPerNode ?? 0) + load * 6 + n('m') * 0.8, 1, 126)
  const gpuPowerW = clamp(11 + gpuUtil * 0.82 + n('p') * 3, 5, 99)
  const thermal = node.thermalIssue ? 18 + 6 * smoothNoise(15 * 60_000, t, world.seed, node.id, 'th') : 0
  const flow = world.airflow?.(node.id, t) ?? null
  const cooled = flow === null ? 0 : airflowOffsetC(flow, gpuUtil)
  const gpuTempC = clamp(36 + gpuUtil * 0.38 + n('t') * 2 + thermal + cooled, 25, 102)
  const acpiTempC = gpuTempC + 8 + n('a') * 5
  return {
    t,
    gpuUtil,
    memUsedGB,
    gpuPowerW,
    gpuTempC,
    acpiTempC,
    cpuUser: clamp(3 + load * 18 + n('cu') * 4, 0, 100),
    cpuSystem: clamp(1 + load * 4 + n('cs') * 1.5, 0, 100),
    netRxBps: 50 * 1024 + load * 2.5 * MB * (0.7 + 0.6 * n('rx')),
    netTxBps: 20 * 1024 + load * 4 * MB * (0.7 + 0.6 * n('tx')),
    cx7RxBps: grouped ? load * 6 * GB * (0.6 + 0.4 * n('crx')) + 2e8 : n('crx') * 2e4,
    cx7TxBps: grouped ? load * 6 * GB * (0.6 + 0.4 * n('ctx')) + 2e8 : n('ctx') * 2e4,
    diskReadBps: (1 + 19 * n('dr')) * MB,
    diskWriteBps: (1 + 4 * n('dw')) * MB,
    diskUsedPct: clamp(node.diskBasePct + 0.5 * smoothNoise(6 * 3_600_000, t, node.id, 'disk'), 0, 100),
  }
}

export function nodeSeries(world: MetricWorld, node: NodeSpec, dep: DeploymentSpec | null, range: TimeRange, now: number): MetricPoint[] {
  return seriesTimes(range, now).map((t) => sampleNode(world, node, dep, t))
}

export function gatewayPoint(world: MetricWorld, deps: DeploymentSpec[], t: number): GatewayPoint {
  let rps = 0
  let tps = 0
  let loadSum = 0
  for (const d of deps) {
    const l = deploymentLoad(world.seed, d, t)
    rps += l * d.peakRps
    tps += l * d.peakTokensPerSec * d.replicas.length
    loadSum += l
  }
  const avgLoad = deps.length ? loadSum / deps.length : 0
  const n = (k: string) => noise(world.seed, 'gw', k, Math.floor(t / 5000))
  const erroring = inWindow(world.gatewayErrorWindows, t)
  return {
    t,
    rps,
    tokensPerSec: tps,
    p50Ms: 900 + avgLoad * 1400 + n('p50') * 200,
    p95Ms: 3200 + avgLoad * 5200 + n('p95') * 900,
    ttftMs: 160 + avgLoad * 420 + n('ttft') * 60,
    errorRate: erroring ? 0.06 + 0.04 * n('err') : 0.001 + 0.003 * n('err'),
  }
}

export function gatewaySeries(world: MetricWorld, deps: DeploymentSpec[], range: TimeRange, now: number): GatewayPoint[] {
  return seriesTimes(range, now).map((t) => gatewayPoint(world, deps, t))
}

/**
 * Share of a deployment's prompt tokens served from the prefix cache at time t (drifts ±10 points).
 * Real backend: vLLM's prefix-cache hit/query counters per engine, or per request from the gateway via
 * OpenAI `usage.prompt_tokens_details.cached_tokens` / Anthropic `cache_read_input_tokens`.
 */
export function cacheHitRate(seed: number, dep: DeploymentSpec, t: number): number {
  const base = CACHE_HIT_BASE[dep.model] ?? DEFAULT_CACHE_HIT
  return clamp(base + 0.2 * (smoothNoise(30 * 60_000, t, seed, dep.id, 'cache') - 0.5), 0, 0.9)
}

export function usageReport(world: MetricWorld, deps: DeploymentSpec[], keys: KeySpec[], range: TimeRange, now: number): UsageReport {
  const active = keys.filter((k) => k.revokedAgoMs === null)
  const stepSec = RANGE_MS[range] / SERIES_POINTS / 1000
  const keyTotals = new Map<string, { tokens: number; requests: number }>()
  let tokens = 0
  let requests = 0
  const modelTotals = new Map<string, ModelTokenTotals>()
  const points = seriesTimes(range, now).map((t) => {
    const byModel: Record<string, number> = {}
    let pointTokens = 0
    let pointReq = 0
    for (const d of deps) {
      const l = deploymentLoad(world.seed, d, t)
      const tok = l * d.peakTokensPerSec * d.replicas.length * stepSec
      byModel[d.model] = (byModel[d.model] ?? 0) + tok
      pointTokens += tok
      pointReq += l * d.peakRps * stepSec
      const input = tok * INPUT_TOKEN_SHARE
      const cached = input * cacheHitRate(world.seed, d, t)
      const m = modelTotals.get(d.model) ?? { model: d.model, requests: 0, prefill: 0, cached: 0, generated: 0 }
      m.requests += l * d.peakRps * stepSec
      m.cached += cached
      m.prefill += input - cached
      m.generated += tok - input
      modelTotals.set(d.model, m)
    }
    const weights = active.map((k) => k.share * (0.75 + 0.5 * noise(world.seed, k.id, Math.floor(t / 600_000))))
    const wSum = weights.reduce((a, b) => a + b, 0)
    const byKey: Record<string, number> = {}
    active.forEach((k, i) => {
      // all-zero shares (e.g. only freshly created keys): split evenly instead of 0/0
      const share = wSum > 0 ? weights[i] / wSum : 1 / active.length
      byKey[k.id] = pointTokens * share
      const acc = keyTotals.get(k.id) ?? { tokens: 0, requests: 0 }
      acc.tokens += pointTokens * share
      acc.requests += pointReq * share
      keyTotals.set(k.id, acc)
    })
    tokens += pointTokens
    requests += pointReq
    return { t, requests: pointReq, byModel, byKey }
  })
  const tokensIn = tokens * INPUT_TOKEN_SHARE
  const tokensOut = tokens - tokensIn
  const totals = [...modelTotals.values()].sort((a, b) => b.prefill + b.cached + b.generated - (a.prefill + a.cached + a.generated))
  const tokensCached = totals.reduce((s, m) => s + m.cached, 0)
  return {
    points,
    tokensIn,
    tokensCached,
    tokensOut,
    requests,
    cloudCostUsd:
      ((tokensIn - tokensCached) / 1e6) * CLOUD_PRICE_PER_M.input + (tokensCached / 1e6) * CLOUD_PRICE_PER_M.cachedInput + (tokensOut / 1e6) * CLOUD_PRICE_PER_M.output,
    topKeys: active
      .map((k) => ({ keyId: k.id, name: k.name, ...(keyTotals.get(k.id) ?? { tokens: 0, requests: 0 }) }))
      .sort((a, b) => b.tokens - a.tokens),
    models: [...new Set(deps.map((d) => d.model))],
    modelTotals: totals,
    keys: active.map((k) => ({ id: k.id, name: k.name })),
  }
}
