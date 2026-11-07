import { describe, expect, it } from 'vitest'
import type { BenchRun, QualityBenchResult } from '@/api/types'
import { compareQuality, formatPValue } from './compare'
import { benchSummaryText, configSummary, headline } from './summary'

const base: Omit<BenchRun, 'kind' | 'config' | 'result'> = {
  id: 'bench-1', scope: 'replica', nodeIds: ['spark-03'], nodeId: 'spark-03', deploymentId: 'dep-gptoss120', model: 'gpt-oss-120b', engine: 'vLLM', quant: 'MXFP4', contextLength: 131072,
  status: 'completed', progress: 1, stage: null, startedAt: new Date(2026, 9, 8, 15, 0, 0).getTime(), finishedAt: new Date(2026, 9, 8, 15, 0, 6).getTime(), error: null,
}

const quality = (passed: Record<'qa' | 'gsm8k', boolean[]>): QualityBenchResult => {
  const categories = (['qa', 'gsm8k'] as const).map((category) => {
    const p = passed[category]
    const correct = p.filter(Boolean).length
    return { category, items: p.length, correct, percent: (correct / p.length) * 100, meanCompletionTokens: 10, hitMaxTokens: 0, passed: p }
  })
  return { kind: 'quality', categories, overall: (categories[0].percent + categories[1].percent) / 2 }
}

describe('bench summaries', () => {
  it('decode: headline is the peak level, summary lists every level', () => {
    const run: BenchRun = {
      ...base, kind: 'decode', config: { kind: 'decode', concurrency: [1, 4], maxTokens: 500, promptType: 'code' },
      result: { kind: 'decode', levels: [
        { concurrency: 1, aggregateTokS: 58.2, perStreamTokS: 58.2, ttftP50Ms: 90, completionTokens: 480, durationMs: 8000 },
        { concurrency: 4, aggregateTokS: 171.5, perStreamTokS: 42.9, ttftP50Ms: 130, completionTokens: 1950, durationMs: 11000 },
      ] },
    }
    expect(headline(run)).toBe('peak 172 tok/s @ 4×')
    expect(configSummary(run)).toBe('1/4 streams · 500 tok · Code')
    const text = benchSummaryText(run)
    expect(text).toContain('SparkMan Decode bench — gpt-oss-120b (vLLM, MXFP4) on spark-03')
    expect(text).toContain('completed in 6.0 s')
    expect(text).toMatch(/^4\s+171\.5\s+42\.9\s+130 ms$/m)
  })

  it('quality and running runs without results', () => {
    const run: BenchRun = { ...base, kind: 'quality', config: { kind: 'quality', categories: ['qa', 'gsm8k'] }, result: quality({ qa: [true, false], gsm8k: [true, true] }) }
    expect(headline(run)).toBe('overall 75.0%')
    expect(benchSummaryText(run)).toContain('Overall (mean of categories): 75.0%')
    expect(headline({ ...run, status: 'running', result: { kind: 'quality', categories: [], overall: null } })).toBeNull()
  })
})

describe('compareQuality', () => {
  it('pairs shared categories item by item', () => {
    const a = quality({ qa: [true, true, false, false], gsm8k: [true, true, true, true] })
    const b = quality({ qa: [true, false, true, false], gsm8k: [true, true, true, false] })
    const c = compareQuality(a, b)
    expect(c).toMatchObject({ paired: 8, onlyA: 2, onlyB: 1, bothRight: 4, bothWrong: 1, withinNoise: true })
    expect(c.rows.map((r) => [r.category, r.delta])).toEqual([['qa', 0], ['gsm8k', -25]])
    expect(c.scoreA).toBeCloseTo(75)
    expect(c.scoreB).toBeCloseTo(62.5)
  })

  it('ignores categories only one run has', () => {
    const a = quality({ qa: [true], gsm8k: [true] })
    const b: QualityBenchResult = { ...quality({ qa: [false], gsm8k: [false] }) }
    b.categories = b.categories.filter((x) => x.category === 'qa')
    expect(compareQuality(a, b)).toMatchObject({ paired: 1, onlyA: 1, rows: [{ category: 'qa' }] })
  })

  it('formats p-values', () => {
    expect(formatPValue(0.0312)).toBe('p = 0.031')
    expect(formatPValue(0.00001)).toBe('p < 0.001')
  })
})
