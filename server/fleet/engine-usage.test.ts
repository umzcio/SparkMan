// @vitest-environment node
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { directUsage } from '../gateway/stats.ts'
import type { RequestRow } from '../gateway/store.ts'
import { engineCounts, EngineUsage, SLOT_MS } from './engine-usage.ts'

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0)
const counts = (prompt: number, generated: number, requests: number, cached = 0) => ({ prompt, cached, generated, requests })
const req = (over: Partial<RequestRow>): RequestRow => ({
  ts: T0, keyId: 'k1', model: 'm', deploymentId: 'd1', nodeId: 'n1', path: 'chat/completions', status: 200, latencyMs: 1000,
  ttftMs: 100, promptTokens: 0, cachedTokens: 0, completionTokens: 0, error: null, ...over,
})

describe('engineCounts', () => {
  it('sums each engine family over label sets', () => {
    const text = [
      '# TYPE tensorfold:prompt_tokens_total counter',
      'tensorfold:prompt_tokens_total{model="a"} 100',
      'tensorfold:prompt_tokens_total{model="b"} 50',
      'tensorfold:generation_tokens_total 40',
      'tensorfold:generation_tokens_running 7',
      'tensorfold_health:cached_tokens_total 30',
      'tensorfold:request_latency_seconds_count 3',
      'tensorfold:request_latency_seconds_sum 9.5',
    ].join('\n')
    expect(engineCounts(text)).toEqual({ prompt: 150, cached: 30, generated: 40, requests: 3 })
    expect(engineCounts('vllm:prompt_tokens_total 5\nvllm:request_success_total{finished_reason="stop"} 2')).toEqual({ prompt: 5, cached: 0, generated: 0, requests: 2 })
    expect(engineCounts('process_cpu_seconds_total 1')).toBeNull()
  })
})

describe('EngineUsage', () => {
  it('stores deltas per slot after a baseline, and takes a reset counter as served since the restart', () => {
    const u = new EngineUsage(new DatabaseSync(':memory:'))
    u.record('d1', 'm', T0, counts(1000, 500, 10))
    u.record('d1', 'm', T0 + 15_000, counts(1100, 560, 12))
    u.record('d1', 'm', T0 + 20_000, counts(1150, 580, 13))
    u.record('d1', 'm', T0 + 45_000, counts(30, 20, 1))
    expect(u.rows(T0, T0 + 2 * SLOT_MS)).toEqual([
      { t: T0, deploymentId: 'd1', model: 'm', prompt: 150, cached: 0, generated: 80, requests: 3 },
      { t: T0 + SLOT_MS, deploymentId: 'd1', model: 'm', prompt: 30, cached: 0, generated: 20, requests: 1 },
    ])
  })
  it('starts a new baseline after a failed reading', () => {
    const u = new EngineUsage(new DatabaseSync(':memory:'))
    u.record('d1', 'm', T0, counts(100, 10, 1))
    u.record('d1', 'm', T0 + 15_000, null)
    u.record('d1', 'm', T0 + 30_000, counts(900, 90, 9))
    expect(u.rows(T0, T0 + 10 * SLOT_MS)).toEqual([])
  })
})

describe('directUsage', () => {
  it('is what the engine counted beyond the gateway', () => {
    const engine = [{ t: T0, deploymentId: 'd1', model: 'm', ...counts(1000, 300, 5) }]
    const gw = [req({ ts: T0, latencyMs: 2000, promptTokens: 400, completionTokens: 100 })]
    expect(directUsage(engine, gw)).toEqual([{ t: T0, deploymentId: 'd1', model: 'm', ...counts(600, 200, 4) }])
  })
  it('is nothing when all traffic went through the gateway, even when the engine sample lands a slot later', () => {
    const gw = [req({ ts: T0 + 20_000, latencyMs: 8000, promptTokens: 400, completionTokens: 100 })]
    const engine = [{ t: T0 + SLOT_MS, deploymentId: 'd1', model: 'm', ...counts(400, 100, 1) }]
    expect(directUsage(engine, gw)).toEqual([])
  })
  it('carries a gateway surplus one slot only', () => {
    const gw = [req({ ts: T0, latencyMs: 0, promptTokens: 400, completionTokens: 100 })]
    const engine = [{ t: T0 + 2 * SLOT_MS, deploymentId: 'd1', model: 'm', ...counts(400, 100, 1) }]
    expect(directUsage(engine, gw)).toEqual([{ t: T0 + 2 * SLOT_MS, deploymentId: 'd1', model: 'm', ...counts(400, 100, 1) }])
  })
})
