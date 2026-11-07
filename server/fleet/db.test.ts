// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { MetricPoint } from '../../src/api/types.ts'
import { FleetDb, METRIC_KEYS, RANGE_MS, SERIES_POINTS } from './db.ts'

const point = (t: number, gpuUtil: number): MetricPoint => {
  const p = { t } as MetricPoint
  for (const k of METRIC_KEYS) p[k] = null
  p.gpuUtil = gpuUtil
  return p
}

describe('FleetDb', () => {
  it('buckets raw samples into a fixed-length series with gaps as null', () => {
    const db = new FleetDb(':memory:')
    const now = 1_800_000_000_000
    const step = RANGE_MS['15m'] / SERIES_POINTS
    const end = Math.floor(now / step) * step
    db.addSample('spark-01', point(end - 1000, 40))
    db.addSample('spark-01', point(end - 2000, 60))
    db.addSample('spark-02', point(end - 1000, 99))
    const s = db.series('spark-01', '15m', now)
    expect(s).toHaveLength(SERIES_POINTS)
    expect(s[SERIES_POINTS - 2].gpuUtil).toBe(50)
    expect(s[0].gpuUtil).toBeNull()
    expect(s[0].memUsedGB).toBeNull()
  })

  it('serves 7d from minute rollups', () => {
    const db = new FleetDb(':memory:')
    const now = 1_800_000_000_000
    db.addSample('spark-01', point(now - 3 * 60_000 + 5_000, 10))
    db.addSample('spark-01', point(now - 3 * 60_000 + 15_000, 30))
    db.rollup(now)
    const s = db.series('spark-01', '7d', now)
    expect(s.some((p) => p.gpuUtil === 20)).toBe(true)
  })

  it('keeps key/value state and activity newest first', () => {
    const db = new FleetDb(':memory:')
    db.set('drained:spark-01', '1')
    expect(db.get('drained:spark-01')).toBe('1')
    db.set('drained:spark-01', null)
    expect(db.get('drained:spark-01')).toBeNull()
    db.addActivity('reboot', 'first', 'spark-01', 1)
    db.addActivity('drain', 'second', null, 2)
    expect(db.activity().map((a) => a.text)).toEqual(['second', 'first'])
  })
})
