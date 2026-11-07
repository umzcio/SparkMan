import { describe, expect, it } from 'vitest'
import { fromPx, toPx } from './curve-geometry'

const box = { w: 600, h: 300, pad: 30 }

describe('curve geometry', () => {
  it('round-trips points through pixels', () => {
    for (const p of [{ tempC: 30, duty: 0 }, { tempC: 95, duty: 100 }, { tempC: 60, duty: 40 }]) {
      const { x, y } = toPx(p, box)
      expect(fromPx(x, y, box)).toEqual(p)
    }
  })
  it('clamps to the chart and rounds', () => {
    expect(fromPx(-50, 999, box)).toEqual({ tempC: 30, duty: 0 })
    expect(fromPx(10_000, -10, box)).toEqual({ tempC: 95, duty: 100 })
  })
})
