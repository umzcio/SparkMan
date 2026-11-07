import { describe, expect, it } from 'vitest'
import type { UsageReport } from '@/api/types'
import { toUsageChart } from './to-chart'

const report: UsageReport = {
  points: [{ t: 1, requests: 2, byModel: { 'qwen3.6-35b-a3b': 10, 'gpt-oss-120b': 5 }, byKey: { 'key-a': 9, 'key-b': 6 } }],
  tokensIn: 12, tokensCached: 4, tokensOut: 3, requests: 2, cloudCostUsd: 0.01, topKeys: [],
  models: ['qwen3.6-35b-a3b', 'gpt-oss-120b'], modelTotals: [], keys: [{ id: 'key-a', name: 'claude' }, { id: 'key-b', name: 'codex' }],
}

describe('toUsageChart', () => {
  it('maps models to css-safe keys with categorical colors', () => {
    const { data, series } = toUsageChart(report, 'model')
    expect(series).toEqual([
      { key: 's0', label: 'qwen3.6-35b-a3b', color: 'var(--cat-1)' },
      { key: 's1', label: 'gpt-oss-120b', color: 'var(--cat-2)' },
    ])
    expect(data).toEqual([{ t: 1, s0: 10, s1: 5 }])
  })
  it('labels keys by name', () => {
    const { data, series } = toUsageChart(report, 'key')
    expect(series.map((s) => s.label)).toEqual(['claude', 'codex'])
    expect(data[0]).toEqual({ t: 1, s0: 9, s1: 6 })
  })
})
