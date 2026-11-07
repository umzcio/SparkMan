// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { LogLine, NodeLiveStats } from '../../src/api/types.ts'
import { AlertEngine, type NodeState } from './alerts.ts'
import { FleetDb } from './db.ts'
import type { RawSample } from './sample.ts'

const live = (over: Partial<NodeLiveStats> = {}): NodeLiveStats => ({
  gpuUtil: 10, memUsedGB: 10, gpuPowerW: 20, gpuTempC: 50, acpiTempC: 45, cpuUtil: 5, diskUsedPct: 40, throttling: false, ...over,
})
const sample = (links: Record<string, string> = {}): RawSample => ({
  t: 0, cpu: [], mem: { MemTotal: 128_000_000, MemAvailable: 100_000_000 }, gpu: null, acpi: [], hwmon: {}, net: {}, disk: {}, fs: [1, 0], links, up: 1,
})

function setup() {
  let t = 1_000_000_000
  let changes = 0
  const engine = new AlertEngine(new FleetDb(':memory:'), () => changes++, () => t)
  return { engine, advance: (s: number) => (t += s * 1000), now: () => t, changes: () => changes }
}

describe('AlertEngine', () => {
  it('opens after the hold time and resolves when the condition clears', () => {
    const { engine, advance } = setup()
    const hot: NodeState = { id: 'spark-01', status: 'online', live: live({ gpuTempC: 91 }), sample: sample() }
    engine.evaluate([hot])
    advance(60)
    engine.evaluate([hot])
    expect(engine.activeCount()).toBe(0)
    advance(61)
    engine.evaluate([hot])
    expect(engine.list()[0]).toMatchObject({ ruleId: 'rule-gpu-temp', status: 'ongoing', nodeId: 'spark-01', title: 'spark-01 GPU running hot' })
    engine.evaluate([{ ...hot, live: live() }])
    expect(engine.activeCount()).toBe(0)
    expect(engine.list()[0].timeline.map((e) => e.text)).toEqual(['GPU 91 °C', 'Condition cleared'])
  })

  it('treats offline for a minute as critical, and disabling a rule closes its incidents', () => {
    const { engine, advance } = setup()
    const down: NodeState = { id: 'spark-02', status: 'offline', live: null, sample: null }
    engine.evaluate([down])
    advance(61)
    engine.evaluate([down])
    expect(engine.list()[0]).toMatchObject({ severity: 'critical', status: 'ongoing' })
    engine.setEnabled('rule-offline', false)
    expect(engine.activeCount()).toBe(0)
    expect(engine.rules().find((r) => r.id === 'rule-offline')?.enabled).toBe(false)
    advance(120)
    engine.evaluate([down])
    expect(engine.activeCount()).toBe(0)
  })

  it('mutes a node in maintenance: closes its incidents and opens no new ones', () => {
    const { engine, advance } = setup()
    const muted = new Set<string>()
    engine.muted = (id) => muted.has(id)
    const down: NodeState = { id: 'spark-03', status: 'offline', live: null, sample: null }
    engine.evaluate([down])
    advance(61)
    engine.evaluate([down])
    expect(engine.activeCount()).toBe(1)
    muted.add('spark-03')
    engine.evaluate([down])
    expect(engine.activeCount()).toBe(0)
    expect(engine.list()[0].timeline.at(-1)?.text).toBe('Node in maintenance')
    advance(300)
    engine.evaluate([down])
    expect(engine.activeCount()).toBe(0)
    // leaving maintenance restarts the hold time rather than alerting at once
    muted.delete('spark-03')
    engine.evaluate([down])
    expect(engine.activeCount()).toBe(0)
    advance(61)
    engine.evaluate([down])
    expect(engine.activeCount()).toBe(1)
  })

  it('opens an Xid incident from a fresh kernel line, ignores backfill, and clears after 30 quiet minutes', () => {
    const { engine, advance, now } = setup()
    const xid = (ts: number): LogLine => ({ id: '', ts, level: 'error', source: 'kernel', host: 'spark-03', service: 'kernel', message: 'NVRM: Xid (PCI:0000:01:00): 79, GPU has fallen off the bus', pattern: 'x', attributes: { xid: '79' } })
    engine.onLog(xid(now() - 3_600_000))
    expect(engine.activeCount()).toBe(0)
    engine.onLog(xid(now()))
    expect(engine.list()[0]).toMatchObject({ ruleId: 'rule-xid', title: 'spark-03 GPU Xid 79', severity: 'critical' })
    advance(31 * 60)
    engine.evaluate([])
    expect(engine.activeCount()).toBe(0)
  })

  it('flags a ConnectX-7 link that was up and went down', () => {
    const { engine, advance } = setup()
    const n = (s: string): NodeState => ({ id: 'spark-04', status: 'online', live: live(), sample: sample({ enp1s0f0np0: s, enP2p1s0f1np1: 'down' }) })
    engine.evaluate([n('up')])
    engine.evaluate([n('down')])
    advance(31)
    engine.evaluate([n('down')])
    expect(engine.list()[0]).toMatchObject({ ruleId: 'rule-cx7', timeline: [{ text: 'enp1s0f0np0 down' }] })
  })

  it('lets an operator resolve an incident', () => {
    const { engine, advance } = setup()
    const full: NodeState = { id: 'spark-05', status: 'online', live: live({ diskUsedPct: 95 }), sample: sample() }
    engine.evaluate([full])
    advance(61)
    engine.evaluate([full])
    engine.resolveById(engine.list()[0].id)
    expect(engine.list()[0].timeline.at(-1)?.text).toBe('Resolved by operator')
    expect(() => engine.resolveById('nope')).toThrow()
  })
})
