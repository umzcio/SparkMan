import { describe, expect, it } from 'vitest'
import { DEPLOYMENT_SPECS, KEY_SPECS, NODE_SPECS } from './fixtures'
import {
  SERIES_POINTS, airflowOffsetC, deploymentLoad, gatewaySeries, isOffline, nodeSeries, sampleNode, seriesTimes, usageReport,
  type MetricWorld,
} from './metrics'

const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime()
const world: MetricWorld = { seed: 1729, outages: [], gatewayErrorWindows: [] }
const depFor = (id: string) => DEPLOYMENT_SPECS.find((d) => d.replicas.some((r) => r.nodeIds.includes(id))) ?? null

describe('metrics model', () => {
  it('seriesTimes returns 120 aligned points ending at or before now', () => {
    const ts = seriesTimes('1h', NOW + 1234)
    expect(ts).toHaveLength(SERIES_POINTS)
    expect(ts[ts.length - 1]).toBeLessThanOrEqual(NOW + 1234)
    expect(seriesTimes('1h', NOW + 1234)).toEqual(ts)
  })

  it('deploymentLoad stays within 0..1', () => {
    for (const d of DEPLOYMENT_SPECS) {
      for (let i = 0; i < 500; i++) {
        const l = deploymentLoad(1729, d, NOW - i * 600_000)
        expect(l).toBeGreaterThanOrEqual(0)
        expect(l).toBeLessThanOrEqual(1)
      }
    }
  })

  it('every node sample over 7 days stays in physical bounds', () => {
    for (const node of NODE_SPECS) {
      for (const p of nodeSeries(world, node, depFor(node.id), '7d', NOW)) {
        expect(p.gpuUtil!).toBeGreaterThanOrEqual(0)
        expect(p.gpuUtil!).toBeLessThanOrEqual(100)
        expect(p.memUsedGB!).toBeGreaterThan(0)
        expect(p.memUsedGB!).toBeLessThanOrEqual(128)
        expect(p.gpuTempC!).toBeGreaterThan(20)
        expect(p.gpuTempC!).toBeLessThan(105)
        expect(p.acpiTempC!).toBeGreaterThan(p.gpuTempC!)
        expect(p.gpuPowerW!).toBeLessThanOrEqual(100)
        expect(p.diskUsedPct!).toBeLessThanOrEqual(100)
      }
    }
  })

  it('is deterministic for the same world and time', () => {
    const n = NODE_SPECS[0]
    expect(sampleNode(world, n, depFor(n.id), NOW)).toEqual(sampleNode(world, n, depFor(n.id), NOW))
  })

  it('only multi-node replicas move traffic over ConnectX-7', () => {
    const single = NODE_SPECS.find((n) => n.id === 'spark-04')!
    const grouped = NODE_SPECS.find((n) => n.id === 'spark-01')!
    expect(sampleNode(world, single, depFor('spark-04'), NOW).cx7RxBps).toBeLessThan(1e6)
    expect(sampleNode(world, grouped, depFor('spark-01'), NOW).cx7RxBps).toBeGreaterThan(1e8)
  })

  it('the thermal-issue node runs hotter than its peers on average', () => {
    const avgTemp = (id: string) => {
      const node = NODE_SPECS.find((n) => n.id === id)!
      const s = nodeSeries(world, node, depFor(id), '24h', NOW)
      return s.reduce((a, p) => a + p.gpuTempC!, 0) / s.length
    }
    expect(avgTemp('spark-05')).toBeGreaterThan(avgTemp('spark-04') + 8)
  })

  it('outages produce null metrics inside the window only', () => {
    const w: MetricWorld = { ...world, outages: [{ nodeId: 'spark-03', from: NOW - 60_000, to: null }] }
    const node = NODE_SPECS.find((n) => n.id === 'spark-03')!
    expect(isOffline(w.outages, 'spark-03', NOW)).toBe(true)
    expect(sampleNode(w, node, depFor('spark-03'), NOW).gpuUtil).toBeNull()
    expect(sampleNode(w, node, depFor('spark-03'), NOW - 120_000).gpuUtil).not.toBeNull()
  })

  it('gateway error windows raise the error rate', () => {
    const calm = gatewaySeries(world, DEPLOYMENT_SPECS, '15m', NOW)
    const bad = gatewaySeries({ ...world, gatewayErrorWindows: [{ from: NOW - 900_000, to: null }] }, DEPLOYMENT_SPECS, '15m', NOW)
    const avg = (s: typeof calm) => s.reduce((a, p) => a + p.errorRate, 0) / s.length
    expect(avg(calm)).toBeLessThan(0.01)
    expect(avg(bad)).toBeGreaterThan(0.04)
  })

  it('usage report splits tokens across active keys and models', () => {
    const r = usageReport(world, DEPLOYMENT_SPECS, KEY_SPECS, '24h', NOW)
    expect(r.points).toHaveLength(SERIES_POINTS)
    expect(r.tokensIn + r.tokensOut).toBeGreaterThan(0)
    expect(r.tokensIn).toBeGreaterThan(r.tokensOut)
    expect(r.keys.map((k) => k.id)).not.toContain('key-old')
    expect(r.topKeys[0].name).toBe('claude-code-laptop')
    expect(r.cloudCostUsd).toBeGreaterThan(0)
    const p = r.points[60]
    const byModel = Object.values(p.byModel).reduce((a, b) => a + b, 0)
    const byKey = Object.values(p.byKey).reduce((a, b) => a + b, 0)
    expect(byKey).toBeCloseTo(byModel, 0)
  })
  it('usage report never yields NaN when every active key has a zero share', () => {
    const keys = KEY_SPECS.filter((k) => k.revokedAgoMs === null).map((k) => ({ ...k, share: 0 }))
    const r = usageReport(world, DEPLOYMENT_SPECS, keys, '24h', NOW)
    expect(r.topKeys.length).toBeGreaterThan(0)
    for (const k of r.topKeys) {
      expect(Number.isNaN(k.tokens)).toBe(false)
      expect(Number.isNaN(k.requests)).toBe(false)
    }
    for (const p of r.points) expect(Object.values(p.byKey).some(Number.isNaN)).toBe(false)
    const none = usageReport(world, DEPLOYMENT_SPECS, [], '24h', NOW)
    expect(none.topKeys).toEqual([])
    expect(none.points.every((p) => Object.keys(p.byKey).length === 0)).toBe(true)
  })
})


describe('airflow', () => {
  const node = NODE_SPECS.find((n) => n.id === 'spark-02')!
  const t = new Date(2026, 9, 8, 15, 0, 0).getTime()
  const world = (flow: number | null): MetricWorld => ({ seed: 1729, outages: [], gatewayErrorWindows: [], airflow: () => flow })

  it('slow fans run a loaded box ~11 °C hotter than full fans', () => {
    expect(airflowOffsetC(0.2, 100) - airflowOffsetC(1, 100)).toBeCloseTo(11.2)
    expect(airflowOffsetC(0.2, 0) - airflowOffsetC(1, 0)).toBeCloseTo(4.48)
  })

  it('moves the sampled GPU temperature, and leaves uncooled boxes alone', () => {
    const slow = sampleNode(world(0.2), node, null, t).gpuTempC!
    const fast = sampleNode(world(1), node, null, t).gpuTempC!
    const none = sampleNode(world(null), node, null, t).gpuTempC!
    const legacy = sampleNode({ seed: 1729, outages: [], gatewayErrorWindows: [] }, node, null, t).gpuTempC!
    expect(slow).toBeGreaterThan(fast)
    expect(none).toBe(legacy)
  })
})

describe('token mix', () => {
  const r = usageReport(world, DEPLOYMENT_SPECS, KEY_SPECS, '24h', NOW)
  const sum = (f: (m: (typeof r.modelTotals)[number]) => number) => r.modelTotals.reduce((s, m) => s + f(m), 0)

  it('splits prompt tokens into cached and prefill', () => {
    expect(r.tokensCached).toBeGreaterThan(0)
    expect(r.tokensCached).toBeLessThan(r.tokensIn)
  })

  it('per-model rows add up to the totals', () => {
    expect(r.modelTotals.map((m) => m.model).sort()).toEqual([...r.models].sort())
    expect(sum((m) => m.prefill + m.cached)).toBeCloseTo(r.tokensIn, 0)
    expect(sum((m) => m.cached)).toBeCloseTo(r.tokensCached, 0)
    expect(sum((m) => m.generated)).toBeCloseTo(r.tokensOut, 0)
    expect(sum((m) => m.requests)).toBeCloseTo(r.requests, 3)
    // busiest first
    const totals = r.modelTotals.map((m) => m.prefill + m.cached + m.generated)
    expect(totals).toEqual([...totals].sort((a, b) => b - a))
  })

  it('coding agents hit the prefix cache far more than chat traffic', () => {
    const hit = (model: string) => {
      const m = r.modelTotals.find((x) => x.model === model)!
      return m.cached / (m.cached + m.prefill)
    }
    expect(hit('qwen3-coder-30b-a3b')).toBeGreaterThan(0.5)
    expect(hit('llama-3.1-8b-instruct')).toBeLessThan(0.3)
  })

  it('prices cached prompt tokens at the cache-read rate', () => {
    const prefill = r.tokensIn - r.tokensCached
    const expected = (prefill / 1e6) * 3 + (r.tokensCached / 1e6) * 0.3 + (r.tokensOut / 1e6) * 15
    expect(r.cloudCostUsd).toBeCloseTo(expected, 6)
  })
})
