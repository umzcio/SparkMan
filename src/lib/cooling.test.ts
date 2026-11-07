import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, curveDuty, nodeDemand, reasonText, stepDuty, validateCurve, validatePolicy, zoneTarget, type CoolingPolicy } from './cooling'

const P: CoolingPolicy = DEFAULT_POLICY

describe('curveDuty', () => {
  it('interpolates between points and holds the ends', () => {
    expect(curveDuty(P.curve, 30)).toBe(25)
    expect(curveDuty(P.curve, 45)).toBe(25)
    expect(curveDuty(P.curve, 52.5)).toBeCloseTo(32.5)
    expect(curveDuty(P.curve, 72)).toBe(65)
    expect(curveDuty(P.curve, 77)).toBeCloseTo(82.5)
    expect(curveDuty(P.curve, 95)).toBe(100)
  })
})

describe('nodeDemand', () => {
  it('follows the curve and names the box', () => {
    expect(nodeDemand(P, 'spark-02', { gpuTempC: 72, gpuUtil: 40 })).toEqual({ duty: 65, reason: { kind: 'temp', nodeId: 'spark-02', value: 72 } })
  })
  it('lets heavy load set a floor before the heat shows', () => {
    expect(nodeDemand(P, 'spark-03', { gpuTempC: 50, gpuUtil: 92 })).toEqual({ duty: 50, reason: { kind: 'load', nodeId: 'spark-03', value: 92 } })
  })
  it('never goes under the minimum', () => {
    const p = { ...P, minDuty: 30 }
    expect(nodeDemand(p, 'a', { gpuTempC: 30, gpuUtil: 0 }).duty).toBe(30)
  })
  it('treats a silent box as hot', () => {
    expect(nodeDemand(P, 'dell-02', null)).toEqual({ duty: 100, reason: { kind: 'no-data', nodeId: 'dell-02' } })
  })
})

describe('zoneTarget', () => {
  it('takes the hungriest box in the zone', () => {
    const d = zoneTarget(P, [
      { id: 'a', thermal: { gpuTempC: 50, gpuUtil: 10 } },
      { id: 'b', thermal: { gpuTempC: 78, gpuUtil: 10 } },
    ])
    expect(d.reason).toMatchObject({ kind: 'temp', nodeId: 'b' })
  })
  it('breaks ties by temperature, silent boxes first', () => {
    const hot = { gpuTempC: 90, gpuUtil: 10 }
    expect(zoneTarget(P, [{ id: 'a', thermal: hot }, { id: 'b', thermal: null }]).reason).toMatchObject({ kind: 'no-data', nodeId: 'b' })
    expect(zoneTarget(P, [{ id: 'a', thermal: { gpuTempC: 85, gpuUtil: 0 } }, { id: 'b', thermal: hot }]).reason.nodeId).toBe('b')
  })
  it('idles an empty zone at the minimum', () => {
    expect(zoneTarget(P, [])).toEqual({ duty: 20, reason: { kind: 'idle' } })
  })
})

describe('stepDuty', () => {
  it('rises at once', () => {
    expect(stepDuty({ duty: 30, heldAt: 0, at: 0 }, 70, 1000, P)).toEqual({ duty: 70, heldAt: 1000, at: 1000 })
  })
  it('holds, then ramps down at the set rate, never below the target', () => {
    let s = stepDuty(null, 80, 0, P)
    s = stepDuty(s, 30, 20_000, P)
    expect(s.duty).toBe(80) // still holding
    s = stepDuty(s, 30, 35_000, P)
    expect(s.duty).toBeCloseTo(70) // 5 s past the 30 s hold at 2 %/s
    s = stepDuty(s, 30, 37_000, P)
    expect(s.duty).toBeCloseTo(66)
    s = stepDuty(s, 30, 200_000, P)
    expect(s.duty).toBe(30)
  })
})

describe('validation', () => {
  it('accepts the default', () => {
    expect(validatePolicy(P)).toBeNull()
  })
  it('rejects bad curves with a readable reason', () => {
    expect(validateCurve([{ tempC: 50, duty: 30 }])).toMatch(/2 to 6 points/)
    expect(validateCurve([{ tempC: 50, duty: 30 }, { tempC: 50, duty: 60 }])).toMatch(/increase/)
    expect(validateCurve([{ tempC: 50, duty: 60 }, { tempC: 70, duty: 40 }])).toMatch(/slower/)
    expect(validateCurve([{ tempC: 20, duty: 30 }, { tempC: 70, duty: 40 }])).toMatch(/30–95 °C/)
    expect(validateCurve([{ tempC: 40, duty: 30 }, { tempC: 70, duty: 140 }])).toMatch(/0–100 %/)
  })
  it('rejects bad policy numbers', () => {
    expect(validatePolicy({ ...P, minDuty: -1 })).toMatch(/Minimum/)
    expect(validatePolicy({ ...P, rampDownPerSec: 0 })).toMatch(/Ramp/)
    expect(validatePolicy({ ...P, loadFloor: { util: 120, duty: 50 } })).toMatch(/Load floor/)
  })
})

describe('reasonText', () => {
  it('reads like a sentence fragment', () => {
    expect(reasonText({ kind: 'temp', nodeId: 'spark-02', value: 78.4 })).toBe('spark-02 78 °C')
    expect(reasonText({ kind: 'load', nodeId: 'spark-03', value: 92.2 })).toBe('Load floor · spark-03 92% GPU')
    expect(reasonText({ kind: 'no-data', nodeId: 'dell-02' })).toBe('dell-02 offline — running safe')
    expect(reasonText({ kind: 'manual' })).toBe('Manual')
    expect(reasonText({ kind: 'failsafe' })).toBe('Pico failsafe')
    expect(reasonText({ kind: 'idle' })).toBe('No boxes in this zone')
  })

describe('validatePolicy on malformed input', () => {
  it('reports instead of throwing', () => {
    const bad = (p: unknown) => validatePolicy(p as CoolingPolicy)
    expect(bad({ ...P, loadFloor: null })).toMatch(/Load floor/)
    expect(bad({ ...P, curve: 'hot' })).toMatch(/2 to 6 points/)
    expect(bad({ ...P, curve: [{ tempC: 40 }, null] })).toMatch(/0–100 %|30–95 °C/)
    expect(bad(null)).toMatch(/policy/i)
  })
})
})
