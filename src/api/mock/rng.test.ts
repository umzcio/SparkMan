import { describe, expect, it } from 'vitest'
import { clamp, hash, mulberry32, noise, pick, pickWeighted, smoothNoise } from './rng'

describe('rng', () => {
  it('hash is stable and input-sensitive', () => {
    expect(hash('spark-01', 3)).toBe(hash('spark-01', 3))
    expect(hash('spark-01', 3)).not.toBe(hash('spark-01', 4))
  })
  it('noise is deterministic and within [0,1)', () => {
    for (let i = 0; i < 1000; i++) {
      const v = noise(1729, 'x', i)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(noise(1729, 'x', i)).toBe(v)
    }
  })
  it('noise is roughly uniform', () => {
    let sum = 0
    for (let i = 0; i < 5000; i++) sum += noise('u', i)
    expect(sum / 5000).toBeGreaterThan(0.45)
    expect(sum / 5000).toBeLessThan(0.55)
  })
  it('mulberry32 repeats for the same seed', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
  it('smoothNoise is continuous', () => {
    const p = 60_000
    const a = smoothNoise(p, 1_000_000, 's')
    const b = smoothNoise(p, 1_000_100, 's')
    expect(Math.abs(a - b)).toBeLessThan(0.02)
  })
  it('pick, pickWeighted, clamp', () => {
    expect(pick(['a', 'b', 'c'], 0.999)).toBe('c')
    expect(pickWeighted([{ value: 'x', weight: 1 }, { value: 'y', weight: 3 }], 0.2)).toBe('x')
    expect(pickWeighted([{ value: 'x', weight: 1 }, { value: 'y', weight: 3 }], 0.3)).toBe('y')
    expect(clamp(120, 0, 100)).toBe(100)
  })
})
