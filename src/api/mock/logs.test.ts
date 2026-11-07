import { describe, expect, it } from 'vitest'
import { parseLogQuery } from '@/lib/log-query'
import { DEPLOYMENT_SPECS, KEY_SPECS, NODE_SPECS } from './fixtures'
import { SLOT_MS, linesForSlot, logHistogram, queryLogs, type LogWorld } from './logs'

const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime()
const base: LogWorld = {
  seed: 1729,
  nodes: NODE_SPECS,
  deployments: DEPLOYMENT_SPECS,
  keys: KEY_SPECS.filter((k) => k.revokedAgoMs === null).map(({ id, name, share }) => ({ id, name, share })),
  windows: [],
  outages: [],
}
const slotOf = (t: number) => Math.floor(t / SLOT_MS)

describe('log generator', () => {
  it('is deterministic, sorted newest-first, ids unique, timestamps inside the slot', () => {
    const s = slotOf(NOW)
    const a = linesForSlot(base, s)
    expect(a).toEqual(linesForSlot(base, s))
    expect(a.length).toBeGreaterThan(0)
    for (let i = 1; i < a.length; i++) expect(a[i - 1].ts).toBeGreaterThanOrEqual(a[i].ts)
    expect(new Set(a.map((l) => l.id)).size).toBe(a.length)
    for (const l of a) {
      expect(l.ts).toBeGreaterThanOrEqual(s * SLOT_MS)
      expect(l.ts).toBeLessThan((s + 1) * SLOT_MS)
      expect(l.pattern).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('xid windows emit NVRM Xid kernel errors for the window node', () => {
    const w: LogWorld = { ...base, windows: [{ from: NOW - 60_000, to: NOW + 60_000, nodeId: 'spark-05', kind: 'xid', label: 'Xid 31 on spark-05' }] }
    const lines = Array.from({ length: 6 }, (_, i) => linesForSlot(w, slotOf(NOW) - i)).flat()
    const xid = lines.filter((l) => l.message.includes('NVRM: Xid'))
    expect(xid.length).toBeGreaterThan(0)
    expect(xid.every((l) => l.host === 'spark-05' && l.level === 'error' && l.source === 'kernel')).toBe(true)
  })

  it('skips lines from hosts that are offline', () => {
    const w: LogWorld = { ...base, outages: [{ nodeId: 'spark-03', from: NOW - 3_600_000, to: null }] }
    const { lines } = queryLogs(w, { from: NOW - 3_600_000, to: NOW, query: parseLogQuery(''), limit: 2000 })
    expect(lines.some((l) => l.host === 'spark-03')).toBe(false)
  })

  it('queryLogs respects range, limit, filters and order', () => {
    const q = parseLogQuery('level:info source:gateway')
    const { lines } = queryLogs(base, { from: NOW - 3_600_000, to: NOW, query: q, limit: 50 })
    expect(lines).toHaveLength(50)
    expect(lines.every((l) => l.level === 'info' && l.source === 'gateway')).toBe(true)
    expect(lines.every((l) => l.ts <= NOW && l.ts >= NOW - 3_600_000)).toBe(true)
    for (let i = 1; i < lines.length; i++) expect(lines[i - 1].ts).toBeGreaterThanOrEqual(lines[i].ts)
  })

  it('queryLogs stops scanning and flags truncation for impossible queries', () => {
    const r = queryLogs(base, { from: NOW - 7 * 86_400_000, to: NOW, query: parseLogQuery('zzzz-never'), limit: 10 })
    expect(r.lines).toHaveLength(0)
    expect(r.truncated).toBe(true)
  })

  it('histogram over 15m equals an exhaustive count', () => {
    const from = NOW - 15 * 60_000
    const q = parseLogQuery('')
    const hist = logHistogram(base, { from, to: NOW, query: q, buckets: 60 })
    expect(hist).toHaveLength(60)
    const total = hist.reduce((s, b) => s + b.error + b.warn + b.info + b.debug, 0)
    const exhaustive = queryLogs(base, { from, to: NOW, query: q, limit: 100_000 }).lines.length
    expect(total).toBe(exhaustive)
  })
})
