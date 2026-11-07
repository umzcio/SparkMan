import type { QualityBenchResult, QualityCategory } from '@/api/types'
import { comparePaired, type PairedComparison } from '@/lib/stats'

export interface QualityCompareRow {
  category: QualityCategory
  a: number
  b: number
  delta: number
}

export interface QualityComparison extends PairedComparison {
  rows: QualityCompareRow[]
  /** mean of the shared categories' percentages */
  scoreA: number | null
  scoreB: number | null
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)

/** Compare two quality runs over the categories both ran, pairing items by their stable ids. */
export function compareQuality(a: QualityBenchResult, b: QualityBenchResult): QualityComparison {
  const pairs = a.categories.flatMap((ca) => {
    const cb = b.categories.find((x) => x.category === ca.category)
    return cb ? [[ca, cb] as const] : []
  })
  const outcomesA: boolean[] = []
  const outcomesB: boolean[] = []
  for (const [ca, cb] of pairs) {
    const n = Math.min(ca.passed.length, cb.passed.length)
    outcomesA.push(...ca.passed.slice(0, n))
    outcomesB.push(...cb.passed.slice(0, n))
  }
  return {
    ...comparePaired(outcomesA, outcomesB),
    rows: pairs.map(([ca, cb]) => ({ category: ca.category, a: ca.percent, b: cb.percent, delta: cb.percent - ca.percent })),
    scoreA: mean(pairs.map(([ca]) => ca.percent)),
    scoreB: mean(pairs.map(([, cb]) => cb.percent)),
  }
}

/** "p = 0.031", "p < 0.001" */
export function formatPValue(p: number): string {
  if (p < 0.001) return 'p < 0.001'
  return `p = ${p.toFixed(3)}`
}
