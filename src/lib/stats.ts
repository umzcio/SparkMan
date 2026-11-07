/**
 * Exact two-sided McNemar test for paired binary outcomes.
 *
 * `b` = items only run A got right, `c` = items only run B got right (concordant pairs carry no information).
 * Under H0 the discordant pairs split as Binomial(b + c, ½); the two-sided p-value is twice the smaller tail, capped at 1.
 */
export function mcnemarExact(b: number, c: number): number {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) throw new RangeError('counts must be non-negative integers')
  const n = b + c
  if (n === 0) return 1
  const k = Math.min(b, c)
  // log C(n, i) built incrementally keeps large n (hundreds of items) free of overflow
  const logHalfN = n * Math.log(0.5)
  let logC = 0
  let tail = 0
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i)
    tail += Math.exp(logC + logHalfN)
  }
  return Math.min(1, 2 * tail)
}

export interface PairedComparison {
  /** items both runs scored */
  paired: number
  bothRight: number
  bothWrong: number
  onlyA: number
  onlyB: number
  pValue: number
  /** p ≥ alpha: the difference could be chance */
  withinNoise: boolean
}

/** Pair two outcome vectors item by item (same index = same item) and run the exact McNemar test. */
export function comparePaired(a: readonly boolean[], b: readonly boolean[], alpha = 0.05): PairedComparison {
  const paired = Math.min(a.length, b.length)
  let bothRight = 0
  let bothWrong = 0
  let onlyA = 0
  let onlyB = 0
  for (let i = 0; i < paired; i++) {
    if (a[i] && b[i]) bothRight++
    else if (a[i]) onlyA++
    else if (b[i]) onlyB++
    else bothWrong++
  }
  const pValue = mcnemarExact(onlyA, onlyB)
  return { paired, bothRight, bothWrong, onlyA, onlyB, pValue, withinNoise: pValue >= alpha }
}
