import { describe, expect, it } from 'vitest'
import { comparePaired, mcnemarExact } from './stats'

describe('mcnemarExact', () => {
  it('is 1 with no discordant pairs or a perfect split', () => {
    expect(mcnemarExact(0, 0)).toBe(1)
    expect(mcnemarExact(5, 5)).toBe(1)
  })

  it('matches hand-computed binomial tails', () => {
    // n = 5, k = 0: 2 · (½)^5
    expect(mcnemarExact(5, 0)).toBeCloseTo(0.0625, 10)
    // n = 10, k = 1: 2 · (1 + 10) / 1024
    expect(mcnemarExact(1, 9)).toBeCloseTo(22 / 1024, 10)
    // n = 12, k = 2: 2 · (1 + 12 + 66) / 4096
    expect(mcnemarExact(10, 2)).toBeCloseTo(158 / 4096, 10)
  })

  it('is symmetric and capped at 1', () => {
    expect(mcnemarExact(3, 7)).toBeCloseTo(mcnemarExact(7, 3), 12)
    expect(mcnemarExact(1, 2)).toBe(1)
  })

  it('stays finite for suite-sized counts', () => {
    const p = mcnemarExact(40, 80)
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(0.001)
    expect(mcnemarExact(400, 410)).toBeGreaterThan(0.7)
  })

  it('rejects invalid counts', () => {
    expect(() => mcnemarExact(-1, 2)).toThrow(RangeError)
    expect(() => mcnemarExact(1.5, 2)).toThrow(RangeError)
  })
})

describe('comparePaired', () => {
  it('counts concordant and discordant items', () => {
    const a = [true, true, false, false, true]
    const b = [true, false, true, false, false]
    expect(comparePaired(a, b)).toMatchObject({ paired: 5, bothRight: 1, bothWrong: 1, onlyA: 2, onlyB: 1, withinNoise: true })
  })

  it('flags a clear difference as significant', () => {
    const a = Array.from({ length: 100 }, () => true)
    const b = Array.from({ length: 100 }, (_, i) => i >= 20)
    const r = comparePaired(a, b)
    expect(r.onlyA).toBe(20)
    expect(r.onlyB).toBe(0)
    expect(r.pValue).toBeLessThan(0.05)
    expect(r.withinNoise).toBe(false)
  })

  it('only pairs the overlapping items', () => {
    expect(comparePaired([true, true, true], [false]).paired).toBe(1)
  })
})
